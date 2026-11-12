import { randomBytes } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Event, OpencodeClient, TextPartInput, FilePartInput, PermissionRuleset } from "@opencode-ai/sdk/v2/client";
import type { AgentStartInput, AgentPromptInput } from "../../../../domain/agents/agent-types.js";
import { promptImages } from "../../shared/prompt-images.js";
import { AgentAdapter } from "../../shared/agent-adapter.js";
import { OpenCodeServer, readOpenCodeCatalog, resolveOpenCodeModelId, type OpenCodeCatalog, type OpenCodeProfile } from "./opencode-server.js";
import { OpenCodeTrace, type OpenCodeEvent } from "./opencode-trace.js";
import { AppError } from "../../../../lib/errors.js";
import { compactId } from "../../../../lib/hash.js";

interface TurnResult { stopReason: "end_turn" | "cancelled" | "incomplete" }
interface PendingTurn {
  id: string; userMessageId: string; cancelled: boolean; accepted: boolean;
  resolve: (result: TurnResult) => void; reject: (error: Error) => void;
  cancelTimer?: ReturnType<typeof setTimeout>; abortSent?: boolean; requestAbort: AbortController;
}
interface AdapterOptions {
  cwd?: string; env?: Record<string, string>; requestTimeoutMs?: number; onEvent?: (event: OpenCodeEvent) => void;
  // Injection keeps tests on the real SDK's HTTP/SSE transport.
  serverFactory?: () => OpenCodeServer;
}

function nativeError(error: unknown, code = "OPENCODE_REQUEST_FAILED"): Error {
  if (error instanceof AppError) return error;
  const detail = error as { cause?: { status?: number }; data?: { message?: string; statusCode?: number } };
  const status = detail?.cause?.status ?? detail?.data?.statusCode;
  if (code === "AGENT_SESSION_SOURCE_NOT_FOUND" && status === 404) return new AppError(code, "没有找到 OpenCode 原生会话，本地保存的会话记录仍然可用。", { status: 404 });
  const description = detail?.data?.message?.slice(0, 500);
  return new AppError(code, `OpenCode 请求失败${status ? `（HTTP ${status}）` : ""}${description ? `：${description}` : "，请检查本机 Provider、模型和网络配置。"}`, { status: 502 });
}

function sameDirectory(a: string, b: string): boolean {
  const first = path.resolve(a), second = path.resolve(b);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

export class OpenCodeAgentAdapter extends AgentAdapter {
  declare profile: OpenCodeProfile;
  declare options: AdapterOptions;
  declare onEvent: (event: OpenCodeEvent) => void;
  private server: OpenCodeServer;
  private client?: OpencodeClient;
  private streamAbort = new AbortController();
  private streamTask?: Promise<void>;
  private turn?: PendingTurn;
  private trace: OpenCodeTrace;
  private instructions = "";
  private cwd: string;
  private catalog?: OpenCodeCatalog;
  private approvals = new Map<string, { nativeId: string; turnId?: string; canRemember: boolean }>();
  private userTurns = new Map<string, string>();
  private seenEvents = new Set<string>();
  private eventTurnId?: string | null;
  private nativeEventId?: string;
  nativeSessionId: string | null = null;
  closed = false;

  constructor(profile: OpenCodeProfile, options: AdapterOptions = {}) {
    super(profile, options);
    this.server = options.serverFactory?.() ?? new OpenCodeServer();
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.trace = new OpenCodeTrace(event => this.onEvent({ ...event, payload: { nativeSessionId: this.nativeSessionId, nativeEventId: this.nativeEventId, ...event.payload } }), () => this.eventTurnId ?? this.turn?.id ?? null);
  }

  async start(input: AgentStartInput = {}) {
    this.cwd = path.resolve(input.cwd ?? this.cwd);
    this.instructions = input.developerInstructions ?? "";
    try {
      this.client = await this.server.start(this.profile, this.cwd, {}, () => this.onProcessExit(), this.options.env);
      if (input.researchMcp) {
        const binding = input.researchMcp;
        const { data: connections } = await this.client.mcp.add({ name: binding.name, config: { type: "local", command: [binding.command, ...binding.args], environment: binding.env, enabled: true, timeout: 30000 } });
        if (connections?.[binding.name]?.status !== "connected") throw new AppError("OPENCODE_MCP_UNAVAILABLE", "科研 MCP 连接失败，请检查会话授权和 CLI。", { status: 503 });
      }
      this.catalog = await readOpenCodeCatalog(this.client, this.profile.model ?? undefined);
      if (!this.catalog.models.length) throw new AppError("OPENCODE_NO_MODELS", "OpenCode 没有可用模型，请先在本机配置 Provider。", { status: 503 });
      const policy = this.profile.approvalPolicy === "never" && this.profile.sandbox !== "read-only" ? "allow" : "ask";
      const permission: PermissionRuleset = this.profile.nativeConfig ? [] : [{ permission: "*", pattern: "*", action: policy },
        ...["read", "glob", "grep", "list"].map(name => ({ permission: name, pattern: "*", action: "allow" as const })),
        ...(input.researchMcp ? [{ permission: `${input.researchMcp.name}_*`, pattern: "*", action: "allow" as const }] : [])];
      if (input.resumeThreadId) {
        const { data } = await this.client.session.get({ sessionID: input.resumeThreadId });
        if (!data) throw new AppError("OPENCODE_SESSION_NOT_FOUND", "没有找到 OpenCode 原生会话。", { status: 404 });
        if (!sameDirectory(data.directory, this.cwd)) throw new AppError("OPENCODE_SESSION_DIRECTORY_MISMATCH", "原生会话不属于当前项目目录。", { status: 409 });
        this.nativeSessionId = data.id;
        if (permission.length) await this.client.session.update({ sessionID: data.id, permission });
      } else {
        const { data } = await this.client.session.create({ title: "Topolumia", ...(permission.length ? { permission } : {}) });
        if (!data) throw new AppError("OPENCODE_SESSION_CREATE_FAILED", "OpenCode 未返回新会话。", { status: 502 });
        this.nativeSessionId = data.id;
      }
      await this.startStream();
      return { nativeSessionId: this.nativeSessionId, model: this.catalog.model,
        capabilities: { streaming: true, tools: true, permissions: true, approval: { interactive: policy === "ask", policy: this.profile.approvalPolicy ?? "on-request" }, session: { resume: true, sync: true } },
        agentInfo: { name: "OpenCode", transport: "opencode-server-http-sse" }, authMethods: [] };
    } catch (error) { await this.close(); throw nativeError(error); }
  }

  private async startStream(): Promise<void> {
    let ready!: () => void;
    let failed!: (error: Error) => void;
    const connected = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    const timer = setTimeout(() => failed(new AppError("OPENCODE_STREAM_UNAVAILABLE", "无法连接 OpenCode 事件流。", { status: 503 })), 15_000);
    this.streamTask = this.consumeStream(ready).catch((error) => {
      failed(nativeError(error));
      if (!this.closed) { this.settle(undefined, nativeError(error, "OPENCODE_STREAM_LOST")); this.onProcessExit(); }
    });
    try { await connected; } finally { clearTimeout(timer); }
  }

  private async consumeStream(ready: () => void): Promise<void> {
    let attempts = 0;
    let reconnect = false;
    while (!this.streamAbort.signal.aborted) {
      const connectedAt = Date.now();
      const response = await this.client!.event.subscribe({}, { signal: this.streamAbort.signal, sseMaxRetryAttempts: 1 });
      for await (const event of response.stream) {
        if (event.type === "server.connected") {
          ready();
          if (reconnect && this.turn) {
            await this.reconcile();
            const { data: pending } = await this.client!.permission.list();
            const active = (pending ?? []).filter(request => request.sessionID === this.nativeSessionId);
            for (const [requestId, approval] of this.approvals) if (!active.some(request => request.id === approval.nativeId)) {
              this.approvals.delete(requestId);
              this.onEvent({ type: "approval.resolved", turnId: approval.turnId, payload: { requestId, decision: "external", status: "resolved" } });
            }
            for (const request of pending ?? []) if (request.sessionID === this.nativeSessionId && this.turn) this.requestPermission(request);
          }
        } else this.handleEvent(event);
      }
      if (this.streamAbort.signal.aborted) return;
      if (Date.now() - connectedAt > 10_000) attempts = 0;
      if (++attempts > 4) throw new Error("event stream disconnected");
      reconnect = true;
      this.onEvent({ type: "connection.status", payload: { status: "reconnecting" } });
      await delay(Math.min(500 * 2 ** attempts, 4_000), undefined, { signal: this.streamAbort.signal });
    }
  }

  async prompt(input: AgentPromptInput): Promise<TurnResult> {
    if (!this.client || !this.nativeSessionId || this.closed) throw new AppError("OPENCODE_NOT_READY", "OpenCode 会话未连接。", { status: 409 });
    if (this.turn) throw new AppError("AGENT_TURN_ACTIVE", "当前会话已有运行中的任务。", { status: 409 });
    const requestedModel = input.model || this.catalog?.model;
    if (requestedModel && !this.catalog?.models.some((model) => model.id === requestedModel)) this.catalog = await readOpenCodeCatalog(this.client, requestedModel);
    const modelId = requestedModel ? resolveOpenCodeModelId(this.catalog?.models ?? [], requestedModel) : undefined;
    const model = this.catalog?.models.find((m) => m.id === modelId);
    if (!model) throw new AppError("OPENCODE_MODEL_UNAVAILABLE", "所选模型不在 OpenCode 已配置的模型列表中。", { status: 422 });
    if (input.reasoningEffort && !model.reasoningEfforts.includes(input.reasoningEffort)) throw new AppError("OPENCODE_VARIANT_UNAVAILABLE", "所选模型不支持该推理强度。", { status: 422 });
    const split = model.id.indexOf("/");
    const userMessageId = `msg_${Date.now().toString(16).padStart(12, "0")}${randomBytes(8).toString("hex")}`;
    this.userTurns.set(userMessageId, input.turnId);
    let resolve!: PendingTurn["resolve"], reject!: PendingTurn["reject"];
    const result = new Promise<TurnResult>((accept, fail) => { resolve = accept; reject = fail; });
    const turn: PendingTurn = { id: input.turnId, userMessageId, cancelled: false, accepted: false, resolve, reject, requestAbort: new AbortController() };
    this.turn = turn;
    // Attach a rejection handler before the HTTP request can fail.
    void result.catch(() => {});
    this.onEvent({ type: "turn.native-linked", turnId: input.turnId, payload: { nativeMessageId: userMessageId } });
    try {
      const images = await promptImages(input.content);
      if (this.turn !== turn) return await result;
      if (turn.cancelled) { this.settle({ stopReason: "cancelled" }); return await result; }
      const parts: Array<TextPartInput | FilePartInput> = [
        ...(input.content ?? []).filter(part => part.type !== "image").map((part) => ({ type: "text" as const, text: part.text ?? JSON.stringify(part.resource ?? part) })),
        ...images.map(image => ({ type: "file" as const, mime: image.mimeType, filename: image.name, url: `data:${image.mimeType};base64,${image.data}` })),
      ];
      await this.client.session.promptAsync({ sessionID: this.nativeSessionId, messageID: userMessageId,
        model: { providerID: model.id.slice(0, split), modelID: model.id.slice(split + 1) },
        variant: input.reasoningEffort || undefined, system: this.instructions || undefined, parts }, { signal: turn.requestAbort.signal });
      if (this.turn === turn) {
        turn.accepted = true;
        if (turn.cancelled) this.cancel();
      }
      // The native turn may have finished before prompt_async returned.
      await this.reconcile();
    } catch (error) { if (this.turn === turn) this.settle(undefined, nativeError(error)); }
    return result;
  }

  private handleEvent(event: Event): void {
    if (this.closed) return;
    const properties = event.properties;
    const sessionID = "sessionID" in properties ? properties.sessionID
      : event.type === "message.updated" ? event.properties.info.sessionID
      : event.type === "message.part.updated" ? event.properties.part.sessionID : null;
    if (sessionID !== this.nativeSessionId) return;
    if (event.id && this.seenEvents.has(event.id)) return;
    if (event.id) {
      this.seenEvents.add(event.id);
      if (this.seenEvents.size > 20_000) this.seenEvents.delete(this.seenEvents.values().next().value!);
    }
    const messageID = "messageID" in properties && typeof properties.messageID === "string" ? properties.messageID : event.type === "message.part.updated" ? event.properties.part.messageID : null;
    const info = event.type === "message.updated" ? event.properties.info : messageID ? this.trace.messages.get(messageID) : undefined;
    const parentID = info?.role === "assistant" ? info.parentID : info?.id;
    const localTurnId = parentID ? this.userTurns.get(parentID) ?? (parentID === this.turn?.userMessageId ? this.turn?.id : null) : null;
    this.eventTurnId = localTurnId;
    this.nativeEventId = event.id;
    try {
      if (event.type === "message.updated") {
        if (!localTurnId) return;
        this.trace.message(event.properties.info, true);
        if (this.turn && localTurnId === this.turn.id && event.properties.info.role === "assistant" && event.properties.info.error) {
          if (event.properties.info.error.name === "MessageAbortedError" || this.turn.cancelled) this.settle({ stopReason: "cancelled" });
          else this.settle(undefined, nativeError(event.properties.info.error));
        }
      } else if (event.type === "message.part.updated") {
        if (info && !localTurnId) return;
        this.trace.part(event.properties.part, true);
      } else if (event.type === "message.part.delta" && event.properties.field === "text") {
        if (info?.role === "assistant" && localTurnId) this.trace.delta(event.properties.partID, event.properties.delta);
      } else if (event.type === "message.part.removed") {
        this.trace.removePart(event.properties.partID);
      } else if (event.type === "message.removed") {
        this.trace.removeMessage(event.properties.messageID);
      } else if (event.type === "permission.replied") {
        for (const [id, pending] of this.approvals) if (pending.nativeId === event.properties.requestID) {
          this.approvals.delete(id);
          this.onEvent({ type: "approval.resolved", turnId: pending.turnId, payload: { requestId: id, decision: event.properties.reply === "reject" ? "reject" : "allow", optionId: event.properties.reply,
            selectedScope: event.properties.reply === "always" ? "session" : "once", status: "resolved" } });
        }
      } else if (!this.turn) return;
      else if (event.type === "permission.asked") this.requestPermission(event.properties);
      else if (event.type === "question.asked") {
        void this.client!.question.reject({ requestID: event.properties.id }).catch(error => this.settle(undefined, nativeError(error)));
        this.onEvent({ type: "agent.question.unsupported", turnId: this.turn.id, payload: { questions: event.properties.questions } });
      } else if (event.type === "session.status" && event.properties.status.type === "retry") {
        const status = event.properties.status;
        if (status.action?.reason === "free_tier_limit") {
          void this.client!.session.abort({ sessionID: this.nativeSessionId! }).catch(() => {});
          this.settle(undefined, new AppError("OPENCODE_PROVIDER_LIMIT", `OpenCode：${status.message}`, { status: 429 }));
        } else this.onEvent({ type: "turn.retrying", turnId: this.turn.id, payload: { message: status.message, attempt: status.attempt, next: status.next } });
      } else if (event.type === "session.error") {
        if (this.turn.cancelled || event.properties.error?.name === "MessageAbortedError") this.settle({ stopReason: "cancelled" });
        else this.settle(undefined, nativeError(event.properties.error));
      } else if (event.type === "session.idle" || (event.type === "session.status" && event.properties.status.type === "idle")) {
        if (this.turn.accepted) void this.reconcile().catch(error => this.settle(undefined, nativeError(error)));
      }
    } finally { this.eventTurnId = undefined; this.nativeEventId = undefined; }
  }

  private requestPermission(request: { id: string; permission: string; patterns: string[]; metadata?: Record<string, unknown>; always?: string[]; tool?: { callID: string } }): void {
    if (!this.turn || this.turn.cancelled) return;
    if ([...this.approvals.values()].some(pending => pending.nativeId === request.id)) return;
    const requestId = compactId("opencode_approval");
    this.approvals.set(requestId, { nativeId: request.id, turnId: this.turn?.id, canRemember: Boolean(request.always?.length) });
    this.onEvent({ type: "approval.requested", turnId: this.turn?.id, payload: {
      requestId, toolCallId: request.tool?.callID, toolName: request.permission, category: request.permission === "bash" ? "command" : request.permission === "edit" ? "file-change" : "tool",
      reason: `OpenCode 请求 ${request.permission} 权限`, patterns: request.patterns, rememberPatterns: request.always ?? [], input: request.metadata,
      command: typeof request.metadata?.command === "string" ? request.metadata.command : request.permission === "bash" ? request.patterns.join("\n") : undefined,
      paths: request.permission === "edit" || request.permission === "external_directory" ? request.patterns : undefined,
      options: [{ optionId: "once", kind: "allow_once", scope: "once", label: "允许本次" },
        ...(request.always?.length ? [{ optionId: "always", kind: "allow_session", scope: "session", label: "本会话允许", description: "允许下列匹配规则，仅当前 OpenCode 会话生效。", patterns: request.always }] : []),
        { optionId: "reject", kind: "reject_once", scope: "once", label: "拒绝本次" }, { optionId: "cancel", kind: "cancel", scope: "turn", label: "停止本回合" }],
    } });
  }

  async resolvePermission(requestId: string, optionId: string | null, cancelled = false): Promise<void> {
    const pending = this.approvals.get(requestId);
    if (!pending) { if (cancelled) return; throw new AppError("AGENT_APPROVAL_NOT_FOUND", "审批请求已失效。", { status: 404 }); }
    const reply = cancelled || optionId === "cancel" ? "reject" : optionId;
    if (reply !== "once" && reply !== "always" && reply !== "reject") throw new AppError("AGENT_APPROVAL_OPTION_INVALID", "无效的审批选项。", { status: 422 });
    if (reply === "always" && !pending.canRemember) throw new AppError("AGENT_APPROVAL_OPTION_INVALID", "OpenCode 未提供可记住的授权规则。", { status: 422 });
    await this.client!.permission.reply({ requestID: pending.nativeId, reply });
    this.approvals.delete(requestId);
  }

  cancel(): void {
    if (!this.turn || !this.client || !this.nativeSessionId) return;
    const turn = this.turn;
    turn.cancelled = true;
    const retire = (error: unknown) => { if (this.turn === turn) { this.settle(undefined, nativeError(error)); void this.close(); } };
    if (!turn.cancelTimer) { turn.cancelTimer = setTimeout(() => retire(new AppError("OPENCODE_CANCEL_TIMEOUT", "OpenCode 停止请求超时，运行实例已关闭。", { status: 504 })), 5_000); turn.cancelTimer.unref?.(); }
    if (!turn.accepted || turn.abortSent) return;
    turn.abortSent = true;
    void this.client.session.abort({ sessionID: this.nativeSessionId }, { signal: AbortSignal.timeout(5_000) }).then(() => {
      if (this.turn === turn && turn.accepted) this.settle({ stopReason: "cancelled" });
    }).catch(retire);
  }

  private async reconcile(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    const [{ data: messages }, { data: statuses }] = await Promise.all([
      this.client!.session.messages({ sessionID: this.nativeSessionId! }), this.client!.session.status(),
    ]);
    if (!messages || !statuses) throw new AppError("OPENCODE_SNAPSHOT_INVALID", "OpenCode 未返回消息或会话状态。", { status: 502 });
    if (this.turn !== turn) return;
    const current = messages.filter((m) => m.info.id === turn.userMessageId || (m.info.role === "assistant" && m.info.parentID === turn.userMessageId));
    // A live snapshot can overtake deltas already in transit. Replay only
    // finished messages; the final part snapshot repairs any missed suffix.
    for (const message of current) {
      if (message.info.role === "assistant" && message.info.time.completed) this.trace.replay([message]);
      else this.trace.message(message.info);
    }
    if (this.turn !== turn) return;
    const error = current.find((m) => m.info.role === "assistant" && m.info.error)?.info;
    if (error?.role === "assistant" && error.error && !turn.cancelled) { this.settle(undefined, nativeError(error.error)); return; }
    const hasUser = current.some((m) => m.info.id === turn.userMessageId);
    const idle = !statuses[this.nativeSessionId!] || statuses[this.nativeSessionId!].type === "idle";
    const hasCompletedAssistant = current.some(m => m.info.role === "assistant" && m.info.time.completed && m.info.finish !== "tool-calls");
    if (turn.accepted && hasUser && idle && (turn.cancelled || hasCompletedAssistant)) this.settle({ stopReason: turn.cancelled ? "cancelled" : current.some(m => m.info.role === "assistant" && m.info.finish === "length") ? "incomplete" : "end_turn" });
  }

  async readSnapshot({ nativeSessionId = this.nativeSessionId }: { nativeSessionId?: string | null } = {}) {
    if (!nativeSessionId) throw new AppError("OPENCODE_SESSION_NOT_FOUND", "没有找到 OpenCode 原生会话。", { status: 404 });
    let temporary: OpenCodeServer | undefined;
    try {
      const client = this.client && !this.closed ? this.client : await (temporary = new OpenCodeServer()).start(this.profile, this.cwd, {}, undefined, this.options.env);
      const [{ data: session }, { data: messages }] = await Promise.all([client.session.get({ sessionID: nativeSessionId }), client.session.messages({ sessionID: nativeSessionId })]);
      if (!session || !messages) throw new AppError("OPENCODE_SNAPSHOT_INVALID", "OpenCode 未返回会话或消息。", { status: 502 });
      if (!sameDirectory(session.directory, this.cwd)) throw new AppError("OPENCODE_SESSION_DIRECTORY_MISMATCH", "原生会话不属于当前项目目录。", { status: 409 });
      const events: OpenCodeEvent[] = [];
      let parentId: string | null = null;
      const projector = new OpenCodeTrace((event) => events.push({ ...event, payload: { ...event.payload, nativeParentId: parentId } }), () => this.userTurns.get(parentId!) ?? null);
      for (const message of messages) {
        parentId = message.info.role === "user" ? message.info.id : message.info.parentID;
        if (message.info.role === "user") events.push({ type: "user.message", turnId: this.userTurns.get(parentId) ?? null,
          payload: { nativeItemId: parentId, nativeParentId: parentId, text: message.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n") } });
        projector.replay([message]);
      }
      // Snapshots contain final records; deltas are only useful on the live stream.
      return { format: "agent-native-events.v1", syncedAt: new Date().toISOString(), events: events.filter((e) => e.type !== "assistant.message.delta" && e.type !== "reasoning.summary.delta"), native: { session, messages } };
    } catch (error) { throw nativeError(error, "AGENT_SESSION_SOURCE_NOT_FOUND"); }
    finally { await temporary?.close(); }
  }

  private settle(result?: TurnResult, error?: Error): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    clearTimeout(turn.cancelTimer);
    turn.requestAbort.abort();
    for (const [requestId, pending] of this.approvals) this.onEvent({ type: "approval.resolved", turnId: pending.turnId,
      payload: { requestId, decision: result?.stopReason === "cancelled" ? "cancelled" : "expired", status: "expired" } });
    this.approvals.clear();
    if (error) turn.reject(error); else turn.resolve(result ?? { stopReason: "cancelled" });
  }

  private onProcessExit(): void {
    if (this.closed) return;
    this.settle(undefined, new AppError("OPENCODE_PROCESS_CLOSED", "OpenCode 原生服务已结束。", { status: 502 }));
    this.onEvent({ type: "driver.process.closed", payload: { expected: false } });
    void this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.turn) this.cancel();
    this.settle({ stopReason: "cancelled" });
    this.streamAbort.abort();
    await this.server.close();
    await this.streamTask;
  }
}
