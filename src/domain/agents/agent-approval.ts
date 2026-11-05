export type ApprovalDecision = "allow" | "reject" | "cancel";
export type ApprovalScope = "once" | "turn" | "session" | "persistent";
export interface AgentApprovalSelection {
  decision: ApprovalDecision;
  optionId?: string;
  permissionKeys?: Array<"network" | "fileSystem">;
}
export interface AgentApprovalOption {
  optionId: string;
  kind: "allow_once" | "allow_session" | "allow_always" | "reject_once" | "reject_always" | "cancel";
  scope?: ApprovalScope;
  label?: string;
  name?: string;
  description?: string;
  patterns?: string[];
  mode?: "acceptEdits";
}
export interface AgentApproval {
  risk?: "project-write" | "elevated";
  requestId: string;
  toolCallId?: string | null;
  category?: "command" | "file-change" | "network" | "permissions" | "tool";
  toolName?: string;
  title?: string;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  paths?: string[];
  fileChanges?: Array<{ path: string; kind?: string; diff?: string }>;
  input?: unknown;
  permissions?: unknown;
  network?: { host?: string; protocol?: string; port?: number };
  patterns?: string[];
  rememberPatterns?: string[];
  options: AgentApprovalOption[];
  status?: string;
  decision?: ApprovalDecision | "cancelled" | "expired" | "external";
  optionId?: string;
  selectedScope?: ApprovalScope;
  turnId?: string | null;
  agentId?: string;
  defaultToNo?: boolean;
  permissionKeys?: Array<"network" | "fileSystem">;
}

export function approvalToolDetails(tool: string, input: Record<string, unknown> = {}): Partial<AgentApproval> {
  const terminal = /^(bash|powershell|shell|exec_command)$/i.test(tool);
  const edit = /^(edit|write|multiedit|apply_patch)$/i.test(tool);
  const path = input.file_path ?? input.filePath ?? input.path;
  return { category: terminal ? "command" : edit ? "file-change" : "tool", toolName: tool,
    ...(terminal && typeof input.command === "string" ? { command: input.command } : {}),
    ...(typeof path === "string" ? { paths: [path] } : {}), input };
}

export function approvalDecision(kind: AgentApprovalOption["kind"]): ApprovalDecision {
  return kind === "cancel" ? "cancel" : kind.startsWith("allow_") ? "allow" : "reject";
}

export function approvalPermission(approval: AgentApproval, option: AgentApprovalOption) {
  const persistent = option.scope === "persistent" || option.kind === "allow_always" || option.kind === "reject_always";
  if (approvalDecision(option.kind) !== "allow" && !persistent) return "agent.createSession";
  if (persistent || option.scope === "session" || option.kind === "allow_session" || option.mode || approval.risk !== "project-write") return "agent.approveHighRiskTool";
  return "agent.createSession";
}
