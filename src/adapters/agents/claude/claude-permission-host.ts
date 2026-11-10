import { claudePacketSchema, type ClaudeRequest, type PermissionUpdate } from "../shared/native-protocol.js";
import type { AgentApprovalOption } from "../../../domain/agents/agent-approval.js";
import { compactId } from "../../../lib/hash.js";
import { AppError } from "../../../lib/errors.js";
import { approvalToolDetails } from "../../../domain/agents/agent-approval.js";

export class ClaudePermissionHost {
  process: { send: (message: unknown) => void };
  emit: (type: string, payload: Record<string, unknown>) => void;
  remember: (updates: PermissionUpdate[]) => void;
  pending = new Map<string, { nativeId: string; request: ClaudeRequest; fingerprint: string; session: PermissionUpdate[]; persistent: PermissionUpdate[]; editMode?: PermissionUpdate }>();
  native = new Map<string, string>();
  controls = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  answers = new Map<string, { fingerprint: string; message: unknown }>();
  constructor(processRef: { send: (message: unknown) => void }, emit: (type: string, payload: Record<string, unknown>) => void, remember: (updates: PermissionUpdate[]) => void) {
    this.process = processRef; this.emit = emit; this.remember = remember;

  }

  request(request: Record<string, unknown>, timeoutMs = 60_000) {
    const request_id = compactId("host_control");
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { this.controls.delete(request_id); reject(new AppError("CLAUDE_CONTROL_TIMEOUT", "Claude Code 控制请求超时。", { status: 504 })); }, timeoutMs);
      timer.unref?.(); this.controls.set(request_id, { resolve, reject, timer });
      try { this.process.send({ type: "control_request", request_id, request }); }
      catch (error) { clearTimeout(timer); this.controls.delete(request_id); reject(error); }
    });
  }

  initialize(timeoutMs: number) { return this.request({ subtype: "initialize", supportedDialogKinds: [] }, timeoutMs); }

  consume(value: unknown) {
    const message = claudePacketSchema.parse(value);
    if (message.type === "control_response") {
      const response = message.response;
      if (!response) return true;
      const pending = this.controls.get(response.request_id);
      if (pending) {
        clearTimeout(pending.timer); this.controls.delete(response.request_id);
        if (response.subtype === "error") pending.reject(new AppError("CLAUDE_CONTROL_FAILED", String(response.error ?? "Claude 控制请求失败。"), { status: 502 }));
        else pending.resolve(response.response ?? {});
      }
      for (const request of response.pending_permission_requests ?? (Array.isArray(response.response?.pending_permission_requests) ? response.response.pending_permission_requests : [])) this.consume(request);
      return true;
    }
    if (message.type === "control_cancel_request") {
      const id = message.request_id && this.native.get(message.request_id);
      if (id) this.expire(id, "expired");
      return true;
    }
    if (message.type !== "control_request") return false;
    if (!message.request_id) return false;
    const request = message.request ?? {};
    if (request.subtype !== "can_use_tool") {
      // We do not advertise dialogs that require a dedicated native form.
      if (request.subtype !== "request_user_dialog") this.process.send({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "Unsupported host interaction" } });
      this.emit("agent.question.unsupported", { subtype: request.subtype }); return true;
    }
    if (this.native.has(message.request_id)) return true;
    const fingerprint = JSON.stringify(request);
    const answer = this.answers.get(message.request_id);
    if (answer?.fingerprint === fingerprint) { this.process.send(answer.message); return true; }
    const requestId = compactId("claude_approval");
    const nativeSuggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
    const suggestions = nativeSuggestions.filter(update =>
      update && (update.type === "addDirectories" || update.type === "addRules" && update.behavior === "allow")
      && ["session", "userSettings", "projectSettings", "localSettings"].includes(update.destination ?? ""));
    const session = suggestions.filter(update => update.destination === "session");
    const persistent = suggestions.filter(update => update.destination !== "session");
    const editMode = nativeSuggestions.find(update => update?.type === "setMode" && update.mode === "acceptEdits" && update.destination === "session");
    const patternsFor = (updates: PermissionUpdate[]) => [...new Set(updates.flatMap(update => update.type === "addRules" ? (update.rules ?? []).map(rule => `${rule.toolName}${rule.ruleContent ? `(${rule.ruleContent})` : ""}`) : update.directories ?? []))];
    const constrained = request.suppress_always_allow_rule || request.requires_user_interaction;
    const options: AgentApprovalOption[] = request.requires_user_interaction ? [] : [{ optionId: "allow_once", kind: "allow_once", scope: "once", label: "允许本次" }];
    if (!constrained && session.length) options.push({ optionId: "allow_session", kind: "allow_session", scope: "session", label: "本会话允许", description: "仅本会话中的相同规则；关闭或重新连接后可能再次询问。", patterns: patternsFor(session) });
    if (!constrained && editMode) options.push({ optionId: "allow_session_edits", kind: "allow_session", scope: "session", mode: "acceptEdits", label: "本会话自动允许编辑", description: "本会话后续的文件写入与编辑将由 Claude 自动批准，命令等其他操作仍遵循原生权限检查。关闭或重新连接后恢复原配置。" });
    if (!constrained && persistent.length) options.push({ optionId: "allow_rules", kind: "allow_always", scope: "persistent", label: "允许并保存规则", description: `保存至 ${[...new Set(persistent.map(update => update.destination))].join("、")}`, patterns: patternsFor(persistent) });
    options.push({ optionId: "reject_once", kind: "reject_once", scope: "once", label: "拒绝本次" }, { optionId: "cancel", kind: "cancel", scope: "turn", label: "停止本回合" });
    const patterns = patternsFor(suggestions);
    this.pending.set(requestId, { nativeId: message.request_id, request, fingerprint, session, persistent, editMode }); this.native.set(message.request_id, requestId);
    this.emit("approval.requested", { requestId, ...approvalToolDetails(String(request.tool_name ?? "Tool"), request.input ?? {}),
      toolCallId: request.tool_use_id, agentId: request.agent_id, title: request.title ?? request.display_name,
      reason: request.requires_user_interaction ? "此请求需要 Agent 的专用交互界面，不能在这里直接批准。" : request.description ?? request.decision_reason,
      paths: request.blocked_path ? [request.blocked_path] : approvalToolDetails(String(request.tool_name ?? "Tool"), request.input ?? {}).paths,
      rememberPatterns: patterns, defaultToNo: Boolean(request.default_to_no), options });
    return true;
  }

  resolve(requestId: string, optionId: string | null, cancelled = false) {
    const pending = this.pending.get(requestId);
    if (!pending) { if (cancelled) return; throw new AppError("AGENT_APPROVAL_NOT_FOUND", "Claude 审批请求已失效。", { status: 404 }); }
    const allow = !cancelled && ["allow_once", "allow_session", "allow_session_edits", "allow_rules"].includes(optionId ?? "");
    if (allow && pending.request.requires_user_interaction) throw new AppError("AGENT_APPROVAL_OPTION_INVALID", "此工具需要专用交互界面。", { status: 422 });
    const updates = optionId === "allow_session" ? pending.session : optionId === "allow_session_edits" ? pending.editMode ? [pending.editMode] : [] : optionId === "allow_rules" ? pending.persistent : [];
    if (allow && optionId !== "allow_once" && (!updates.length || pending.request.suppress_always_allow_rule)) throw new AppError("AGENT_APPROVAL_OPTION_INVALID", "Claude 未提供该授权范围。", { status: 422 });
    if (!allow && !cancelled && !["reject_once", "cancel"].includes(optionId ?? "")) throw new AppError("AGENT_APPROVAL_OPTION_INVALID", "无效的 Claude 审批选项。", { status: 422 });
    const response = allow ? { behavior: "allow", updatedInput: pending.request.input, toolUseID: pending.request.tool_use_id, ...(updates.length ? { updatedPermissions: updates } : {}) }
      : { behavior: "deny", message: cancelled || optionId === "cancel" ? "用户停止了本回合。" : "用户拒绝了本次操作。", toolUseID: pending.request.tool_use_id, interrupt: cancelled || optionId === "cancel" };
    const message = { type: "control_response", response: { subtype: "success", request_id: pending.nativeId, response } };
    this.process.send(message);
    if (allow && ["allow_session", "allow_session_edits"].includes(optionId ?? "")) this.remember(updates);
    this.answers.set(pending.nativeId, { fingerprint: pending.fingerprint, message });
    if (this.answers.size > 256) this.answers.delete(this.answers.keys().next().value!);
    this.pending.delete(requestId); this.native.delete(pending.nativeId);
  }

  expire(requestId: string, decision: string) {
    const pending = this.pending.get(requestId); if (!pending) return;
    this.pending.delete(requestId); this.native.delete(pending.nativeId);
    this.emit("approval.resolved", { requestId, decision, status: decision });
  }

  finish(decision = "expired") { for (const id of [...this.pending.keys()]) this.expire(id, decision); }
  close() {
    this.finish();
    for (const pending of this.controls.values()) { clearTimeout(pending.timer); pending.reject(new AppError("AGENT_PROCESS_CLOSED", "Claude 运行实例已结束。", { status: 409 })); }
    this.controls.clear();
  }
}
