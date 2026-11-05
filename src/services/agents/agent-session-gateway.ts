import { compactId, versionHash } from "../../lib/hash.js";
import { AppError } from "../../lib/errors.js";
import { AgentHistoryStore } from "./agent-history-store.js";
import { redactAgentSecrets } from "../../agent/redact-secrets.js";
import { RESEARCH_INTERFACE } from "../../domain/research/research-interface.js";
import { verifyResearchMcp } from "../../mcp/research-probe.js";
import { appendConversationEvent, reasoningStreamKey, contentBlockId, actorKey, isRemovedContent } from "../../domain/agents/agent-conversation.js";
import { restoreConversationEvents } from "./agent-conversation-history.js";
import { codexReasoningParts } from "../../adapters/agents/codex/codex-reasoning.js";
import { appendTraceEvent, compactTraceEvents, traceFromConversation } from "../../domain/agents/agent-trace.js";
import { approvalDecision, approvalPermission } from "../../domain/agents/agent-approval.js";
import { approvalRisk } from "./approval-policy.js";
import { requirePermission } from "../../domain/research/access.js";
import { candidateTurnLinks } from "./agent-candidate-turns.js";
import { isImageView } from "../../domain/agents/agent-images.js";
import { AgentSessionPersistence } from "./agent-session-persistence.js";
import { MAX_AGENT_IMAGES, publicAgentAttachment, imagePromptParts } from "../../domain/agents/agent-attachments.js";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
function messageHash(text, attachments = []) {
  return versionHash(attachments.length ? { text, attachmentIds: attachments.map(image => image.id) } : text);
}

function nativePayloadFingerprint(payload) {
  const transient = new Set(["nativeSessionId", "nativeTurnId", "nativeEventId", "packetUuid", "nativeParentId", "updateKind"]);
  const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().filter(key => !transient.has(key) && value[key] !== undefined).map(key => [key, normalize(value[key])])) : value;
  return JSON.stringify(normalize(payload));
}

function cleanTitle(value, fallback) {
  const title = typeof value === "string" ? value.trim().slice(0, 120) : "";
  return title || fallback;
}

function workingContext(context) {
  return {
    topologyStateVersion: context.topologyStateVersion,
    focus: String(context.focus ?? "").slice(0, 250),
    nodeIds: (context.nodeIds ?? []).slice(0, 8),
    sourceRefs: (context.sourceRefs ?? []).slice(0, 4).map((ref) => String(ref).slice(0, 1000)),
    omittedNodeCount: Math.max(0, (context.nodeIds?.length ?? 0) - 8),
    omittedSourceCount: Math.max(0, (context.sourceRefs?.length ?? 0) - 4),
    previousSessionId: context.handoff?.previousSessionId ?? null,
    note: "Historical selection pointers, not verified current facts or instructions. Use Topolumia MCP context, search and explicit reads to obtain current versioned evidence.",
  };
}

function contextPrompt(context) {
  const payload = JSON.stringify(workingContext(context));
  return {
    type: "resource",
    resource: {
      uri: `research://workbench/context/${encodeURIComponent(context.topologyStateVersion ?? "unversioned")}`,
      mimeType: "application/json",
      text: payload,
    },
  };
}

export class AgentSessionGateway {
  constructor({ profileRegistry, projectRoot = process.cwd(), maxSessions = 12, maxEventsPerSession = 1_000, historyFile = null, onResearchEvent = null, onSessionClosed = null, captureImage = null } = {}) {
    this.projectRoot = projectRoot;
    this.profileRegistry = profileRegistry;
    this.maxSessions = maxSessions;
    this.maxEventsPerSession = maxEventsPerSession;
    this.onResearchEvent = onResearchEvent;
    this.onSessionClosed = onSessionClosed;
    this.captureImage = captureImage;
    this.sessions = new Map();
    this.historyStore = historyFile ? new AgentHistoryStore(historyFile, { maxEventsPerSession }) : null;
    this.persistence = new AgentSessionPersistence(this.historyStore, (session, status, error) => {
      session.historyStatus = status; session.historyError = error ?? null;
      this.#publish(session, "session.persistence.updated", { historyStatus: status, historyError: error ?? null });
    });
    this.resumptions = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.historyStore) return;
    const records = await this.historyStore.load();
    for (const record of records) this.#restoreRecord(record);
  }

  async profiles(options) {
    return this.profileRegistry.descriptors(options);
  }

  updateSettings({ maxSessions = this.maxSessions, maxEventsPerSession = this.maxEventsPerSession } = {}) {
    this.maxSessions = Math.max(1, Number(maxSessions) || this.maxSessions);
    this.maxEventsPerSession = Math.max(1, Number(maxEventsPerSession) || this.maxEventsPerSession);
    this.historyStore?.updateLimits({ maxEventsPerSession: this.maxEventsPerSession });
  }

  #checkRuntimeCapacity() {
    if (this.shuttingDown) throw new AppError("AGENT_GATEWAY_CLOSED", "Agent 服务正在关闭。", { status: 503 });
    const activeCount = [...this.sessions.values()].filter((session) => ["starting", "ready", "running", "awaiting_permission", "closing"].includes(session.status)).length;
    if (activeCount >= this.maxSessions) {
      throw new AppError("AGENT_SESSION_LIMIT", "当前进程中的 Agent 会话数量已达到上限。", { status: 409 });
    }
  }

  async create(input = {}) {
    this.#checkRuntimeCapacity();
    const id = compactId("agent_session");
    const now = new Date().toISOString();
    const session = {
      schemaVersion: "agent-session.v1",
      id,
      title: cleanTitle(input.title, "Untitled research session"),
      pinned: false, archived: false, lastReadCursor: 0, latestMessageCursor: 0, permissionGrants: [],
      profileId: input.profileId,
      researchInterface: RESEARCH_INTERFACE,
      researchSessionId: input.researchSessionId ?? id,
      runtimeInstanceId: id,
      ownerUserId: input.ownerUserId ?? null,
      model: input.model ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      parentSessionId: input.parentSessionId ?? null,
      resumedFrom: input.resumedFrom ?? null,
      provider: null,
      status: "starting",
      nativeSessionId: null,
      sync: { source: "pending", status: "sync_pending", lastSyncedAt: null, lastEventAt: null, error: null },
      nativeSnapshot: null,
      capabilities: {},
      agentInfo: null,
      authMethods: [],
      context: clone(input.context ?? {}),
      locale: input.locale === "en" ? "en" : "zh",
      createdAt: now,
      updatedAt: now,
      turns: [],
      queuedMessages: [],
      queuePaused: false,
      events: [],
      conversationEvents: [],
      streamEvents: [],
      traceDroppedEvents: 0,
      traceFormat: "final.v1",
      usage: null,
      cursor: 0,
      activeTurnId: null,
      pendingApprovals: new Map(),
      subscribers: new Set(),
      adapter: null,
      historyStatus: "live",
    };
    this.sessions.set(id, session);
    this.#publish(session, "session.created", { profileId: session.profileId, title: session.title });
    return this.#startRuntime(session, input);
  }

  async #startRuntime(session, input) {
    const { id, runtimeInstanceId } = session;
    try {
      const researchMcp = input.mcpBindingFactory ? await input.mcpBindingFactory({ runtimeInstanceId, researchSessionId: session.researchSessionId }) : null;
      if (researchMcp) await verifyResearchMcp(researchMcp);
      const adapter = await this.profileRegistry.createAdapter(session.profileId, {
        onEvent: (event) => { if (session.runtimeInstanceId === runtimeInstanceId) this.#onDriverEvent(id, event); },
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      });
      session.adapter = adapter;
      session.provider = adapter.profile.provider;
      const started = await adapter.start({
        cwd: input.cwd,
        context: session.context,
        developerInstructions: [input.developerInstructions, researchMcp?.instructions].filter(Boolean).join("\n\n") || null,
        resumeThreadId: input.resumeNativeThreadId ?? null,
        researchMcp,
      });
      session.nativeSessionId = started.nativeSessionId;
      session.model = started.model ?? session.model ?? adapter.profile.model ?? null;
      session.capabilities = clone({...started.capabilities, ...(researchMcp?.skillDelivery ? {researchSkill:researchMcp.skillDelivery} : {})});
      session.agentInfo = clone(started.agentInfo ?? null);
      session.authMethods = clone(started.authMethods ?? []);
      session.status = "ready";
      session.updatedAt = new Date().toISOString();
      this.#publish(session, "session.status", { status: "ready", runtimeInstanceId, nativeSessionId: session.nativeSessionId, capabilities: session.capabilities });
      await this.#persistNow(session);
      return this.snapshot(id);
    } catch (error) {
      session.status = "failed";
      session.updatedAt = new Date().toISOString();
      this.#publish(session, "session.status", { status: "failed", error: { code: error.code ?? "AGENT_SESSION_START_FAILED", message: error.message } });
      await session.adapter?.close().catch(() => {});
      this.onSessionClosed?.(runtimeInstanceId);
      await this.#persistNow(session);
      throw error;
    }
  }

  list({ summary = false } = {}) {
    for (const record of this.historyStore?.list?.() ?? []) this.#restoreRecord(record);
    return [...this.sessions.values()]
      .sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)))
      .map((session) => this.#publicSession(session, false, summary));
  }

  async updateSession(sessionId, input = {}) {
    const session = this.#require(sessionId);
    if (!input || typeof input !== "object" || Array.isArray(input) || !Object.keys(input).length
      || Object.keys(input).some(key => !["title", "pinned", "archived", "readCursor"].includes(key))
      || input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 120)
      || ["pinned", "archived"].some(key => input[key] !== undefined && typeof input[key] !== "boolean")
      || input.readCursor !== undefined && (!Number.isSafeInteger(input.readCursor) || input.readCursor < 0 || input.readCursor > session.cursor)) {
      throw new AppError("AGENT_SESSION_METADATA_INVALID", "会话设置无效。", { status: 422 });
    }
    if (input.archived === true && (session.activeTurnId || session.closing)) throw new AppError("AGENT_SESSION_BUSY", "请先停止当前回合，再归档会话。", { status: 409 });
    if (input.archived === true && session.adapter && !["closed", "detached", "failed"].includes(session.status)) await this.close(sessionId);
    if (input.title !== undefined) session.title = input.title.trim();
    if (input.pinned !== undefined) session.pinned = input.pinned;
    if (input.archived !== undefined) session.archived = input.archived;
    if (input.readCursor !== undefined) session.lastReadCursor = Math.max(session.lastReadCursor ?? 0, input.readCursor);
    if (Object.keys(input).some(key => key !== "readCursor")) this.#publish(session, "session.metadata.updated", { title: session.title, pinned: session.pinned, archived: session.archived });
    await this.#persistNow(session);
    return this.snapshot(sessionId);
  }

  editQueuedMessage(sessionId, messageId, input = {}) {
    const session = this.#require(sessionId);
    const message = session.queuedMessages.find(item => item.id === messageId);
    if (!message) throw new AppError("AGENT_QUEUE_MESSAGE_NOT_FOUND", "该消息已经开始执行或不在队列中。", { status: 404 });
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError("AGENT_TURN_INPUT_INVALID", "消息内容无效。", { status: 422 });
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if ((!text && !message.attachments?.length) || text.length > 10_000 || Object.keys(input).some(key => key !== "text")) throw new AppError("AGENT_TURN_INPUT_INVALID", "请输入文字或添加图片。", { status: 422 });
    message.text = text; message.editedAt = new Date().toISOString();
    this.#queueChanged(session);
    return clone(message);
  }

  async resetPermissions(sessionId, input) {
    const session = this.#require(sessionId);
    if (session.activeTurnId || session.closing) throw new AppError("AGENT_SESSION_BUSY", "请先停止当前回合，再重置会话授权。", { status: 409 });
    await this.close(sessionId);
    return this.resume(sessionId, input);
  }

  snapshot(sessionId) {
    if (!this.sessions.has(sessionId)) this.#restoreRecord(this.historyStore?.get?.(sessionId));
    const session = this.#require(sessionId);
    return this.#publicSession(session, true);
  }
  researchSnapshot(sessionId) {
    const session = this.#require(sessionId);
    return { id: session.id, title: session.title, researchSessionId: session.researchSessionId, context: clone(session.context ?? {}),
      candidateTurns: clone(session.candidateTurns ?? {}), turns: session.turns.map(({ id, startedAt, completedAt }) => ({ id, startedAt, completedAt })) };
  }
  async persist(sessionId) { const session = this.#require(sessionId); await this.#persistNow(session); return this.snapshot(sessionId); }

  researchChanged(candidate) {
    for (const session of this.sessions.values()) if (session.researchSessionId === candidate.provenance?.sessionId) {
      this.#publish(session, "session.research.updated", { candidateId: candidate.id, revision: candidate.revision, status: candidate.status });
    }
  }

  searchMessages(query, { includeArchived = false } = {}) {
    if (typeof query !== "string" || !query.trim() || query.length > 200) throw new AppError("AGENT_SEARCH_INVALID", "请输入 1 到 200 个字符的搜索内容。", { status: 422 });
    const needle = query.trim().toLocaleLowerCase(), matches = [];
    for (const session of [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      if (session.archived && !includeArchived) continue;
      for (const event of [...session.conversationEvents].reverse()) {
        if (event.type !== "user.message" && event.type !== "assistant.message.completed") continue;
        const value = event.payload.text ?? "", index = value.toLocaleLowerCase().indexOf(needle);
        if (index < 0) continue;
        matches.push({ sessionId: session.id, title: session.title, eventId: event.id, role: event.type === "user.message" ? "user" : "assistant", archived: Boolean(session.archived),
          snippet: value.slice(Math.max(0, index - 45), index + needle.length + 110) });
        if (matches.length === 30) return { matches, limited: true };
      }
    }
    return { matches, limited: false };
  }

  #restoreRecord(record) {
    if (record?.researchInterface !== RESEARCH_INTERFACE) return null;
    if (!record?.id || this.sessions.has(record.id)) return this.sessions.get(record?.id) ?? null;
    const conversationEvents = restoreConversationEvents(record);
    const trace = record.traceFormat === "final.v1" ? compactTraceEvents(record.events ?? []) : traceFromConversation(conversationEvents, record.events ?? []);
    const events = trace.slice(-this.maxEventsPerSession);
    const restoredSync = clone(record.sync ?? { source: "local-snapshot", status: "legacy_local_snapshot", lastSyncedAt: null, lastEventAt: null, error: null });
    if (restoredSync?.status === "live") restoredSync.status = "stale";
    const session = {
      ...clone(record),
      candidateTurns: record.candidateTurns ?? Object.fromEntries(candidateTurnLinks(record)),
      sync: restoredSync,
      status: record.status === "closed" ? "closed" : "detached",
      historyStatus: "persisted",
      runtimeStatus: record.status,
      events,
      conversationEvents,
      streamEvents: [],
      traceDroppedEvents: (record.traceDroppedEvents ?? 0) + Math.max(0, trace.length - events.length),
      traceFormat: "final.v1",
      cursor: Math.max(record.lastCursor ?? 0, ...events.map((event) => Number(event.cursor) || 0)),
      lastCursor: Math.max(record.lastCursor ?? 0, ...events.map((event) => Number(event.cursor) || 0)),
      activeTurnId: null,
      pendingApprovals: new Map(),
      permissionGrants: [],
      latestMessageCursor: record.latestMessageCursor ?? Math.max(0, ...conversationEvents.filter(event => event.type === "user.message" || event.type.startsWith("assistant.message.")).map(event => event.updatedCursor ?? event.cursor)),
      subscribers: new Set(),
      adapter: null,
    };
    session.queuedMessages = clone(record.queuedMessages ?? []);
    session.queuePaused = session.queuedMessages.length > 0;
    for (const approval of record.pendingApprovals ?? []) this.#publish(session, "approval.resolved", {
      requestId: approval.requestId, decision: "expired", status: "expired", sessionStatus: session.status,
    }, approval.turnId);
    for (const turn of session.turns ?? []) {
      if (["running", "awaiting_permission", "cancelling"].includes(turn.status)) {
        turn.status = "failed";
        turn.stopReason = "server_restart";
        turn.completedAt ??= session.updatedAt;
        this.#publish(session, "turn.failed", { sessionStatus: "detached", error: { code: "AGENT_SERVER_RESTART", message: "服务重启中断了上一轮会话。" } }, turn.id);
      }
    }
    this.sessions.set(session.id, session);
    return session;
  }

  startTurn(sessionId, input = {}) {
    const session = this.#require(sessionId);
    const attachments = input.attachments ?? [];
    if (!Array.isArray(attachments) || attachments.length > MAX_AGENT_IMAGES || attachments.some(image => !image.id || !image.path || !image.mediaType))
      throw new AppError("AGENT_ATTACHMENTS_INVALID", "图片附件信息无效。", { status: 422 });
    if (session.archived) throw new AppError("AGENT_SESSION_ARCHIVED", "请先恢复归档的会话。", { status: 409 });
    if (input.clientMessageId !== undefined) {
      if (typeof input.clientMessageId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.clientMessageId)) throw new AppError("AGENT_MESSAGE_ID_INVALID", "消息标识无效。", { status: 422 });
      const previous = [...session.turns, ...session.queuedMessages].find(item => item.clientMessageId === input.clientMessageId);
      if (previous) {
        if ((previous.submissionHash ?? versionHash(previous.text ?? previous.input?.[0]?.text)) !== messageHash(String(input.text ?? "").trim(), attachments)) throw new AppError("AGENT_MESSAGE_ID_CONFLICT", "消息标识已用于其他内容。", { status: 409 });
        return { ...clone(previous), duplicate: true };
      }
    }
    const busy = ["running", "awaiting_permission"].includes(session.status);
    if (this.shuttingDown || session.closing || !["ready", "running", "awaiting_permission"].includes(session.status)) {
      throw new AppError("AGENT_SESSION_NOT_READY", "当前 Agent 会话不能接收消息。", { status: 409, detail: { status: session.status } });
    }
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if ((!text && !attachments.length) || text.length > 10_000) throw new AppError("AGENT_TURN_INPUT_INVALID", "请输入文字或添加图片，文字最多 10000 个字符。", { status: 422 });
    const message = { text, ...(attachments.length ? { attachments: clone(attachments) } : {}), clientMessageId: input.clientMessageId, ...(input.clientMessageId ? { submissionHash: messageHash(text, attachments) } : {}),
      model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : session.model ?? null,
      reasoningEffort: typeof input.reasoningEffort === "string" ? input.reasoningEffort.trim() || null : session.reasoningEffort ?? null };
    if (busy || session.queuedMessages.length) {
      if (session.queuedMessages.length >= 50) throw new AppError("AGENT_QUEUE_FULL", "待发送消息已达到 50 条，请先处理或移除部分消息。", { status: 409 });
      const queued = { ...message, id: compactId("queued_message"), createdAt: new Date().toISOString() };
      session.queuedMessages.push(queued);
      if (!busy) session.queuePaused = false;
      this.#queueChanged(session);
      this.#drainQueue(session);
      return { ...clone(queued), sessionId, status: "queued" };
    }
    session.queuePaused = false;
    return this.#beginTurn(session, message);
  }

  removeQueuedMessage(sessionId, messageId) {
    const session = this.#require(sessionId);
    const index = session.queuedMessages.findIndex(message => message.id === messageId);
    if (index < 0) throw new AppError("AGENT_QUEUED_MESSAGE_NOT_FOUND", "待发送消息已经开始执行或已被移除。", { status: 404 });
    session.queuedMessages.splice(index, 1);
    this.#queueChanged(session);
    return this.snapshot(sessionId);
  }

  resumeQueue(sessionId) {
    const session = this.#require(sessionId);
    if (this.shuttingDown || session.closing || session.status !== "ready") throw new AppError("AGENT_SESSION_NOT_READY", "请先恢复会话，再继续发送队列。", { status: 409 });
    session.queuePaused = false;
    this.#queueChanged(session);
    this.#drainQueue(session);
    return this.snapshot(sessionId);
  }

  #queueChanged(session) {
    session.updatedAt = new Date().toISOString();
    this.#publish(session, "session.queue.updated", { queuedMessages: clone(session.queuedMessages), queuePaused: session.queuePaused });
    this.#schedulePersist(session);
  }

  #drainQueue(session) {
    if (session.drainScheduled || this.shuttingDown || session.closing || session.queuePaused || session.status !== "ready" || !session.queuedMessages.length) return;
    session.drainScheduled = true;
    queueMicrotask(() => {
      session.drainScheduled = false;
      if (this.shuttingDown || session.closing || session.queuePaused || session.status !== "ready" || !session.queuedMessages.length) return;
      const message = session.queuedMessages.shift();
      this.#beginTurn(session, message);
      this.#queueChanged(session);
    });
  }

  #beginTurn(session, { text, attachments = [], model, reasoningEffort, clientMessageId, submissionHash }) {
    const sessionId = session.id;
    const turn = {
      schemaVersion: "agent-turn.v1",
      id: compactId("agent_turn"),
      sessionId,
      clientMessageId,
      submissionHash,
      status: "running",
      input: [{ type: "text", text }, ...imagePromptParts(attachments)],
      ...(attachments.length ? { attachments: clone(attachments) } : {}),
      model: model ?? null,
      reasoningEffort: reasoningEffort ?? null,
      assistantText: "",
      assistantMessages: [],
      stopReason: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    session.turns.push(turn);
    session.model = model ?? session.model ?? null;
    session.reasoningEffort = reasoningEffort ?? null;
    session.activeTurnId = turn.id;
    session.status = "running";
    session.updatedAt = turn.startedAt;
    this.#schedulePersist(session);
    this.#publish(session, "turn.started", { turnId: turn.id }, turn.id);
    this.#publish(session, "user.message", { text, ...(attachments.length ? { attachments: attachments.map(publicAgentAttachment) } : {}) }, turn.id);

    const promptContent = [{ type: "text", text }, ...imagePromptParts(attachments)];
    if (session.turns.length === 1 && session.context?.topologyStateVersion) {
      if (session.capabilities?.promptCapabilities?.embeddedContext) promptContent.unshift(contextPrompt(session.context));
      else promptContent[0].text = `[Research selection]\n${JSON.stringify(workingContext(session.context))}\n\n[User message]\n${text}`;
    }
    Promise.resolve()
      .then(() => session.adapter.prompt({ turnId: turn.id, content: promptContent, model, reasoningEffort }))
      .then(async (result) => { await Promise.allSettled([...(session.imageCaptures ?? [])]); this.#completeTurn(session, turn, result); })
      .catch((error) => this.#failTurn(session, turn, error));
    return clone(turn);
  }

  async resolveApproval(sessionId, requestId, input = {}, actor = null) {
    const session = this.#require(sessionId);
    const approval = session.pendingApprovals.get(requestId);
    if (!approval) throw new AppError("AGENT_APPROVAL_NOT_FOUND", "没有找到等待处理的 Agent 审批。", { status: 404 });
    if (!["allow", "reject", "cancel"].includes(input.decision)) throw new AppError("AGENT_APPROVAL_DECISION_INVALID", "请选择允许、拒绝或停止。", { status: 422 });
    if (approval.resolving) throw new AppError("AGENT_APPROVAL_RESOLVING", "审批正在处理中。", { status: 409 });
    const decision = input.decision;
    const options = approval.options ?? [];
    const selected = input.optionId
      ? options.find((option) => option.optionId === input.optionId && approvalDecision(option.kind) === decision)
      : options.find((option) => option.kind === (decision === "allow" ? "allow_once" : decision === "reject" ? "reject_once" : "cancel"));
    if (!selected) throw new AppError("AGENT_APPROVAL_OPTION_INVALID", "Agent 没有提供可用的审批选项。", { status: 422 });
    approval.risk = approvalRisk(approval, this.projectRoot);
    requirePermission(actor, approvalPermission(approval, selected));
    if (input.permissionKeys !== undefined && (decision !== "allow" || session.provider !== "codex" || approval.category !== "permissions"
      || !Array.isArray(input.permissionKeys) || !input.permissionKeys.length || input.permissionKeys.some(key => !["network", "fileSystem"].includes(key) || !approval.permissions?.[key]))) {
      throw new AppError("AGENT_APPROVAL_PERMISSIONS_INVALID", "只能授予本次请求中已有的权限类别。", { status: 422 });
    }
    const resolution = { requestId, decision, optionId: selected.optionId, selectedScope: selected.scope,
      ...(input.permissionKeys !== undefined ? { permissionKeys: [...new Set(input.permissionKeys)] } : {}) };
    approval.resolving = true;
    approval.resolution = resolution;
    if (decision === "cancel") {
      this.cancel(sessionId);
      await this.#persistNow(session);
      return { ...resolution, status: "resolved" };
    }
    try { await session.adapter.resolvePermission(requestId, selected.optionId, decision === "cancel", { permissionKeys: resolution.permissionKeys }); }
    catch (error) {
      // A native SSE acknowledgement can precede the HTTP reply (or its failure).
      if (!approval.nativeResolved) { approval.resolving = false; delete approval.resolution; throw error; }
    }
    if (!approval.nativeResolved) this.#resolveApprovalEvent(session, approval, resolution);
    await this.#persistNow(session);
    return { ...resolution, status: "resolved" };
  }

  #resolveApprovalEvent(session, approval, payload) {
    session.pendingApprovals.delete(payload.requestId);
    const turn = session.turns.find(item => item.id === approval.turnId);
    if (turn && !turn.completedAt && turn.status !== "cancelling" && session.activeTurnId === turn.id && !session.closing) {
      session.status = session.pendingApprovals.size ? "awaiting_permission" : "running";
      turn.status = session.status;
    }
    let permissionGrant;
    if (payload.decision === "allow" && payload.selectedScope === "session") {
      const option = approval.options?.find(item => item.optionId === payload.optionId);
      session.permissionGrants ??= [];
      permissionGrant = { requestId: payload.requestId, optionId: payload.optionId, label: option?.label, mode: option?.mode,
        patterns: clone(option?.patterns ?? approval.rememberPatterns ?? []), grantedAt: new Date().toISOString(), runtimeInstanceId: session.runtimeInstanceId };
      session.permissionGrants.push(permissionGrant);
    }
    this.#publish(session, "approval.resolved", { ...payload, sessionStatus: session.status, ...(permissionGrant ? { permissionGrant } : {}) }, approval.turnId);
  }

  #expireApprovals(session, decision = "expired", turnId = null) {
    for (const [requestId, approval] of [...session.pendingApprovals]) {
      if (turnId && approval.turnId !== turnId) continue;
      this.#resolveApprovalEvent(session, approval, { requestId, decision, status: decision,
        ...(approval.resolution?.decision === "cancel" ? approval.resolution : {}) });
    }
  }

  async resume(sessionId, input = {}) {
    if (this.resumptions.has(sessionId)) return this.resumptions.get(sessionId);
    const pending = this.#resume(sessionId, input);
    this.resumptions.set(sessionId, pending);
    try { return await pending; } finally { this.resumptions.delete(sessionId); }
  }

  async #resume(sessionId, input = {}) {
    const source = this.#require(sessionId);
    if (source.archived) throw new AppError("AGENT_SESSION_ARCHIVED", "请先恢复归档的会话。", { status: 409 });
    if (source.researchInterface !== RESEARCH_INTERFACE) throw new AppError("AGENT_INTERFACE_UNSUPPORTED", "科研会话接口已更换，请创建新会话。", { status: 409 });
    if ((source.ownerUserId ?? null) !== (input.ownerUserId ?? null)) throw new AppError("AGENT_SESSION_OWNER_MISMATCH", "不能继承其他用户的研究会话身份。", { status: 403 });
    if (source.closing) throw new AppError("AGENT_SESSION_CLOSING", "会话正在关闭，请稍后继续。", { status: 409 });
    if (["starting", "ready", "running", "awaiting_permission"].includes(source.status) && source.adapter) {
      return this.snapshot(sessionId);
    }
    if (input.profileId && input.profileId !== source.profileId) throw new AppError("AGENT_RESUME_PROFILE_MISMATCH", "继续会话时不能更换 Agent 运行时，请创建新会话。", { status: 409 });
    this.#checkRuntimeCapacity();
    const resumeNativeThreadId = source.nativeSessionId && source.capabilities?.session?.resume && source.sync?.status !== "source_missing" ? source.nativeSessionId : null;
    const active = source.turns.find(turn => turn.id === source.activeTurnId);
    if (active && !active.completedAt) this.#failTurn(source, active, new AppError("AGENT_RUNTIME_REPLACED", "上一运行实例已结束。"));
    const previousAdapter = source.adapter;
    const previousRuntimeId = source.runtimeInstanceId ?? source.id;
    source.runtimeInstanceId = compactId("agent_runtime");
    source.adapter = null;
    source.closePromise = null;
    source.status = "starting";
    source.activeTurnId = null;
    source.pendingApprovals.clear();
    source.permissionGrants = [];
    source.reasoningSegment = null;
    source.model = input.model ?? source.model;
    source.reasoningEffort = input.reasoningEffort ?? source.reasoningEffort;
    source.title = cleanTitle(input.title, source.title);
    source.locale = input.locale ?? source.locale;
    source.updatedAt = new Date().toISOString();
    this.#publish(source, "session.status", { status: "starting", runtimeInstanceId: source.runtimeInstanceId });
    await previousAdapter?.close().catch(() => {});
    this.onSessionClosed?.(previousRuntimeId);
    return this.#startRuntime(source, { ...input, model: source.model, reasoningEffort: source.reasoningEffort, resumeNativeThreadId });
  }

  async sync(sessionId, { reason = "manual" } = {}) {
    const session = this.#require(sessionId);
    if (!session.nativeSessionId || !session.capabilities?.session?.sync) {
      session.sync = { ...(session.sync ?? {}), source: session.provider ?? "local", status: "legacy_local_snapshot", lastSyncedAt: session.sync?.lastSyncedAt ?? null, error: null };
      await this.#persistNow(session);
      return { session: this.snapshot(sessionId), status: session.sync.status, reason };
    }
    session.sync = { ...(session.sync ?? {}), source: "agent-native", status: "syncing", error: null, lastReason: reason };
    this.#schedulePersist(session);
    const snapshotCursor = session.cursor;
    const runtimeInstanceId = session.runtimeInstanceId;
    try {
      const snapshot = await this.#readSessionSnapshot(session);
      if (session.runtimeInstanceId !== runtimeInstanceId) return { session: this.snapshot(sessionId), status: "superseded", reason };
      session.nativeSnapshot = redactAgentSecrets(snapshot);
      this.#projectSnapshot(session, snapshot, snapshotCursor);
      session.sync = { ...(session.sync ?? {}), source: "agent-native", status: "synced", lastSyncedAt: snapshot.syncedAt ?? new Date().toISOString(), lastNativeUpdatedAt: snapshot.thread?.thread?.updatedAt ?? snapshot.thread?.updatedAt ?? null, error: null };
      await this.#persistNow(session);
      return { session: this.snapshot(sessionId), status: "synced", reason };
    } catch (error) {
      if (session.runtimeInstanceId !== runtimeInstanceId) return { session: this.snapshot(sessionId), status: "superseded", reason };
      const missing = error.status === 404 || ["AGENT_THREAD_NOT_FOUND", "CODEX_THREAD_NOT_FOUND", "AGENT_SESSION_SOURCE_NOT_FOUND"].includes(error.code) || /not found|unknown thread|does not exist/i.test(error.message ?? "");
      session.sync = { ...(session.sync ?? {}), source: "agent-native", status: missing ? "source_missing" : "sync_failed", error: { code: error.code ?? "AGENT_SYNC_FAILED", message: error.message, at: new Date().toISOString() } };
      await this.#persistNow(session);
      return { session: this.snapshot(sessionId), status: session.sync.status, reason, error: session.sync.error };
    }
  }

  async #readSessionSnapshot(session) {
    if (session.adapter?.readSnapshot) return session.adapter.readSnapshot({ nativeSessionId: session.nativeSessionId });
    const adapter = await this.profileRegistry.createAdapter(session.profileId, {
      onEvent: () => {},
      model: session.model ?? undefined,
      reasoningEffort: session.reasoningEffort ?? undefined,
    });
    try {
      return await adapter.readSnapshot({ nativeSessionId: session.nativeSessionId });
    } finally {
      await adapter.close().catch(() => {});
    }
  }

  #projectSnapshot(session, snapshot, snapshotCursor = Infinity) {
    const advancedIds = new Set(session.conversationEvents.filter(event => (event.updatedCursor ?? event.cursor) > snapshotCursor)
      .flatMap(event => [event.payload.nativeItemId, event.payload.blockId, event.payload.messageId, event.payload.toolCallId]).filter(Boolean));
    const advanced = nativeItemId => advancedIds.has(nativeItemId);
    if (snapshot?.format === "agent-native-events.v1") {
      for (const event of snapshot.events ?? []) {
        const nativeItemId = event.payload?.nativeItemId;
        if (nativeItemId && advanced(nativeItemId)) continue;
        const turn = session.turns.find((turn) => turn.nativeMessageId === event.payload?.nativeParentId);
        if (event.type === "user.message" && turn) continue;
        if (event.type === "tool.started" && nativeItemId && session.conversationEvents.some(existing => existing.type === "tool.started"
          && existing.payload.nativeItemId === nativeItemId && existing.turnId === (turn?.id ?? event.turnId ?? null))) continue;
        if (nativeItemId && session.conversationEvents.some(existing => existing.type === event.type && existing.payload?.nativeItemId === nativeItemId
          && nativePayloadFingerprint(existing.payload) === nativePayloadFingerprint(event.payload))) continue;
        this.#onDriverEvent(session.id, { ...event, turnId: turn?.id ?? event.turnId ?? null });
      }
      return;
    }
    this.#projectCodexSnapshot(session, snapshot, advancedIds);
  }

  #projectCodexSnapshot(session, snapshot, advancedIds) {
    const turns = snapshot?.turns?.data ?? snapshot?.turns ?? [];
    const listedItems = snapshot?.items?.data ?? snapshot?.items ?? [];
    const items = [];
    const seen = new Map();
    const appendItem = (key, entry) => {
      const prior = seen.get(key);
      if (prior) Object.assign(prior, entry);
      else { seen.set(key, entry); items.push(entry); }
    };
    for (const turn of turns) for (const item of turn.items ?? []) {
      const key = item.id ?? `${turn.id}:${items.length}`;
      appendItem(key, { item, turnId: turn.id ?? turn.rootTurnId ?? null });
    }
    for (const entry of listedItems) {
      if (entry?.item) {
        const key = entry.item.id ?? `${entry.turnId}:${items.length}`;
        appendItem(key, { item: entry.item, turnId: entry.turnId ?? null });
      } else if (entry?.id && entry?.type) {
        appendItem(entry.id, { item: entry, turnId: entry.turnId ?? null });
      }
    }
    for (const { item, turnId } of items) {
      const type = String(item.type ?? "").toLowerCase();
      const nativeItemId = item.id;
      if (nativeItemId && advancedIds.has(nativeItemId)) continue;
      const hasNative = session.conversationEvents.some((event) => event.payload?.nativeItemId === nativeItemId);
      if (!nativeItemId) continue;
      const localTurn = session.turns.find((turn) => turn.nativeTurnId === turnId || turn.id === turnId);
      const localTurnId = localTurn?.id ?? turnId;
      if (type === "usermessage") {
        if (localTurn || hasNative) continue;
        const text = (item.content ?? []).map((part) => part.text ?? "").join("\n");
        this.#publish(session, "user.message", { text, nativeItemId }, localTurnId, `native:${nativeItemId}:user`);
      } else if (type === "agentmessage") {
        if (session.conversationEvents.some(event => event.type === "assistant.message.completed" && event.payload.nativeItemId === nativeItemId && event.payload.text === (item.text ?? ""))) continue;
        this.#onDriverEvent(session.id, { type: "assistant.message.completed", payload: { text: item.text ?? "", messageId: nativeItemId, blockId: nativeItemId, nativeItemId, nativeMessageId: nativeItemId, phase: item.phase, delivery: item.delivery, completion: "completed" }, turnId: localTurnId });
      } else if (type === "reasoning") {
        for (const part of codexReasoningParts(item)) {
          const payload = { messageId: nativeItemId, nativeItemId, channel: part.channel, summaryIndex: part.index, text: part.text };
          const key = reasoningStreamKey({ id: nativeItemId, turnId: localTurnId, payload });
          if (session.conversationEvents.some(event => event.type === "reasoning.summary.completed" && reasoningStreamKey(event) === key && event.payload.text === part.text)) continue;
          this.#publish(session, "reasoning.summary.completed", payload, localTurnId);
        }
      } else if (type === "plan") {
        const payload = { itemId: nativeItemId, nativeItemId, text: item.text ?? "", updateKind: "snapshot", completion: "completed" };
        if (session.conversationEvents.some(event => event.type === "plan.updated" && event.payload.nativeItemId === nativeItemId && event.payload.text === payload.text)) continue;
        this.#publish(session, "plan.updated", payload, localTurnId);
      } else if (["commandexecution", "filechange", "mcptoolcall", "dynamictoolcall", "collabagenttoolcall", "subagentactivity", "websearch", "imageview", "imagegeneration"].includes(type)) {
        const payload = { toolCallId: nativeItemId, kind: item.type, item, nativeItemId };
        if (!hasNative) this.#publish(session, "tool.started", payload, localTurnId, `native:${nativeItemId}:started`);
        const status = String(item.status ?? "completed").toLowerCase();
        if (["inprogress", "running", "pending"].includes(status)) continue;
        const type = ["failed", "error", "declined"].includes(status) ? "tool.failed" : "tool.completed";
        if (!session.conversationEvents.some(event => event.type === type && event.payload.nativeItemId === nativeItemId && JSON.stringify(event.payload.item) === JSON.stringify(item))) {
          this.#publish(session, type, payload, localTurnId);
        }
      }
    }
  }

  cancel(sessionId) {
    const session = this.#require(sessionId);
    if (!session.activeTurnId) throw new AppError("AGENT_TURN_NOT_ACTIVE", "当前会话没有可取消的运行轮次。", { status: 409 });
    const turn = session.turns.find((item) => item.id === session.activeTurnId);
    session.queuePaused = true;
    this.#queueChanged(session);
    const pending = [...session.pendingApprovals];
    if (turn) turn.status = "cancelling";
    session.status = "running";
    this.#publish(session, "turn.cancelling", { turnId: session.activeTurnId }, session.activeTurnId);
    this.#expireApprovals(session, "cancelled");
    for (const [requestId] of pending) {
      void session.adapter.resolvePermission(requestId, null, true).catch(() => {});
    }
    session.adapter.cancel();
    this.#schedulePersist(session);
    return { sessionId, turnId: session.activeTurnId, status: "cancelling" };
  }

  async close(sessionId) {
    const session = this.#require(sessionId);
    if (session.status === "closed") return this.snapshot(sessionId);
    if (session.closePromise) return session.closePromise;
    session.closing = true;
    session.queuePaused = true;
    session.status = "closing";
    session.closePromise = this.#close(session);
    return session.closePromise;
  }

  async #close(session) {
    const sessionId = session.id;
    if (session.activeTurnId) session.adapter.cancel();
    if (session.nativeSessionId && session.capabilities?.session?.sync) await this.sync(sessionId, { reason: "session-closed" }).catch(() => {});
    await session.adapter?.close().catch(() => {});
    const active = session.turns.find((turn) => turn.id === session.activeTurnId);
    if (active && !active.completedAt) this.#completeTurn(session, active, { stopReason: "cancelled" });
    this.#expireApprovals(session, "cancelled");
    session.status = "closed";
    session.permissionGrants = [];
    this.onSessionClosed?.(session.runtimeInstanceId ?? session.id);
    session.closing = false;
    session.activeTurnId = null;
    session.updatedAt = new Date().toISOString();
    this.#publish(session, "session.closed", { status: "closed" });
    await this.#persistNow(session);
    return this.snapshot(sessionId);
  }

  subscribe(sessionId, listener, after = 0) {
    const session = this.#require(sessionId);
    const stream = session.streamEvents ?? [];
    const replay = stream.length && after >= stream[0].cursor - 1 ? stream
      : traceFromConversation(session.conversationEvents, session.events).map(event => event.type === "tool.started" ? { ...event, type: "tool.updated" } : event).sort((a, b) => a.cursor - b.cursor);
    for (const event of replay) if (event.cursor > after) listener(clone(event));
    session.subscribers.add(listener);
    return () => session.subscribers.delete(listener);
  }

  async closeAll() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.#shutdown();
    return this.shutdownPromise;
  }

  async #shutdown() {
    await Promise.all([...this.sessions.values()].map((session) => session.adapter?.close().catch(() => {})));
    await Promise.allSettled([...this.sessions.values()].flatMap(session => [...(session.imageCaptures ?? [])]));
    for (const session of this.sessions.values()) {
      const turn = session.turns.find(turn => turn.id === session.activeTurnId && !turn.completedAt);
      if (!turn) continue;
      turn.status = "failed"; turn.stopReason = "server_shutdown"; turn.completedAt = new Date().toISOString();
      session.activeTurnId = null; session.status = "detached";
      this.#expireApprovals(session, "expired", turn.id);
      this.#publish(session, "turn.failed", { sessionStatus: "detached", error: { code: "AGENT_SERVER_SHUTDOWN", message: "服务已停止，可恢复会话继续。" } }, turn.id);
    }
    await this.persistence.close([...this.sessions.values()]);
    for (const session of this.sessions.values()) this.onSessionClosed?.(session.runtimeInstanceId ?? session.id);
  }

  #assistantMessage(turn, payload = {}) {
    if (!turn) return null;
    const messageId = payload.blockId ?? payload.messageId ?? payload.nativeItemId ?? `turn:${turn.id}`;
    let message = (turn.assistantMessages ?? []).find(item => item.messageId === messageId && actorKey(item) === actorKey(payload));
    if (!message) {
      turn.assistantMessages ??= [];
      message = { ...payload, messageId, text: "", completed: false };
      delete message.delta;
      turn.assistantMessages.push(message);
    }
    return message;
  }

  #updateTurnText(turn) {
    turn.assistantText = (turn.assistantMessages ?? []).filter(message => !message.agentId && !message.parentToolUseId).map(message => message.text).join("");
  }

  #onDriverEvent(sessionId, event) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (event.type === "native.trace" || event.type === "provider.event") return;
    const turnId = event.turnId === undefined ? session.activeTurnId : event.turnId;
    const turn = session.turns.find((item) => item.id === turnId);
    const payload = redactAgentSecrets(clone(event.payload ?? {}));
    if (event.type === "tool.completed" && isImageView(event) && this.captureImage && !payload.imageCaptured) {
      session.imageCaptures ??= new Set();
      const capture = Promise.resolve().then(() => this.captureImage(sessionId, { ...event, sessionId, turnId })).then(
        image => this.#onDriverEvent(sessionId, { ...event, turnId, payload: { ...payload, imageCaptured: true, imageAttachment: publicAgentAttachment(image) } }),
        error => this.#onDriverEvent(sessionId, { ...event, turnId, payload: { ...payload, imageCaptured: true, imageCaptureError: error.message } }),
      ).finally(() => session.imageCaptures.delete(capture));
      session.imageCaptures.add(capture); return;
    }
    if (event.type === "tool.completed") {
      session.candidateTurns ??= {};
      for (const [id, linkedTurn] of candidateTurnLinks({ events: [{ ...event, payload, turnId }] })) session.candidateTurns[id] = linkedTurn;
    }
    if (event.type === "usage.updated") session.usage = clone(payload);
    if (["assistant.message.", "reasoning.summary.", "tool."].some(prefix => event.type.startsWith(prefix)) && !payload.restored && session.conversationEvents.some(removal => removal.type === "content.removed"
      && isRemovedContent({ ...event, payload }, removal))) return;
    if (event.type === "turn.native-linked" && turn) {
      turn.nativeMessageId = payload.nativeMessageId;
      turn.nativeTurnId = payload.nativeTurnId;
    }
    if (event.type === "assistant.message.delta") {
      const message = this.#assistantMessage(turn, payload);
      if (message) {
        if (message.completed) return;
        payload.messageId ??= message.messageId;
        message.text += payload.delta ?? "";
        this.#updateTurnText(turn);
      }
    }
    if (event.type.startsWith("reasoning.summary.")) {
      if (!payload.messageId && !payload.nativeItemId && !payload.reasoningId) {
        if (!session.reasoningSegment || session.reasoningSegment.turnId !== turnId) session.reasoningSegment = { turnId, id: compactId("reasoning") };
        payload.reasoningId = session.reasoningSegment.id;
      }
      payload.messageId ??= payload.nativeItemId ?? payload.reasoningId;
    }
    if (["tool.started", "assistant.message.delta", "assistant.message.completed"].includes(event.type)) session.reasoningSegment = null;
    if (event.type === "assistant.message.completed" || event.type === "assistant.message.snapshot") {
      const message = this.#assistantMessage(turn, payload);
      if (message) {
        const messageId = message.messageId;
        const text = typeof payload.text === "string" ? payload.text : message.text;
        Object.assign(message, payload, { messageId, text });
        delete message.delta;
        message.completed = event.type === "assistant.message.completed";
        message.completion = payload.completion ?? (message.completed ? "completed" : "streaming");
        payload.messageId ??= message.messageId;
        payload.nativeItemId ??= message.messageId;
        payload.text = message.text;
        this.#updateTurnText(turn);
      }
    }
    if (event.type === "content.removed") {
      if (!payload.targetId && !payload.nativeMessageId) return;
      for (const storedTurn of session.turns) {
        storedTurn.assistantMessages = (storedTurn.assistantMessages ?? []).filter(message =>
          payload.targetId ? contentBlockId(message) !== payload.targetId && message.nativeItemId !== payload.targetId
            : message.nativeMessageId !== payload.nativeMessageId);
        this.#updateTurnText(storedTurn);
      }
    }
    if (event.type === "approval.requested") {
      payload.risk = approvalRisk(payload, this.projectRoot);
      const requestId = payload.requestId;
      if (!requestId || !turn || turn.completedAt || turn.status === "cancelling" || session.activeTurnId !== turnId || session.closing || !["running", "awaiting_permission"].includes(session.status)) {
        if (requestId) void session.adapter?.resolvePermission(requestId, null, true).catch(() => {});
        return;
      }
      if (session.pendingApprovals.has(requestId)) return;
      session.pendingApprovals.set(requestId, { ...clone(payload), turnId });
      session.status = "awaiting_permission";
      if (turn) turn.status = "awaiting_permission";
    }
    if (event.type === "approval.resolved") {
      const approval = session.pendingApprovals.get(payload.requestId);
      if (!approval) return;
      approval.nativeResolved = true;
      this.#resolveApprovalEvent(session, approval, { ...payload, ...(approval.resolution ?? {}) });
      this.#schedulePersist(session);
      return;
    }
    if (event.type === "driver.process.closed" && !payload.expected && session.status !== "closed") {
      session.status = "failed";
    }
    session.updatedAt = new Date().toISOString();
    session.sync = { ...(session.sync ?? {}), source: session.nativeSessionId ? "agent-native" : (session.provider ?? "local"), status: "live", lastEventAt: session.updatedAt };
    this.#publish(session, event.type, payload, turnId);
    this.#schedulePersist(session);
    if (event.type === "assistant.message.completed") this.#researchEvent(session, "agentMessage", turnId, payload);
    if (event.type === "tool.started") this.#researchEvent(session, "toolCall", turnId, payload);
    if (["tool.completed", "tool.failed"].includes(event.type)) this.#researchEvent(session, "toolResult", turnId, payload);
  }

  #completeTurn(session, turn, result = {}) {
    if (turn.status === "failed" || turn.completedAt) return;
    if (result?.stopReason === "error") return this.#failTurn(session, turn, new AppError("AGENT_TURN_FAILED", "Agent 回合执行失败。", { status: 502 }));
    turn.stopReason = result?.stopReason ?? "end_turn";
    turn.status = turn.stopReason === "cancelled" ? "cancelled" : turn.stopReason === "incomplete" ? "incomplete" : "completed";
    turn.completedAt = new Date().toISOString();
    const assistantMessages = turn.assistantMessages ?? [];
    if (assistantMessages.length) {
      for (const message of assistantMessages) {
        if (message.completed) continue;
        message.completed = true;
        const payload = { ...message, messageId: message.messageId, text: message.text, completion: turn.stopReason === "cancelled" ? "interrupted" : "incomplete" };
        this.#publish(session, "assistant.message.completed", payload, turn.id);
        this.#researchEvent(session, "agentMessage", turn.id, { kind: "interactive-message", ...payload });
      }
    } else if (turn.assistantText) {
      // Fallback for non-streaming drivers that only return a turn-level text.
      const payload = { messageId: `turn:${turn.id}`, text: turn.assistantText };
      this.#publish(session, "assistant.message.completed", payload, turn.id);
      this.#researchEvent(session, "agentMessage", turn.id, { kind: "interactive-message", ...payload });
    }
    session.activeTurnId = null;
    session.status = session.closing ? "closed" : session.adapter?.closed ? "failed" : "ready";
    session.updatedAt = turn.completedAt;
    this.#expireApprovals(session, turn.stopReason === "cancelled" ? "cancelled" : "expired", turn.id);
    this.#publish(session, turn.status === "cancelled" ? "turn.cancelled" : "turn.completed", {
      turnId: turn.id,
      stopReason: turn.stopReason,
      sessionStatus: session.status,
    }, turn.id);
    void this.#persistNow(session).catch(() => {});
    this.#drainQueue(session);
    if (!this.shuttingDown && !session.closing && session.nativeSessionId && session.capabilities?.session?.sync) void this.sync(session.id, { reason: "turn-completed" }).catch(() => {});
  }

  #failTurn(session, turn, error) {
    if (turn.completedAt) return;
    turn.status = "failed";
    turn.completedAt = new Date().toISOString();
    turn.stopReason = "error";
    session.activeTurnId = null;
    session.status = session.closing ? "closed" : session.adapter?.closed ? "failed" : "ready";
    this.#expireApprovals(session, "expired", turn.id);
    session.queuePaused = true;
    this.#queueChanged(session);
    session.updatedAt = turn.completedAt;
    this.#publish(session, "turn.failed", {
      turnId: turn.id,
      error: { code: error.code ?? "AGENT_TURN_FAILED", message: error.message },
      sessionStatus: session.status,
    }, turn.id);
    void this.#persistNow(session).catch(() => {});
  }

  #researchEvent(session, type, turnId, payload = {}) {
    if (!this.onResearchEvent) return;
    this.onResearchEvent({
      type,
      actor: type === "agentMessage" ? "agent-a" : `adapter:${session.provider}`,
      sessionId: session.id,
      nodeIds: session.context?.nodeIds ?? [],
      sourceRefs: session.context?.sourceRefs ?? [],
      payload: { ...clone(payload), profileId: session.profileId, provider: session.provider, turnId },
    });
  }

  #publish(session, type, payload = {}, turnId = null, eventId = null) {
    const event = {
      schemaVersion: "agent-session-event.v1",
      id: eventId ?? compactId("agent_session_event"),
      cursor: ++session.cursor,
      sessionId: session.id,
      turnId,
      type,
      occurredAt: new Date().toISOString(),
      provider: session.provider,
      payload: redactAgentSecrets(clone(payload)),
    };
    if (type === "user.message" || type.startsWith("assistant.message.")) session.latestMessageCursor = event.cursor;
    session.streamEvents ??= [];
    session.streamEvents.push(event);
    if (session.streamEvents.length > this.maxEventsPerSession) session.streamEvents.splice(0, session.streamEvents.length - this.maxEventsPerSession);
    session.events = appendTraceEvent(session.events, event);
    session.conversationEvents = appendConversationEvent(session.conversationEvents, event);
    if (session.events.length > this.maxEventsPerSession) {
      session.traceDroppedEvents += session.events.length - this.maxEventsPerSession;
      session.events.splice(0, session.events.length - this.maxEventsPerSession);
    }
    for (const subscriber of session.subscribers) subscriber(clone(event));
    return event;
  }

  #schedulePersist(session) {
    if (!this.shuttingDown) this.persistence.schedule(session);
  }

  async #persistNow(session) {
    await this.persistence.save(session);
  }

  #publicSession(session, includeEvents, summary = false) {
    if (summary) return { id: session.id, title: session.title, profileId: session.profileId, provider: session.provider, model: session.model,
      ownerUserId: session.ownerUserId, pinned: session.pinned ?? false, archived: session.archived ?? false,
      status: session.status, createdAt: session.createdAt, updatedAt: session.updatedAt, lastCursor: session.cursor,
      lastReadCursor: session.lastReadCursor ?? 0, latestMessageCursor: session.latestMessageCursor ?? 0,
      turnCount: session.turns.length, queuedMessageCount: session.queuedMessages?.length ?? 0,
      pendingApprovals: [...session.pendingApprovals.values()].map(({ requestId, toolName, category }) => ({ requestId, toolName, category })) };
    return {
      schemaVersion: session.schemaVersion,
      id: session.id,
      title: session.title,
      pinned: session.pinned ?? false, archived: session.archived ?? false,
      lastReadCursor: session.lastReadCursor ?? 0, latestMessageCursor: session.latestMessageCursor ?? 0,
      permissionGrants: clone(session.permissionGrants ?? []),
      profileId: session.profileId,
      researchInterface: session.researchInterface,
      researchSessionId: session.researchSessionId,
      candidateTurns: clone(session.candidateTurns ?? {}),
      runtimeInstanceId: session.runtimeInstanceId,
      ownerUserId: session.ownerUserId,
      model: session.model ?? null,
      reasoningEffort: session.reasoningEffort ?? null,
      provider: session.provider,
      parentSessionId: session.parentSessionId ?? null,
      resumedFrom: session.resumedFrom ?? null,
      status: session.status,
      nativeSessionId: session.nativeSessionId,
      sync: clone(session.sync ?? null),
      nativeSnapshot: clone(session.nativeSnapshot ?? null),
      usage: clone(session.usage ?? null),
      capabilities: clone(session.capabilities),
      agentInfo: clone(session.agentInfo),
      authMethods: clone(session.authMethods),
      context: clone(session.context),
      locale: session.locale,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      activeTurnId: session.activeTurnId,
      historyStatus: session.historyStatus ?? "live",
      historyError: session.historyError ?? null,
      runtimeStatus: session.runtimeStatus ?? null,
      resumable: ["detached", "failed", "closed"].includes(session.status),
      turns: clone(session.turns),
      queuedMessages: clone(session.queuedMessages ?? []),
      queuePaused: session.queuePaused ?? false,
      pendingApprovals: [...session.pendingApprovals.values()].map(clone),
      lastCursor: session.cursor,
      ...(includeEvents ? {
        events: clone(session.events), conversationEvents: clone(session.conversationEvents),
        eventRetention: { limit: this.maxEventsPerSession, firstCursor: session.events[0]?.cursor ?? null,
          droppedEvents: session.traceDroppedEvents ?? 0 },
      } : {}),
    };
  }

  #require(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new AppError("AGENT_SESSION_NOT_FOUND", "没有找到指定的 Agent 会话。", { status: 404, detail: { sessionId } });
    return session;
  }
}
