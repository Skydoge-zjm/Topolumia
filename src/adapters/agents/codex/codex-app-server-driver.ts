import { AppError } from "../../../lib/errors.js";
import { codexMcpConfig } from "../../../agent/research-mcp-binding.js";
import { codexReasoningParts } from "./codex-reasoning.js";
import { AgentDriver, errorFromMessage, normalizeStopReason } from "../shared/agent-driver.js";
import { JsonlProcess } from "../shared/jsonl-process.js";
import { codexApproval } from "./codex-approvals.js";
import { codexConfigurationArgs } from "../../../services/agents/configuration/native-format.js";
import { mergeNativeConfig } from "../shared/native-config.js";

const CODEX_CLIENT_VERSION = "0.1.0";

function isCodexToolItem(item) {
  const type = String(item?.type ?? "").toLowerCase();
  return ["commandexecution", "filechange", "mcptoolcall", "dynamictoolcall", "collabagenttoolcall", "subagentactivity", "websearch", "imageview", "imagegeneration"].includes(type);
}

function codexToolStatus(value) {
  const status = String(value ?? "").toLowerCase();
  if (["failed", "declined", "error"].includes(status)) return "failed";
  return "completed";
}

async function readCodexHistory(processRef, threadId) {
  const thread = await processRef.request("thread/read", { threadId }, 60_000);
  const readPages = async (method, options) => {
    const data = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await processRef.request(method, { threadId, sortDirection: "asc", ...options, ...(cursor ? { cursor } : {}) }, 60_000);
      data.push(...(page.data ?? []));
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw errorFromMessage("CODEX_HISTORY_CURSOR_REPEATED", "Codex 历史分页游标重复，未完成同步。");
      if (cursor) cursors.add(cursor);
      if (cursors.size > 10_000) throw errorFromMessage("CODEX_HISTORY_PAGE_LIMIT", "Codex 历史分页超出限制，未完成同步。");
    } while (cursor);
    return { data, nextCursor: null };
  };
  const turns = await readPages("thread/turns/list", { limit: 100, itemsView: "full" });
  const items = await readPages("thread/items/list", { limit: 1_000 });
  return { thread, turns, items, syncedAt: new Date().toISOString() };
}

export class CodexAppServerDriver extends AgentDriver {
  constructor(profile, options = {}) {
    super(profile, options);
    this.pendingApprovals = new Map();
    this.itemDetails = new Map();
    this.itemTypes = new Map();
    this.turnWait = null;
    this.cancelRequested = false;
    this.nativeTurns = new Map();
    this.pendingTurnEvents = [];
  }

  async start({ cwd, developerInstructions = null, resumeThreadId = null, researchMcp = null } = {}) {
    this.cwd = cwd ?? process.cwd();
    this.process = new JsonlProcess({
      command: this.profile.command,
      args: [...(this.profile.args ?? ["app-server", "--listen", "stdio://"]), ...codexConfigurationArgs(this.profile.nativeConfig)],
      cwd: this.cwd,
      env: this.environment,
      label: this.profile.label,
      requestTimeoutMs: this.requestTimeoutMs,
      onMessage: (message) => this.#onMessage(message),
      onClose: (detail) => this.#onClose(detail),
    });
    await this.process.start();
    const initialized = await this.process.request("initialize", {
      clientInfo: { name: "research-workbench", title: "Topolumia", version: CODEX_CLIENT_VERSION },
      capabilities: { experimentalApi: false },
    }, 60_000);
    this.process.notify("initialized", {});
    const config = mergeNativeConfig(this.profile.nativeConfig, { shell_environment_policy: { set: this.environment } });
    if (researchMcp) config.mcp_servers = { ...config.mcp_servers, [researchMcp.name]: codexMcpConfig(researchMcp) };
    const policy = this.profile.nativeConfig ? {
      ...(this.profile.approvalPolicy !== undefined ? { approvalPolicy: this.profile.approvalPolicy } : {}),
      ...(!config.default_permissions && this.profile.sandbox !== undefined ? { sandbox: this.profile.sandbox } : {}),
    } : { approvalPolicy: this.profile.approvalPolicy ?? "on-request", sandbox: this.profile.sandbox ?? "workspace-write" };
    const instructions = [this.profile.nativeConfig?.developer_instructions, developerInstructions].filter(Boolean).join("\n\n");
    const started = resumeThreadId
      ? await this.process.request("thread/resume", { threadId: resumeThreadId, cwd: this.cwd,
        model: this.profile.model ?? null, ...policy,
        ...(config ? { config } : {}), ...(instructions ? { developerInstructions: instructions } : {}) }, 60_000)
      : await this.process.request("thread/start", {
        cwd: this.cwd,
        model: this.profile.model ?? null,
        ...policy,
        ephemeral: this.profile.ephemeral ?? false,
        serviceName: "topolumia",
        ...(config ? { config } : {}),
        ...(instructions ? { developerInstructions: instructions } : {}),
      }, 60_000);
    this.nativeSessionId = started?.thread?.id ?? started?.thread?.sessionId ?? null;
    if (!this.nativeSessionId) {
      throw errorFromMessage("CODEX_THREAD_START_FAILED", "Codex app-server 没有返回 thread id。", {}, 502);
    }
    this.agentInfo = {
      name: "codex",
      title: this.profile.label,
      version: initialized?.userAgent ?? null,
    };
    this.capabilities = {
      protocol: "codex-app-server",
      promptCapabilities: { embeddedContext: true },
      session: { resume: true, close: true, sync: true },
      stream: true,
      cancel: true,
      approval: { interactive: this.profile.approvalPolicy !== "never", policy: this.profile.approvalPolicy ?? "on-request", command: true, fileChange: true, permissions: true },
    };
    this.authMethods = [];
    return {
      nativeSessionId: this.nativeSessionId,
      capabilities: this.capabilities,
      agentInfo: this.agentInfo,
      authMethods: this.authMethods,
    };
  }

  async readSnapshot() {
    if (!this.process || this.process.closed || !this.nativeSessionId) throw errorFromMessage("CODEX_SESSION_NOT_STARTED", "Codex app-server session 尚未启动。", {}, 409);
    return readCodexHistory(this.process, this.nativeSessionId);
  }

  async prompt({ turnId, content, model, reasoningEffort }) {
    if (!this.process || this.process.closed || !this.nativeSessionId) {
      throw errorFromMessage("CODEX_SESSION_NOT_STARTED", "Codex app-server session 尚未启动。", {}, 409);
    }
    if (this.turnWait) throw errorFromMessage("AGENT_TURN_ALREADY_RUNNING", "Codex 当前已有运行中的 turn。", {}, 409);
    this.activeTurnId = turnId;
    this.cancelRequested = false;
    this.nativeTurnId = null;
    this.pendingTurnEvents = [];
    const completion = new Promise((resolve, reject) => {
      this.turnWait = { turnId, resolve, reject };
    });
    void completion.catch(() => {});
    try {
      const started = await this.process.request("turn/start", {
        threadId: this.nativeSessionId,
        input: [
          ...(this.contextText(content) ? [{ type: "text", text: this.contextText(content) }] : []),
          ...(content ?? []).filter(part => part.type === "image").map(part => ({ type: "localImage", path: part.path })),
        ],
        ...(model ? { model } : {}),
        ...((reasoningEffort ?? this.profile.reasoningEffort) ? { effort: reasoningEffort ?? this.profile.reasoningEffort } : {}),
      }, 60_000);
      this.nativeTurnId = started?.turn?.id ?? null;
      if (!this.nativeTurnId) throw errorFromMessage("CODEX_TURN_ID_MISSING", "Codex 没有返回原生回合 ID。");
      this.nativeTurns.set(this.nativeTurnId, turnId);
      this.emit("turn.native-linked", { nativeTurnId: this.nativeTurnId }, turnId);
      const pending = this.pendingTurnEvents;
      this.pendingTurnEvents = [];
      for (const event of pending) this.#onMessage(event);
      if (this.cancelRequested && this.turnWait) this.cancel();
      return await completion;
    } catch (error) {
      if (this.cancelRequested) { this.#settleTurn({ stopReason: "cancelled" }); return await completion; }
      this.#settleTurn(null, error);
      throw error;
    } finally {
      if (this.activeTurnId === turnId) this.activeTurnId = null;
    }
  }

  cancel() {
    if (!this.process || !this.nativeSessionId || !this.turnWait) return;
    this.cancelRequested = true;
    const wait = this.turnWait;
    const forceStop = () => {
      if (this.turnWait !== wait || this.closed) return;
      this.closed = true;
      void this.process.kill().finally(() => { if (this.turnWait === wait) this.#settleTurn({ stopReason: "cancelled" }); });
    };
    if (!wait.cancelTimer) { wait.cancelTimer = setTimeout(forceStop, 5_000); wait.cancelTimer.unref?.(); }
    // turn/start can still be in flight. Its response calls cancel again with
    // the real native turn ID; never interrupt a guessed local ID.
    if (!this.nativeTurnId || wait.interruptSent) return;
    wait.interruptSent = true;
    void this.process.request("turn/interrupt", {
      threadId: this.nativeSessionId,
      turnId: this.nativeTurnId,
    }, 5_000).catch(forceStop);
  }

  async resolvePermission(requestId, optionId, cancelled = false, selection = {}) {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) throw new AppError("AGENT_APPROVAL_NOT_FOUND", "没有找到 Codex approval 请求。", { status: 404 });
    const selectedId = cancelled ? pending.results.has("cancel") ? "cancel" : "reject_once" : optionId;
    const mapped = pending.results.get(selectedId);
    if (!mapped) throw new AppError("AGENT_APPROVAL_OPTION_INVALID", "Codex 未提供该审批选项。", { status: 422 });
    let result = structuredClone(mapped);
    if (pending.method === "item/permissions/requestApproval" && selectedId.startsWith("allow_") && selection.permissionKeys !== undefined) {
      const keys = selection.permissionKeys;
      if (!Array.isArray(keys) || !keys.length || keys.some(key => !["network", "fileSystem"].includes(key) || pending.params.permissions?.[key] == null)) throw new AppError("AGENT_APPROVAL_PERMISSION_INVALID", "所选权限不是本次请求的子集。", { status: 422 });
      result.permissions = Object.fromEntries(keys.map(key => [key, pending.params.permissions[key]]));
    }
    this.process.send({ id: pending.id, result });
    this.pendingApprovals.delete(requestId);
    return { requestId, status: "resolved" };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.process?.kill();
    if (this.turnWait) this.#settleTurn({ stopReason: "cancelled" });
  }

  #onMessage(message) {
    if (message?.method && message?.id !== undefined && message?.id !== null) {
      this.#onServerRequest(message);
      return;
    }
    const method = message?.method;
    const params = message?.params ?? {};
    if (!method) return;
    if (params.threadId && params.threadId !== this.nativeSessionId) return;
    if (method === "serverRequest/resolved") {
      for (const [id, pending] of this.pendingApprovals) if (pending.id === params.requestId) {
        this.pendingApprovals.delete(id); this.emit("approval.resolved", { requestId: id, decision: "external", status: "expired" });
      }
      return;
    }
    const nativeTurnId = params.turnId ?? params.turn?.id;
    if (nativeTurnId && !this.nativeTurns.has(nativeTurnId)) {
      if (this.turnWait && !this.nativeTurnId) this.pendingTurnEvents.push(message);
      return;
    }
    const localTurnId = nativeTurnId ? this.nativeTurns.get(nativeTurnId) : this.activeTurnId;
    if (nativeTurnId && (!this.turnWait || localTurnId !== this.turnWait.turnId)) return;
    const emit = (type, payload = {}) => this.emit(type, { nativeTurnId: nativeTurnId ?? this.nativeTurnId, ...payload }, localTurnId);
    if (method === "item/agentMessage/delta") {
      emit("assistant.message.delta", { messageId: params.itemId ?? null, nativeMessageId: params.itemId, blockId: params.itemId, delta: params.delta ?? "" });
      return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const channel = method === "item/reasoning/summaryTextDelta" ? "summary" : "content";
      emit("reasoning.summary.delta", { messageId: params.itemId ?? null, nativeItemId: params.itemId ?? null,
        channel, summaryIndex: channel === "summary" ? params.summaryIndex ?? 0 : params.contentIndex ?? 0, delta: params.delta ?? "" });
      return;
    }
    if (method === "item/plan/delta") {
      emit("plan.updated", { itemId: params.itemId ?? null, delta: params.delta ?? "", updateKind: "delta" });
      return;
    }
    if (method === "turn/plan/updated") {
      emit("plan.updated", { planId: "turn-plan", entries: params.plan ?? [], explanation: params.explanation ?? null, updateKind: "snapshot" });
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      emit("tool.updated", {
        toolCallId: params.itemId,
        kind: "commandExecution",
        delta: params.delta ?? "",
      });
      return;
    }
    if (method === "item/started") {
      const item = params.item ?? {};
      this.itemDetails.set(item.id, item);
      this.itemTypes.set(item.id, item.type);
      if (isCodexToolItem(item)) {
        emit("tool.started", { toolCallId: item.id, kind: item.type, status: item.status ?? "inProgress", item });
      }
      return;
    }
    if (method === "item/completed") {
      const item = params.item ?? {};
      this.itemDetails.set(item.id, item);
      this.itemTypes.set(item.id, item.type);
      if (String(item.type ?? "").toLowerCase() === "agentmessage") {
        // Codex can emit several agent messages inside one turn. Preserve the
        // native item boundary so the gateway and UI can place each message
        // around the tool calls that occurred between them.
        emit("assistant.message.completed", {
          messageId: item.id ?? null,
          nativeItemId: item.id ?? null,
          nativeMessageId: item.id, blockId: item.id, phase: item.phase, delivery: item.delivery,
          text: item.text ?? "",
        });
      } else if (String(item.type ?? "").toLowerCase() === "reasoning") {
        for (const part of codexReasoningParts(item)) emit("reasoning.summary.completed", {
          messageId: item.id, nativeItemId: item.id, channel: part.channel, summaryIndex: part.index, text: part.text,
        });
      } else if (String(item.type ?? "").toLowerCase() === "plan") {
        emit("plan.updated", { itemId: item.id, nativeItemId: item.id, text: item.text ?? "", updateKind: "snapshot", completion: "completed" });
      } else if (isCodexToolItem(item)) {
        const status = codexToolStatus(item.status);
        emit(status === "completed" ? "tool.completed" : "tool.failed", {
          toolCallId: item.id,
          nativeItemId: item.id ?? null,
          kind: item.type,
          status: item.status,
          item,
        });
      }
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      emit("usage.updated", { ...params, scope: "step", costScope: "session", provider: "codex" });
      return;
    }
    if (method === "turn/completed") {
      const turn = params.turn ?? {};
      this.#settleTurn({
        stopReason: this.cancelRequested ? "cancelled" : normalizeStopReason(turn.status),
        usage: turn.usage ?? null,
        nativeTurnId: turn.id ?? null,
      });
      return;
    }
    if (method === "error") {
      emit("provider.event", { kind: "error", params });
      if (params.willRetry) emit("turn.retrying", { message: params.error?.message ?? params.message ?? "Codex 正在重试。", error: params.error });
      else if (this.turnWait) this.#settleTurn(null, errorFromMessage("CODEX_TURN_FAILED", params.error?.message ?? params.message ?? "Codex turn failed.", params));
      return;
    }
    emit("provider.event", { method, params });
  }

  #onServerRequest(message) {
    const nativeTurnId = message.params?.turnId;
    if (!this.turnWait || message.params?.threadId && message.params.threadId !== this.nativeSessionId
      || nativeTurnId && this.nativeTurnId && nativeTurnId !== this.nativeTurnId
      || nativeTurnId && this.nativeTurns.has(nativeTurnId) && this.nativeTurns.get(nativeTurnId) !== this.activeTurnId) {
      this.process.send({ id: message.id, error: { code: -32600, message: "Request belongs to an inactive thread or turn" } });
      return;
    }
    const supported = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ]);
    if (!supported.has(message.method)) {
      this.process.send({ id: message.id, error: { code: -32601, message: `Client method not supported: ${message.method}` } });
      return;
    }
    if ([...this.pendingApprovals.values()].some(pending => pending.id === message.id)) return;
    const { payload, results } = codexApproval(message, this.itemDetails.get(message.params?.itemId));
    this.pendingApprovals.set(payload.requestId, { id: message.id, method: message.method, params: message.params ?? {}, results });
    this.emit("approval.requested", payload);
  }

  #onClose(detail) {
    this.emit("driver.process.closed", detail);
    if (this.turnWait && !detail.expected) {
      this.#settleTurn(null, errorFromMessage("AGENT_PROCESS_CLOSED", "Codex app-server 进程已结束。", detail));
    }
  }

  #settleTurn(result = null, error = null) {
    const wait = this.turnWait;
    if (!wait) return;
    this.turnWait = null;
    clearTimeout(wait.cancelTimer);
    for (const id of this.pendingApprovals.keys()) this.emit("approval.resolved", { requestId: id, decision: result?.stopReason === "cancelled" ? "cancelled" : "expired", status: "expired" }, wait.turnId);
    this.pendingApprovals.clear();
    if (error) wait.reject(error);
    else wait.resolve(result ?? { stopReason: "cancelled" });
  }
}

export class CodexAppServerReader {
  constructor(profile, options = {}) {
    this.profile = profile;
    this.environment = { ...(profile.env ?? {}), ...(options.env ?? {}) };
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.process = null;
  }

  async readThread({ threadId } = {}) {
    if (!threadId) throw errorFromMessage("CODEX_THREAD_REQUIRED", "需要提供 Codex native thread id。", {}, 422);
    const processRef = new JsonlProcess({
      command: this.profile.command,
      args: [...(this.profile.args ?? ["app-server", "--listen", "stdio://"]), ...codexConfigurationArgs(this.profile.nativeConfig)],
      cwd: this.profile.cwd ?? process.cwd(),
      env: this.environment,
      label: this.profile.label ?? "Codex",
      requestTimeoutMs: this.requestTimeoutMs,
    });
    this.process = processRef;
    try {
      await processRef.start();
      await processRef.request("initialize", { clientInfo: { name: "topolumia-sync", title: "Topolumia Sync", version: CODEX_CLIENT_VERSION } }, 60_000);
      processRef.notify("initialized", {});
      return await readCodexHistory(processRef, threadId);
    } finally {
      await processRef.kill();
    }
  }
}
