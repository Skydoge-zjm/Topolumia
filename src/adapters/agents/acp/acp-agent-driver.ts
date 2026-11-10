import type { AgentProfile, AgentDriverOptions, AgentStartInput, AgentStartResult, AgentPromptInput, AgentTurnResult, AgentCapabilities } from "../../../domain/agents/agent-types.js";
import { AgentDriver } from "../shared/agent-driver.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProcessCloseDetail } from "../shared/jsonl-process.js";
import * as z from "zod/v4";
const acpUpdateSchema = z.looseObject({ sessionUpdate: z.string().optional(), messageId: z.string().optional(), content: z.unknown().optional(), toolCallId: z.string().optional(), title: z.string().optional(), kind: z.string().optional(), status: z.string().optional(), locations: z.array(z.unknown()).optional(), rawInput: z.unknown().optional(), rawOutput: z.unknown().optional(), entries: z.array(z.unknown()).optional(), used: z.number().optional(), size: z.number().optional(), cost: z.unknown().optional() });
const acpMessageSchema = z.looseObject({ id: z.union([z.string(), z.number()]).nullable().optional(), method: z.string().optional(), params: z.looseObject({ update: acpUpdateSchema.optional(), toolCall: z.unknown().optional(), options: z.array(z.unknown()).optional() }).optional(), error: z.looseObject({ message: z.string().optional(), code: z.unknown().optional(), data: z.unknown().optional() }).optional(), result: z.unknown().optional() });
type AcpMessage = z.infer<typeof acpMessageSchema>;
import { spawn } from "node:child_process";
import readline from "node:readline";
import { AppError } from "../../../lib/errors.js";
import { resolveInvocation } from "../../../lib/command.js";
import { withoutResearchCredentials } from "../../../agent/research-mcp-binding.js";

function asText(value: unknown) {
  const content = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (content?.type === "text") return String(content.text ?? "");
  return "";
}

function toolEventType(status: unknown) {
  if (status === "completed") return "tool.completed";
  if (status === "failed") return "tool.failed";
  return "tool.updated";
}

export class AcpProcessDriver extends AgentDriver {
  pending = new Map<number, { method: string; resolve: (result: unknown) => void; reject: (error: unknown) => void; timer?: ReturnType<typeof setTimeout> }>();
  inboundRequests = new Map<string, { id: string | number; method: string; params?: AcpMessage["params"] }>();
  requestId: number; stderr: string; closing: boolean; instructions?: string | null;
  child!: ChildProcessWithoutNullStreams; reader?: readline.Interface;
  constructor(profile: AgentProfile, options: AgentDriverOptions = {}) {
    super(profile, options);
    this.profile = profile;
    this.environment = options.env ?? {};
    this.onEvent = options.onEvent ?? (() => {});
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;


    this.requestId = 0;
    this.stderr = "";
    this.closed = false;
    this.closing = false;
    this.capabilities = {};
    this.nativeSessionId = null;
    this.activeTurnId = null;
  }

  async start({ cwd, context = null, developerInstructions = null, resumeThreadId = null, researchMcp = null }: AgentStartInput = {}) {
    this.instructions = developerInstructions;
    const invocation = await resolveInvocation(this.profile.command, this.profile.args ?? [], { allowCmdShim: true });
    const env = { ...withoutResearchCredentials(), ...(this.profile.env ?? {}), ...this.environment };
    this.child = spawn(invocation.executable, invocation.args, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        this.child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        this.child.off("spawn", onSpawn);
        reject(new AppError("ACP_PROCESS_START_FAILED", `无法启动 ${this.profile.label}。`, {
          status: 503,
          detail: { reason: error.message, command: this.profile.command },
          retryable: true,
        }));
      };
      this.child.once("spawn", onSpawn);
      this.child.once("error", onError);
    });

    this.reader = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.reader.on("line", (line) => this.#onLine(line));
    this.child.stderr.on("data", (chunk) => {
      if (this.stderr.length < 32_768) this.stderr += chunk.toString("utf8").slice(0, 32_768 - this.stderr.length);
    });
    this.child.on("error", (error) => this.#processEnded({ error }));
    this.child.on("close", (code, signal) => this.#processEnded({ code, signal }));

    const initialized = await this.request<{ agentCapabilities?: AgentCapabilities; agentInfo?: AgentStartResult["agentInfo"]; authMethods?: unknown[] }>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: {},
        _meta: { "research-workbench/session-events": true },
      },
      clientInfo: {
        name: "research-workbench",
        title: "Topolumia",
        version: "0.1.0",
      },
    }, 30_000);
    this.capabilities = initialized?.agentCapabilities ?? {};
    this.agentInfo = initialized?.agentInfo ?? { name: this.profile.provider, title: this.profile.label };
    this.authMethods = initialized?.authMethods ?? [];

    const created = resumeThreadId
      ? await this.request<{ sessionId?: string }>("session/load", { sessionId: resumeThreadId }, 60_000)
      : await this.request<{ sessionId?: string }>("session/new", {
        cwd,
        mcpServers: researchMcp ? [{ name: researchMcp.name, command: researchMcp.command, args: researchMcp.args, env: Object.entries(researchMcp.env).map(([name, value]) => ({ name, value })) }] : [],
        _meta: context ? { "research-workbench/context-binding": context } : undefined,
      }, 60_000);
    this.nativeSessionId = resumeThreadId ?? created?.sessionId ?? null;
    if (!this.nativeSessionId) {
      throw new AppError("ACP_SESSION_ID_MISSING", `${this.profile.label} 没有返回 sessionId。`, { status: 502 });
    }
    return {
      nativeSessionId: this.nativeSessionId,
      capabilities: this.capabilities,
      agentInfo: this.agentInfo,
      authMethods: this.authMethods,
    };
  }

  async prompt({ turnId, content }: AgentPromptInput): Promise<AgentTurnResult> {
    if (!this.nativeSessionId) throw new AppError("ACP_SESSION_NOT_STARTED", "ACP session 尚未启动。", { status: 409 });
    this.activeTurnId = turnId;
    try {
      return await this.request<AgentTurnResult>("session/prompt", {
        sessionId: this.nativeSessionId,
        prompt: this.instructions ? [{ type: "text", text: this.instructions }, ...content] : content,
      }, 0);
    } finally {
      this.activeTurnId = null;
    }
  }

  cancel() {
    if (!this.nativeSessionId) return;
    this.notify("session/cancel", { sessionId: this.nativeSessionId });
  }

  async resolvePermission(requestId: string, optionId: string | null, cancelled = false) {
    const pending = this.inboundRequests.get(requestId);
    if (!pending || pending.method !== "session/request_permission") {
      throw new AppError("AGENT_APPROVAL_NOT_FOUND", "没有找到等待处理的 Agent 审批。", {
        status: 404,
        detail: { requestId },
      });
    }
    this.inboundRequests.delete(requestId);
    this.#write({
      jsonrpc: "2.0",
      id: pending.id,
      result: {
        outcome: cancelled
          ? { outcome: "cancelled" }
          : { outcome: "selected", optionId },
      },
    });
  }

  async close() {
    if (this.closed || this.closing) return;
    this.closing = true;
    try {
      if (this.nativeSessionId && this.capabilities?.sessionCapabilities?.close) {
        await this.request("session/close", { sessionId: this.nativeSessionId }, 5_000).catch(() => {});
      }
    } finally {
      this.child?.kill();
      this.reader?.close();
      this.closed = true;
    }
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new AppError("ACP_PROCESS_CLOSED", "ACP Agent 进程已经关闭。", { status: 409 }));
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError("ACP_REQUEST_TIMEOUT", `ACP 请求 ${method} 超时。`, {
          status: 504,
          detail: { method },
          retryable: true,
        }));
      }, timeoutMs) : undefined;
      timer?.unref?.();
      this.pending.set(id, { method, resolve: result => resolve(result as T), reject, timer });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    if (!this.closed) this.#write({ jsonrpc: "2.0", method, params });
  }

  #write(message: unknown) {
    if (!this.child?.stdin?.writable) {
      throw new AppError("ACP_STDIN_CLOSED", "ACP Agent 输入流不可用。", { status: 502 });
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  #onLine(line: string) {
    if (!line.trim() || this.closed) return;
    let message;
    try {
      message = acpMessageSchema.parse(JSON.parse(line));
    } catch (error) {
      this.onEvent({ type: "provider.event", payload: { kind: "protocol-error", detail: error instanceof Error ? error.message : String(error), line: line.slice(0, 500) } });
      return;
    }
    if (message.method) {
      if (message.id !== undefined && message.id !== null) this.#onServerRequest(message);
      else this.#onNotification(message.method, message.params ?? {});
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new AppError("ACP_REMOTE_ERROR", message.error.message ?? `ACP ${pending.method} failed.`, {
          status: 502,
          detail: { method: pending.method, code: message.error.code, data: message.error.data },
        }));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #onServerRequest(message: AcpMessage) {
    if (message.id == null || !message.method) return;
    if (message.method === "session/request_permission") {
      const requestId = `acp_permission_${message.id}`;
      this.inboundRequests.set(requestId, { id: message.id, method: message.method, params: message.params });
      this.onEvent({
        type: "approval.requested",
        turnId: this.activeTurnId,
        payload: {
          requestId,
          toolCall: message.params?.toolCall ?? null,
          options: message.params?.options ?? [],
        },
      });
      return;
    }
    this.#write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Client method not supported: ${message.method}` },
    });
  }

  #onNotification(method: string, params: NonNullable<AcpMessage["params"]>) {
    if (method !== "session/update") {
      this.onEvent({ type: "provider.event", turnId: this.activeTurnId, payload: { method, params } });
      return;
    }
    const update = params.update ?? {};
    const turnId = this.activeTurnId;
    if (update.sessionUpdate === "agent_message_chunk") {
      this.onEvent({
        type: "assistant.message.delta",
        turnId,
        payload: { messageId: update.messageId ?? null, delta: asText(update.content), content: update.content },
      });
      return;
    }
    if (update.sessionUpdate === "agent_thought_chunk") {
      this.onEvent({
        type: "reasoning.summary.delta",
        turnId,
        payload: { messageId: update.messageId ?? null, delta: asText(update.content) },
      });
      return;
    }
    if (update.sessionUpdate === "tool_call") {
      this.onEvent({
        type: "tool.started",
        turnId,
        payload: {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind ?? "other",
          status: update.status ?? "pending",
          content: update.content ?? [],
          locations: update.locations ?? [],
          rawInput: update.rawInput ?? null,
        },
      });
      return;
    }
    if (update.sessionUpdate === "tool_call_update") {
      this.onEvent({
        type: toolEventType(update.status),
        turnId,
        payload: {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: update.status,
          content: update.content ?? [],
          locations: update.locations ?? [],
          rawOutput: update.rawOutput ?? null,
        },
      });
      return;
    }
    if (update.sessionUpdate === "plan") {
      this.onEvent({ type: "plan.updated", turnId, payload: { entries: update.entries ?? [] } });
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      this.onEvent({ type: "usage.updated", turnId, payload: { used: update.used, size: update.size, cost: update.cost ?? null } });
      return;
    }
    this.onEvent({ type: "provider.event", turnId, payload: { method, update } });
  }

  #processEnded(detail: ProcessCloseDetail) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppError("ACP_PROCESS_CLOSED", `${this.profile.label} 进程已结束。`, {
        status: 502,
        detail: { ...detail, stderr: this.stderr.slice(-2_000) },
        retryable: true,
      }));
    }
    this.pending.clear();
    this.onEvent({ type: "driver.process.closed", turnId: this.activeTurnId, payload: { ...detail, expected: this.closing } });
  }
}
