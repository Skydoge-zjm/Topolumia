import type { CodexMessage, CodexItem } from "../shared/native-protocol.js";
import { compactId } from "../../../lib/hash.js";
import type { AgentApproval, AgentApprovalOption } from "../../../domain/agents/agent-approval.js";

export function codexApproval(message: CodexMessage, item: CodexItem = {}) {
  const p = message.params ?? {};
  const requestId = compactId("codex_approval");
  const permissions = message.method === "item/permissions/requestApproval";
  const files = message.method === "item/fileChange/requestApproval";
  const network = p.networkApprovalContext;
  const results = new Map<string, { decision?: unknown; permissions?: Record<string, unknown>; scope?: string }>();
  const options: AgentApprovalOption[] = [];
  const add = (option: AgentApprovalOption, result: { decision?: unknown; permissions?: Record<string, unknown>; scope?: string }) => { options.push(option); results.set(option.optionId, result); };
  if (permissions) {
    add({ optionId: "allow_once", kind: "allow_once", scope: "turn", label: "允许本回合" }, { permissions: p.permissions ?? {}, scope: "turn" });
    add({ optionId: "allow_session", kind: "allow_session", scope: "session", label: "本会话允许" }, { permissions: p.permissions ?? {}, scope: "session" });
    add({ optionId: "reject_once", kind: "reject_once", scope: "once", label: "拒绝本次" }, { permissions: {}, scope: "turn" });
    add({ optionId: "cancel", kind: "cancel", scope: "turn", label: "停止本回合" }, { permissions: {}, scope: "turn" });
  } else {
    const decisions = Array.isArray(p.availableDecisions) ? p.availableDecisions : ["accept", "acceptForSession", "decline", "cancel",
      ...(p.proposedExecpolicyAmendment ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: p.proposedExecpolicyAmendment } }] : []),
      ...(p.proposedNetworkPolicyAmendments ?? []).map(amendment => ({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } }))];
    for (const [index, decision] of decisions.entries()) {
      if (decision === "accept") add({ optionId: "allow_once", kind: "allow_once", scope: "once", label: "允许本次" }, { decision });
      else if (decision === "acceptForSession") add({ optionId: "allow_session", kind: "allow_session", scope: "session", label: "本会话允许", description: "由 Codex 缓存相同命令或文件的授权，不写入永久规则。" }, { decision });
      else if (decision === "decline") add({ optionId: "reject_once", kind: "reject_once", scope: "once", label: "拒绝本次" }, { decision });
      else if (decision === "cancel") add({ optionId: "cancel", kind: "cancel", scope: "turn", label: "停止本回合" }, { decision });
      else if (typeof decision === "object" && "acceptWithExecpolicyAmendment" in decision && decision.acceptWithExecpolicyAmendment) add({ optionId: `allow_rule_${index}`, kind: "allow_always", scope: "persistent", label: "允许并保存命令规则", description: JSON.stringify(decision.acceptWithExecpolicyAmendment.execpolicy_amendment) }, { decision });
      else if (typeof decision === "object" && "applyNetworkPolicyAmendment" in decision && decision.applyNetworkPolicyAmendment) {
        const rule = decision.applyNetworkPolicyAmendment.network_policy_amendment;
        if (["allow", "deny"].includes(rule?.action)) add({ optionId: `network_rule_${index}`, kind: rule.action === "allow" ? "allow_always" : "reject_always", scope: "persistent",
          label: rule.action === "allow" ? "允许并保存网络规则" : "拒绝并保存网络规则", description: `${rule.action}: ${rule.host}` }, { decision });
      }
    }
  }
  const payload: AgentApproval = { requestId, toolCallId: p.itemId, category: permissions ? "permissions" : files ? "file-change" : network ? "network" : "command",
    reason: p.reason, command: p.command ?? item.command, cwd: p.cwd ?? item.cwd, options,
    ...(permissions ? { permissions: p.permissions ?? {} } : {}), ...(network ? { network } : {}),
    ...(p.additionalPermissions ? { permissions: p.additionalPermissions } : {}),
    ...(files ? { fileChanges: (item.changes ?? []).map(change => ({ path: change.path, kind: typeof change.kind === "object" ? change.kind.type : change.kind, diff: change.diff })), paths: p.grantRoot ? [p.grantRoot] : [] } : {}),
    ...(p.proposedExecpolicyAmendment ? { rememberPatterns: [p.proposedExecpolicyAmendment.join(" ")] } : {}) };
  return { payload, results };
}
