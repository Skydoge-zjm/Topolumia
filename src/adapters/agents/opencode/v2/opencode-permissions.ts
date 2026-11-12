import type { OpenCodeClient, PermissionRequest, PermissionRuleset } from "@opencode/client";
import type { AgentProfile, DriverEvent } from "../../../../domain/agents/agent-types.js";
import { compactId } from "../../../../lib/hash.js";
import { AppError } from "../../../../lib/errors.js";
import { initialOpenCodeV2Config, openCodeV2Rules } from "./opencode-native-config.js";

export function openCodeV2Permissions(profile: AgentProfile, mcpName?: string): PermissionRuleset {
  const rules = openCodeV2Rules(profile.nativeConfig ?? initialOpenCodeV2Config(profile));
  const mcpDenied = mcpName && rules.some(rule => rule.effect === "deny" && (rule.action.startsWith(`${mcpName}_`) || /[*?]/.test(rule.action)));
  return [...rules, ...(mcpName && !mcpDenied ? [{ action: `${mcpName}_*`, resource: "*", effect: "allow" as const }] : []),
    ...(profile.sandbox === "read-only" ? [{ action: "edit", resource: "*", effect: "deny" as const }, { action: "shell", resource: "*", effect: "ask" as const }] : [])];
}

export class OpenCodeV2Permissions {
  private pending = new Map<string, { native: PermissionRequest; turnId: string | null }>();
  constructor(private client: OpenCodeClient, private sessionID: string, private emit: (event: DriverEvent) => void) {}

  asked(request: PermissionRequest, turnId: string | null): void {
    if (request.sessionID !== this.sessionID || [...this.pending.values()].some(value => value.native.id === request.id)) return;
    const requestId = compactId("opencode_v2_approval");
    this.pending.set(requestId, { native: request, turnId });
    const command = request.action === "shell";
    this.emit({ type: "approval.requested", turnId, payload: {
      requestId, toolCallId: request.source?.id, toolName: request.action, cwd: undefined,
      category: command ? "command" : request.action === "edit" ? "file-change" : "tool",
      reason: request.message ?? `OpenCode 2 请求 ${request.action} 权限`, patterns: request.resources, rememberPatterns: request.save ?? [], input: request.metadata,
      command: command ? String(request.metadata?.command ?? request.resources.join("\n")) : undefined,
      paths: ["edit", "external_directory"].includes(request.action) ? request.resources : undefined,
      options: [{ optionId: "once", kind: "allow_once", scope: "once", label: "允许本次" },
        ...(request.save?.length ? [{ optionId: "always", kind: "allow_always", scope: "persistent", label: "允许并保存到项目", description: "保存为项目级授权规则，后续会话也会生效。", patterns: request.save }] : []),
        { optionId: "reject", kind: "reject_once", scope: "once", label: "拒绝本次", description: "拒绝此会话中所有待处理的原生权限请求。" },
        { optionId: "cancel", kind: "cancel", scope: "turn", label: "停止本回合" }],
    } });
  }

  replied(requestID: string, reply: string): void {
    for (const [id, pending] of this.pending) if (pending.native.id === requestID) {
      this.pending.delete(id);
      this.emit({ type: "approval.resolved", turnId: pending.turnId, payload: { requestId: id, decision: reply === "reject" ? "reject" : "allow", optionId: reply,
        selectedScope: reply === "always" ? "persistent" : "once", status: "resolved" } });
    }
  }

  async reply(requestId: string, optionId: string | null, cancelled = false): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) { if (cancelled) return; throw new AppError("AGENT_APPROVAL_NOT_FOUND", "审批请求已失效。", { status: 404 }); }
    const decision = cancelled || optionId === "cancel" ? "reject" : optionId;
    if (!["once", "always", "reject"].includes(decision ?? "") || decision === "always" && !pending.native.save?.length) throw new AppError("AGENT_APPROVAL_OPTION_INVALID", "无效的审批选项。", { status: 422 });
    await this.client.permission.reply({ sessionID: this.sessionID, requestID: pending.native.id, decision: decision as "once" | "always" | "reject" });
    this.replied(pending.native.id, decision!);
    await this.sync(pending.turnId);
  }

  async sync(turnId: string | null): Promise<void> {
    const active = await this.client.permission.list({ sessionID: this.sessionID });
    for (const [id, pending] of this.pending) if (!active.some(request => request.id === pending.native.id)) {
      this.pending.delete(id);
      this.emit({ type: "approval.resolved", turnId: pending.turnId, payload: { requestId: id, decision: "external", status: "resolved" } });
    }
    for (const request of active) this.asked(request, turnId);
  }

  clear(cancelled: boolean): void {
    for (const [requestId, pending] of this.pending) this.emit({ type: "approval.resolved", turnId: pending.turnId, payload: { requestId, decision: cancelled ? "cancelled" : "expired", status: "expired" } });
    this.pending.clear();
  }
}
