import type { AgentProfile, AgentDriverOptions, AgentStartInput, AgentPromptInput, AgentTurnResult, ResearchMcpBinding } from "../../../domain/agents/agent-types.js";
import { claudePacketSchema } from "../shared/native-protocol.js";
import type { ProcessCloseDetail } from "../shared/jsonl-process.js";
import crypto from "node:crypto";
import { AppError } from "../../../lib/errors.js";
import { claudeTokenCounts, tokenCountDelta } from "../../../domain/agents/agent-usage.js";
import { ClaudeTrace } from "./claude-trace.js";
import { AgentDriver, errorFromMessage, normalizeStopReason } from "../shared/agent-driver.js";
import { JsonlProcess } from "../shared/jsonl-process.js";
import { ClaudePermissionHost } from "./claude-permission-host.js";
import { claudeSettingsFile } from "../shared/native-config.js";
import { promptImages } from "../shared/prompt-images.js";

export class ClaudeCliStreamDriver extends AgentDriver {
  child: JsonlProcess | null; trace: ClaudeTrace | null;
  turnWait: { turnId: string; resolve: (result: AgentTurnResult) => void; reject: (error: unknown) => void } | null;
  cancelRequested: boolean; sessionStarted: boolean;
  previousUsage: ReturnType<typeof claudeTokenCounts> | undefined; previousCost: number | undefined;
  sessionAllows: Set<string>; sessionDirectories: Set<string>; sessionPermissionMode: string | null;
  developerInstructions?: string | null; researchMcp?: ResearchMcpBinding | null; permissionHost?: ClaudePermissionHost;
  constructor(profile: AgentProfile, options: AgentDriverOptions = {}) {
    super(profile, options);
    this.child = null;
    this.turnWait = null;
    this.cancelRequested = false;
    this.sessionStarted = false;
    this.nativeSessionId = crypto.randomUUID();
    this.trace = null;
    this.previousUsage = claudeTokenCounts();
    this.previousCost = 0;
    this.sessionAllows = new Set<string>();
    this.sessionDirectories = new Set<string>();
    this.sessionPermissionMode = null;
  }

  async start({ cwd, resumeThreadId = null, developerInstructions = null, researchMcp = null }: AgentStartInput = {}) {
    this.cwd = cwd ?? process.cwd();
    this.developerInstructions = developerInstructions;
    this.researchMcp = researchMcp;
    if (resumeThreadId) {
      this.nativeSessionId = resumeThreadId;
      this.sessionStarted = true;
      this.previousUsage = undefined;
      this.previousCost = undefined;
    }
    this.agentInfo = { name: "claude-code", title: this.profile.label, version: null };
    this.capabilities = {
      protocol: "claude-cli-stream-json",
      promptCapabilities: { embeddedContext: false },
      session: { resume: true, close: true, sync: false },
      stream: true,
      cancel: true,
      approval: { interactive: !["dontAsk", "bypassPermissions"].includes(this.profile.permissionMode ?? ""), policy: this.profile.permissionMode ?? "default" },
    };
    this.authMethods = [];
    return {
      nativeSessionId: this.nativeSessionId!,
      capabilities: this.capabilities,
      agentInfo: this.agentInfo,
      authMethods: this.authMethods,
    };
  }

  async prompt({ turnId, content, model, reasoningEffort }: AgentPromptInput): Promise<AgentTurnResult> {
    if (this.closed) throw errorFromMessage("CLAUDE_SESSION_CLOSED", "Claude Code session 已关闭。", {}, 409);
    if (this.turnWait) throw errorFromMessage("AGENT_TURN_ALREADY_RUNNING", "Claude 当前已有运行中的 turn。", {}, 409);
    this.activeTurnId = turnId;
    this.cancelRequested = false;
    this.trace = new ClaudeTrace((type, payload) => this.emit(type, payload, turnId), turnId);
    const args = [
      ...(this.profile.launcherArgs ?? []),
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--permission-prompt-tool=stdio",
      "--verbose",
      "--include-partial-messages",
      ...((this.sessionPermissionMode ?? this.profile.permissionMode) ? ["--permission-mode", this.sessionPermissionMode ?? this.profile.permissionMode!] : this.profile.nativeConfig ? [] : ["--permission-mode", "default"]),
      "--allowed-tools", [...new Set([...(this.profile.nativeConfig ? [] : this.profile.allowedTools ?? ["Read", "Grep", "Glob"]), ...(this.researchMcp ? ["mcp__topolumia__*"] : [])])].join(","),
    ];
    const settingsFile = await claudeSettingsFile(this.profile, this.sessionAllows);
    if (settingsFile) args.push("--settings", settingsFile);
    else if (this.sessionAllows.size) args.push("--settings", JSON.stringify({ permissions: { allow: [...this.sessionAllows] } }));
    for (const directory of this.sessionDirectories) args.push("--add-dir", directory);
    if (this.researchMcp) args.push("--mcp-config", JSON.stringify({ mcpServers: { [this.researchMcp.name]: { type: "stdio", command: this.researchMcp.command, args: this.researchMcp.args, env: this.researchMcp.env, cwd: this.researchMcp.cwd } } }));
    const selectedModel = model ?? this.profile.model;
    const selectedEffort = reasoningEffort ?? this.profile.reasoningEffort;
    if (selectedModel) args.push("--model", selectedModel);
    if (selectedEffort) args.push("--effort", selectedEffort);
    if (this.developerInstructions) args.push("--append-system-prompt", this.developerInstructions);
    if (this.sessionStarted) args.push("--resume", this.nativeSessionId!);
    else args.push("--session-id", this.nativeSessionId!);
    args.push(...(this.profile.extraArgs ?? []));
    const completion = new Promise<AgentTurnResult>((resolve, reject) => {
      this.turnWait = { turnId, resolve, reject };
    });
    void completion.catch(() => {});
    // Each turn owns one short-lived Claude CLI process. Capture that process
    // in the callbacks so a late close event from the previous turn cannot
    // clear or settle the process that has already started for the next turn.
    const processRef: JsonlProcess = new JsonlProcess({
      command: this.profile.command,
      args,
      cwd: this.cwd,
      env: this.environment,
      label: this.profile.label,
      requestTimeoutMs: this.requestTimeoutMs,
      onMessage: (message) => this.#onMessage(message, processRef),
      onClose: (detail) => this.#onClose(detail, processRef),
    });
    this.child = processRef;
    const host = new ClaudePermissionHost(processRef, (type, payload) => {
      this.emit(type, payload, turnId);
    }, updates => {
      for (const update of updates) {
        if (update.type === "addRules") for (const rule of update.rules ?? []) if (typeof rule.toolName === "string") this.sessionAllows.add(`${rule.toolName}${rule.ruleContent ? `(${rule.ruleContent})` : ""}`);
        if (update.type === "addDirectories") for (const directory of update.directories ?? []) if (typeof directory === "string") this.sessionDirectories.add(directory);
        if (update.type === "setMode" && update.mode === "acceptEdits" && update.destination === "session") this.sessionPermissionMode = "acceptEdits";
      }
    });
    this.permissionHost = host;
    try {
      await processRef.start();
      if (this.cancelRequested) { this.#settleTurn({ stopReason: "cancelled" }); return { stopReason: "cancelled" }; }
      const initialized = await host.initialize(Math.min(this.requestTimeoutMs, 60_000));
      this.agentInfo = { ...this.agentInfo, version: typeof initialized.claude_code_version === "string" ? initialized.claude_code_version : this.agentInfo.version };
      if (this.cancelRequested) { this.#settleTurn({ stopReason: "cancelled" }); return { stopReason: "cancelled" }; }
      const images = await promptImages(content);
      if (this.cancelRequested) { this.#settleTurn({ stopReason: "cancelled" }); return { stopReason: "cancelled" }; }
      processRef.send({ type: "user", session_id: this.nativeSessionId, message: { role: "user", content: [
        ...images.map(image => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } })),
        ...(this.contextText(content) ? [{ type: "text", text: this.contextText(content) }] : []),
      ] }, parent_tool_use_id: null });
      return await completion;
    } catch (error) {
      if (this.cancelRequested) { this.#settleTurn({ stopReason: "cancelled" }); return { stopReason: "cancelled" }; }
      this.#settleTurn(null, error);
      throw error;
    } finally {
      host.finish(this.cancelRequested ? "cancelled" : "expired");
      await processRef.kill();
      host.close();
      if (this.activeTurnId === turnId) this.activeTurnId = null;
    }
  }

  cancel() {
    if (!this.child || !this.turnWait) return;
    this.cancelRequested = true;
    void this.permissionHost?.request({ subtype: "interrupt", cancel_async_messages: true }, 5_000).catch(() => {});
    const processRef = this.child;
    const timer = setTimeout(() => {
      if (this.child !== processRef || !this.turnWait) return;
      this.trace?.finish("interrupted"); this.#settleTurn({ stopReason: "cancelled" }); void processRef.kill();
    }, 1500);
    timer.unref?.();
  }

  async resolvePermission(requestId: string, optionId: string | null, cancelled = false) {
    if (!this.permissionHost && !cancelled) throw new AppError("AGENT_APPROVAL_NOT_FOUND", "Claude 审批请求已失效。", { status: 404 });
    this.permissionHost?.resolve(requestId, optionId, cancelled);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.turnWait) this.trace?.finish("interrupted");
    if (this.turnWait) this.#settleTurn({ stopReason: "cancelled" });
    await this.child?.kill();
  }

  #onMessage(value: unknown, processRef: JsonlProcess) {
    if (this.child !== processRef) return;
    const parsed = claudePacketSchema.safeParse(value);
    if (!parsed.success) {
      this.emit("provider.event", { kind: "protocol-error", detail: parsed.error.message });
      return;
    }
    const message = parsed.data;
    if (this.permissionHost?.consume(message)) return;
    const type = message?.type;
    if (this.trace?.consume(message)) return;
    if (type === "system") {
      if (message.subtype === "init") {
        if (message.session_id) this.nativeSessionId = message.session_id;
        this.sessionStarted = true;
        this.agentInfo = { ...this.agentInfo, version: message.claude_code_version ?? message.version ?? null };
        this.emit("provider.event", { kind: "init", sessionId: this.nativeSessionId, capabilities: message.capabilities ?? [] });
      } else if (message.subtype === "api_retry") {
        this.emit("turn.retrying", { message: message.error?.message ?? "Claude Code 正在重试。", attempt: message.attempt, maxRetries: message.max_retries, error: message.error });
      } else this.emit("provider.event", { kind: message.subtype ?? "system", message });
      return;
    }
    if (type === "result") {
      this.permissionHost?.finish(this.cancelRequested ? "cancelled" : "expired");
      if (message.usage) {
        const total = claudeTokenCounts(message.usage);
        const last = tokenCountDelta(total, this.previousUsage);
        this.emit("usage.updated", { provider: "claude", scope: "session", lastScope: last ? "turn" : null,
          tokenUsage: { total, ...(last ? { last } : {}) }, cost: message.total_cost_usd ?? null, costScope: "session",
          turnCost: this.previousCost === undefined || message.total_cost_usd === undefined || message.total_cost_usd < this.previousCost ? null : message.total_cost_usd - this.previousCost,
          nativeUsage: message.usage, nativeModelUsage: message.modelUsage });
        this.previousUsage = total;
        this.previousCost = message.total_cost_usd;
      }
      processRef.expectedClose = true;
      if (this.cancelRequested) {
        this.trace?.finish("interrupted"); this.#settleTurn({ stopReason: "cancelled" });
      } else if (message.subtype !== "success" || message.is_error) {
        this.trace?.finish("failed");
        const joined = (Array.isArray(message.errors) ? message.errors.join("; ") : "") || String(message.result ?? "Claude Code 执行失败。");
        const auth = /auth|login|credential|api key|unauthorized|logged in/i.test(joined);
        this.#settleTurn(null, errorFromMessage(auth ? "AGENT_AUTH_REQUIRED" : "CLAUDE_TURN_FAILED", joined, { subtype: message.subtype }, auth ? 503 : 502));
      } else {
        const incomplete = ["max_tokens", "length"].includes(message.stop_reason ?? "");
        this.trace?.finish(this.cancelRequested ? "interrupted" : incomplete ? "incomplete" : "completed");
        this.#settleTurn({ stopReason: this.cancelRequested ? "cancelled" : incomplete ? "incomplete" : normalizeStopReason(message.stop_reason),
          usage: message.usage, cost: message.total_cost_usd, nativeSessionId: message.session_id ?? this.nativeSessionId });
      }
      return;
    }
    if (type === "rate_limit_event") this.emit("provider.event", { kind: "rate_limit", info: message.rate_limit_info ?? null });
    else this.emit("provider.event", { kind: "claude-message", message });
  }

  #onClose(detail: ProcessCloseDetail, processRef: JsonlProcess) {
    const isCurrentProcess = this.child === processRef;
    if (isCurrentProcess) this.permissionHost?.close();
    // A previous turn may close after the next turn has already started. It
    // remains observable, but must never make the current Gateway session
    // fail, so stale process closes are explicitly marked as expected.
    this.emit("driver.process.closed", {
      ...detail,
      expected: !isCurrentProcess || detail.expected || this.cancelRequested,
      stale: !isCurrentProcess,
    });
    if (isCurrentProcess && this.turnWait && !this.cancelRequested && !detail.expected) {
      this.trace?.finish("failed");
      this.#settleTurn(null, errorFromMessage("AGENT_PROCESS_CLOSED", "Claude Code 进程已结束。", detail));
    }
    if (isCurrentProcess && this.turnWait && this.cancelRequested) this.#settleTurn({ stopReason: "cancelled" });
    if (isCurrentProcess) this.child = null;
  }

  #settleTurn(result: AgentTurnResult | null = null, error: unknown = null) {
    const wait = this.turnWait;
    if (!wait) return;
    this.turnWait = null;
    if (error) wait.reject(error);
    else wait.resolve(result ?? { stopReason: "cancelled" });
  }
}
