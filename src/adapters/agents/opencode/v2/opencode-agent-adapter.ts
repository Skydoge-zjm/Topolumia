import type { OpenCodeClient, SessionMessageInfo, SessionMessageAssistant, SessionInfo } from "@opencode/client";
import { randomBytes } from "node:crypto";
import type { AgentProfile, AgentDriverOptions, AgentStartInput, AgentPromptInput, AgentTurnResult, DriverEvent } from "../../../../domain/agents/agent-types.js";
import type { AgentModelCatalog } from "../../../../domain/agents/agent-model-catalog.js";
import { AgentAdapter } from "../../shared/agent-adapter.js";
import { contentToText } from "../../shared/agent-driver.js";
import { promptImages } from "../../shared/prompt-images.js";
import { AppError } from "../../../../lib/errors.js";
import { OpenCodeV2Server, openCodeV2Error } from "./opencode-server.js";
import { readOpenCodeV2Catalog, openCodeV2ModelRef } from "./opencode-catalog.js";
import { bindOpenCodeV2Mcp } from "./opencode-mcp.js";
import { setOpenCodeV2Instructions } from "./opencode-instructions.js";
import { OpenCodeV2Permissions, openCodeV2Permissions } from "./opencode-permissions.js";
import { OpenCodeV2EventStream, type OpenCodeV2Event } from "./opencode-event-stream.js";
import { OpenCodeV2Trace } from "./opencode-trace.js";
import { readOpenCodeV2Messages, openCodeV2Parents, sameOpenCodeV2Directory } from "./opencode-history.js";

interface Options extends AgentDriverOptions { serverFactory?: () => OpenCodeV2Server }
interface Turn {
  id: string; messageID: string; accepted: boolean; cancelled: boolean; terminal?: "succeeded" | "failed" | "interrupted";
  resolve: (result: AgentTurnResult) => void; reject: (error: Error) => void; abort: AbortController;
  cancelTimer?: ReturnType<typeof setTimeout>; abortSent?: boolean;
}

export class OpenCodeV2AgentAdapter extends AgentAdapter {
  private server: OpenCodeV2Server;
  private client?: OpenCodeClient;
  private catalog?: AgentModelCatalog;
  private trace: OpenCodeV2Trace;
  private stream?: OpenCodeV2EventStream;
  private permissions?: OpenCodeV2Permissions;
  private turn?: Turn;
  private userTurns = new Map<string, string>();
  private parents = new Map<string, string>();
  private cwd: string;
  private reconcileTask?: Promise<void>;
  private reconcileAgain = false;
  private closeTask?: Promise<void>;
  nativeSessionId: string | null = null;
  closed = false;

  constructor(profile: AgentProfile, options: Options = {}) {
    super(profile, options);
    this.server = options.serverFactory?.() ?? new OpenCodeV2Server();
    this.cwd = options.cwd ?? process.cwd();
    this.trace = new OpenCodeV2Trace(event => this.emit(event));
  }

  private emit(event: DriverEvent): void {
    this.onEvent({ ...event, payload: { ...event.payload, nativeSessionId: this.nativeSessionId } });
  }

  async start(input: AgentStartInput = {}) {
    this.cwd = input.cwd ?? this.cwd;
    try {
      this.client = await this.server.start(this.profile, this.cwd, {}, () => this.retire(new Error("原生服务已退出。")), this.options.env);
      if (this.closed) throw new AppError("OPENCODE_V2_CLOSED", "OpenCode 2 会话已关闭。", { status: 409 });
      if (input.researchMcp) await bindOpenCodeV2Mcp(this.client, this.cwd, input.researchMcp);
      this.catalog = await readOpenCodeV2Catalog(this.client, this.cwd, this.profile.model ?? undefined);
      const permissions = openCodeV2Permissions(this.profile, input.researchMcp?.name);
      const session = input.resumeThreadId ? await this.client.session.get({ sessionID: input.resumeThreadId }) : await this.client.session.create({
        title: "Topolumia", location: { directory: this.cwd }, permissions,
        model: openCodeV2ModelRef(this.catalog, this.catalog.model!, this.profile.reasoningEffort),
      });
      this.validateSession(session);
      this.nativeSessionId = session.id;
      if (input.resumeThreadId) await this.client.session.update({ sessionID: session.id, permissions });
      await setOpenCodeV2Instructions(this.client, session.id, input.developerInstructions ?? "");
      this.permissions = new OpenCodeV2Permissions(this.client, session.id, event => this.emit(event));
      if (input.resumeThreadId) this.indexHistory(await readOpenCodeV2Messages(this.client, session.id));
      this.stream = new OpenCodeV2EventStream(this.client, session.id, event => this.handle(event),
        async () => { await this.reconcile(); await this.permissions?.sync(this.turn?.id ?? null); },
        error => this.retire(error), () => this.emit({ type: "connection.status", payload: { status: "reconnecting" } }));
      await this.stream.start();
      return { nativeSessionId: session.id, model: this.catalog.model,
        capabilities: { streaming: true, tools: true, permissions: true, session: { resume: true, sync: true },
          approval: { interactive: true, policy: this.profile.approvalPolicy ?? "on-request" } },
        agentInfo: { name: "OpenCode 2", version: this.server.version, transport: "opencode-v2-http-sse" }, authMethods: [] };
    } catch (error) { await this.close(); throw openCodeV2Error(error); }
  }

  private validateSession(session: SessionInfo): void {
    if (!session?.id || !session.location || !sameOpenCodeV2Directory(session.location.directory, this.cwd)) throw new AppError("OPENCODE_SESSION_DIRECTORY_MISMATCH", "OpenCode 2 原生会话不属于当前项目目录。", { status: 409 });
  }

  async prompt(input: AgentPromptInput): Promise<AgentTurnResult> {
    if (!this.client || !this.nativeSessionId || this.closed) throw new AppError("OPENCODE_NOT_READY", "OpenCode 2 会话未连接。", { status: 409 });
    if (this.turn) throw new AppError("AGENT_TURN_ACTIVE", "当前会话已有运行中的任务。", { status: 409 });
    const model = openCodeV2ModelRef(this.catalog!, input.model || this.catalog!.model!, input.reasoningEffort || this.profile.reasoningEffort);
    const messageID = `msg_${Date.now().toString(16).padStart(12, "0")}${randomBytes(8).toString("hex")}`;
    let resolve!: Turn["resolve"], reject!: Turn["reject"];
    const result = new Promise<AgentTurnResult>((accept, fail) => { resolve = accept; reject = fail; });
    void result.catch(() => {});
    const turn: Turn = { id: input.turnId, messageID, accepted: false, cancelled: false, resolve, reject, abort: new AbortController() };
    this.turn = turn; this.userTurns.set(messageID, input.turnId);
    this.emit({ type: "turn.native-linked", turnId: input.turnId, payload: { nativeMessageId: messageID } });
    let submitted = false;
    try {
      const images = await promptImages(input.content);
      if (this.turn !== turn) return result;
      if (turn.cancelled) { this.settle({ stopReason: "cancelled" }); return result; }
      await this.client.session.switchModel({ sessionID: this.nativeSessionId, model }, { signal: turn.abort.signal });
      if (turn.cancelled) { this.settle({ stopReason: "cancelled" }); return result; }
      submitted = true;
      const admitted = await this.client.session.prompt({ sessionID: this.nativeSessionId, id: messageID, text: contentToText(input.content),
        files: images.map(image => ({ uri: `data:${image.mimeType};base64,${image.data}`, source: { type: "inline" as const }, name: image.name })),
        metadata: { topolumiaTurnId: input.turnId }, delivery: "queue" }, { signal: turn.abort.signal });
      if (admitted.id !== messageID) throw new Error("原生消息标识不匹配。");
      if (this.turn === turn) { turn.accepted = true; if (turn.cancelled) this.cancel(); }
      await this.reconcile();
    } catch (error) {
      if (this.turn === turn) { this.settle(undefined, openCodeV2Error(error)); if (submitted) void this.close(); }
    }
    return result;
  }

  private handle(event: OpenCodeV2Event): void {
    if (this.closed) return;
    if (event.type === "permission.asked") { this.permissions?.asked(event.data, this.turn?.id ?? null); return; }
    if (event.type === "permission.replied") { this.permissions?.replied(event.data.requestID, event.data.reply); return; }
    if (event.type === "form.created") {
      void this.client!.session.form.cancel({ sessionID: this.nativeSessionId!, formID: event.data.form.id, message: "Topolumia 当前未提供交互问答。" }).catch(error => this.retire(error));
      this.emit({ type: "agent.question.unsupported", turnId: this.turn?.id, payload: { questions: event.data.form.fields } });
      return;
    }
    if (event.type === "session.inbox.delivered" && this.userTurns.has(event.data.inboxID)) this.parents.set("current", event.data.inboxID);
    const messageID = "assistantMessageID" in event.data && typeof event.data.assistantMessageID === "string" ? event.data.assistantMessageID
      : "messageID" in event.data && typeof event.data.messageID === "string" ? event.data.messageID : undefined;
    const parent = messageID ? this.parents.get(messageID) ?? this.parents.get("current") ?? this.turn?.messageID : this.turn?.messageID;
    if (messageID && parent) this.parents.set(messageID, parent);
    const turnId = parent ? this.userTurns.get(parent) ?? null : null;
    if (turnId) this.trace.event(event, turnId, parent);
    const turn = this.turn;
    if (!turn) return;
    if (event.type === "session.execution.failed") { this.settle(undefined, openCodeV2Error(event.data.error)); return; }
    if (event.type === "session.execution.succeeded" || event.type === "session.execution.interrupted") {
      turn.terminal = event.type === "session.execution.succeeded" ? "succeeded" : "interrupted";
      if (turn.accepted) void this.reconcile().catch(error => this.retire(error));
    }
  }

  private indexHistory(messages: SessionMessageInfo[]): Map<string, string> {
    const parents = openCodeV2Parents(messages);
    for (const message of messages) {
      if (message.type === "user" && typeof message.metadata?.topolumiaTurnId === "string") this.userTurns.set(message.id, message.metadata.topolumiaTurnId);
      const parent = parents.get(message.id); if (parent) this.parents.set(message.id, parent);
    }
    return parents;
  }

  private reconcile(): Promise<void> {
    if (this.reconcileTask) { this.reconcileAgain = true; return this.reconcileTask; }
    const pending = (async () => { do { this.reconcileAgain = false; await this.reconcileNow(); } while (this.reconcileAgain && !this.closed); })().finally(() => { if (this.reconcileTask === pending) this.reconcileTask = undefined; });
    this.reconcileTask = pending; return pending;
  }

  private async reconcileNow(): Promise<void> {
    const turn = this.turn;
    if (!turn || !this.client || !this.nativeSessionId) return;
    const [messages, active] = await Promise.all([readOpenCodeV2Messages(this.client, this.nativeSessionId), this.client.session.active()]);
    if (this.turn !== turn) return;
    const parents = this.indexHistory(messages);
    const current = messages.filter(message => parents.get(message.id) === turn.messageID);
    for (const message of current) if (message.type === "assistant" && message.time.completed) this.trace.message(message, turn.id, turn.messageID);
    const error = current.find((message): message is SessionMessageAssistant => message.type === "assistant" && Boolean(message.error));
    if (error?.error && !turn.cancelled) { this.settle(undefined, openCodeV2Error(error.error)); return; }
    const completed = current.some(message => message.type === "assistant" && message.time.completed && message.finish !== "tool-calls");
    const idle = !active[this.nativeSessionId];
    if (turn.accepted && current.some(message => message.id === turn.messageID) && idle && (completed || turn.cancelled || turn.terminal)) {
      const session = await this.client.session.get({ sessionID: this.nativeSessionId });
      if (this.turn !== turn) return;
      this.trace.session(session, turn.id);
      this.settle({ stopReason: turn.cancelled || turn.terminal === "interrupted" ? "cancelled" : current.some(message => message.type === "assistant" && message.finish === "length") ? "incomplete" : "end_turn" });
    }
  }

  async resolvePermission(requestId: string, optionId: string | null, cancelled = false): Promise<void> {
    if (!this.permissions) throw new AppError("AGENT_APPROVAL_NOT_FOUND", "审批请求已失效。", { status: 404 });
    await this.permissions.reply(requestId, optionId, cancelled);
  }

  cancel(): void {
    const turn = this.turn;
    if (!turn || !this.client || !this.nativeSessionId) return;
    turn.cancelled = true;
    if (!turn.cancelTimer) { turn.cancelTimer = setTimeout(() => this.retire(new Error("停止请求超时，运行实例已关闭。")), 5_000); turn.cancelTimer.unref?.(); }
    if (!turn.accepted || turn.abortSent) return;
    turn.abortSent = true;
    // Admission can return before execution starts. Remove any parked input before interrupting.
    const sessionID = this.nativeSessionId;
    void this.client.session.inbox.cancel({ sessionID, inboxID: turn.messageID }, { signal: AbortSignal.timeout(5_000) })
      .then(() => this.client!.session.interrupt({ sessionID }, { signal: AbortSignal.timeout(5_000) }))
      .then(() => { if (this.turn === turn) this.settle({ stopReason: "cancelled" }); }).catch(error => this.retire(error));
  }

  async readSnapshot({ nativeSessionId = this.nativeSessionId }: { nativeSessionId?: string | null } = {}) {
    if (!nativeSessionId) throw new AppError("AGENT_SESSION_SOURCE_NOT_FOUND", "没有找到 OpenCode 2 原生会话。", { status: 404 });
    let temporary: OpenCodeV2Server | undefined;
    try {
      const client = this.client && !this.closed ? this.client : await (temporary = new OpenCodeV2Server()).start(this.profile, this.cwd, {}, undefined, this.options.env);
      const [session, messages] = await Promise.all([client.session.get({ sessionID: nativeSessionId }), readOpenCodeV2Messages(client, nativeSessionId)]);
      this.validateSession(session);
      const parents = this.indexHistory(messages), events: DriverEvent[] = [];
      const trace = new OpenCodeV2Trace(event => events.push({ ...event, payload: { ...event.payload, nativeSessionId } }));
      for (const message of messages) {
        const parent = parents.get(message.id), turnId = parent ? this.userTurns.get(parent) ?? null : null;
        if (message.type === "user") events.push({ type: "user.message", turnId, payload: { nativeItemId: message.id, nativeParentId: message.id, text: message.text } });
        trace.message(message, turnId, parent);
      }
      trace.session(session, null);
      return { format: "agent-native-events.v1", syncedAt: new Date().toISOString(), events, native: { session, messages } };
    } catch (error) { throw openCodeV2Error(error); }
    finally { await temporary?.close(); }
  }

  private settle(result?: AgentTurnResult, error?: Error): void {
    const turn = this.turn; if (!turn) return;
    this.turn = undefined; clearTimeout(turn.cancelTimer); turn.abort.abort();
    this.permissions?.clear(result?.stopReason === "cancelled");
    if (error) turn.reject(error); else turn.resolve(result ?? { stopReason: "cancelled" });
  }

  private retire(error: unknown): void {
    if (this.closed) return;
    this.settle(undefined, openCodeV2Error(error));
    this.emit({ type: "driver.process.closed", payload: { expected: false } });
    void this.close();
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    const turn = this.turn;
    this.closed = true; this.settle({ stopReason: "cancelled" });
    this.closeTask = (async () => {
      if (turn?.accepted && this.client && this.nativeSessionId) {
        try {
          await this.client.session.inbox.cancel({ sessionID: this.nativeSessionId, inboxID: turn.messageID }, { signal: AbortSignal.timeout(2_000) });
          await this.client.session.interrupt({ sessionID: this.nativeSessionId }, { signal: AbortSignal.timeout(2_000) });
        } catch { /* The owned process is stopped below even if it no longer responds. */ }
      }
      await this.server.close(); await this.stream?.close();
    })();
    return this.closeTask;
  }
}
