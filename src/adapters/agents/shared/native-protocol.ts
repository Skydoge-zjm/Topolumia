import * as z from "zod/v4";

const object = z.record(z.string(), z.unknown());
const error = z.looseObject({ message: z.string().optional(), code: z.union([z.string(), z.number()]).optional(), data: z.unknown().optional() });
export const codexItemSchema = z.looseObject({
  id: z.string().optional(), type: z.string().optional(), status: z.string().optional(), text: z.string().optional(),
  command: z.string().nullable().optional(), cwd: z.string().nullable().optional(), phase: z.string().nullable().optional(), delivery: z.string().nullable().optional(),
  summary: z.unknown().optional(), summaryText: z.unknown().optional(), content: z.unknown().optional(),
  changes: z.array(z.looseObject({ path: z.string(), kind: z.union([z.string(), z.looseObject({ type: z.string() })]).optional(), diff: z.string().optional() })).optional(),
});
export const codexTurnSchema = z.looseObject({ id: z.string().optional(), status: z.string().optional(), usage: z.unknown().optional(), items: z.array(codexItemSchema).optional() });
export const codexParamsSchema = z.looseObject({
  threadId: z.string().optional(), turnId: z.string().optional(), turn: codexTurnSchema.optional(), itemId: z.string().optional(),
  item: codexItemSchema.optional(), requestId: z.union([z.string(), z.number()]).optional(), delta: z.string().optional(),
  summaryIndex: z.number().optional(), contentIndex: z.number().optional(), plan: z.array(z.unknown()).optional(),
  explanation: z.string().nullable().optional(), error: error.nullable().optional(), message: z.string().optional(), willRetry: z.boolean().optional(),
  permissions: object.nullable().optional(), additionalPermissions: object.nullable().optional(), reason: z.string().nullable().optional(), command: z.string().nullable().optional(), cwd: z.string().nullable().optional(),
  networkApprovalContext: z.looseObject({ host: z.string().optional(), protocol: z.string().optional(), port: z.number().optional() }).nullable().optional(),
  grantRoot: z.string().nullable().optional(), proposedExecpolicyAmendment: z.array(z.string()).nullable().optional(),
  proposedNetworkPolicyAmendments: z.array(z.looseObject({ action: z.string(), host: z.string() })).nullable().optional(),
  availableDecisions: z.array(z.union([z.string(), z.looseObject({ acceptWithExecpolicyAmendment: z.looseObject({ execpolicy_amendment: z.array(z.string()) }).optional(), applyNetworkPolicyAmendment: z.looseObject({ network_policy_amendment: z.looseObject({ action: z.string(), host: z.string() }) }).optional() })])).nullable().optional(),
});
export const codexMessageSchema = z.looseObject({ id: z.union([z.string(), z.number()]).nullable().optional(), method: z.string().optional(), params: codexParamsSchema.optional() });
export type CodexMessage = z.infer<typeof codexMessageSchema>;
export type CodexItem = z.infer<typeof codexItemSchema>;
export type CodexParams = z.infer<typeof codexParamsSchema>;
export type CodexTurn = z.infer<typeof codexTurnSchema>;

export const permissionUpdateSchema = z.looseObject({ type: z.string(), behavior: z.string().optional(), destination: z.string().optional(), mode: z.string().optional(), directories: z.array(z.string()).optional(), rules: z.array(z.looseObject({ toolName: z.string(), ruleContent: z.string().optional() })).optional() });
export type PermissionUpdate = z.infer<typeof permissionUpdateSchema>;
const claudeContent = z.looseObject({ type: z.string().optional(), id: z.string().optional(), name: z.string().optional(), text: z.string().optional(), thinking: z.string().optional(), input: object.optional(), tool_use_id: z.string().optional(), is_error: z.boolean().optional(), content: z.unknown().optional() });
const claudeRequest = z.looseObject({ subtype: z.string().optional(), tool_name: z.string().optional(), tool_use_id: z.string().optional(), input: object.optional(), permission_suggestions: z.array(permissionUpdateSchema).optional(), suppress_always_allow_rule: z.boolean().optional(), requires_user_interaction: z.boolean().optional(), agent_id: z.string().optional(), title: z.string().optional(), display_name: z.string().optional(), description: z.string().optional(), decision_reason: z.string().optional(), blocked_path: z.string().optional(), default_to_no: z.boolean().optional() });
export const claudePacketSchema = z.looseObject({
  type: z.string().optional(), subtype: z.string().optional(), uuid: z.string().optional(), parent_tool_use_id: z.string().nullable().optional(), agent_id: z.string().optional(),
  task_id: z.string().optional(), tool_use_id: z.string().optional(), description: z.string().optional(), agent_type: z.string().optional(), status: z.string().optional(), summary: z.unknown().optional(),
  elapsed_time_seconds: z.number().optional(), aborted: z.boolean().optional(), session_id: z.string().optional(), version: z.string().optional(), claude_code_version: z.string().optional(),
  usage: object.nullable().optional(), total_cost_usd: z.number().optional(), modelUsage: z.unknown().optional(), stop_reason: z.string().nullable().optional(), is_error: z.boolean().optional(), errors: z.array(z.string()).optional(), result: z.unknown().optional(),
  error: error.optional(), attempt: z.number().optional(), max_retries: z.number().optional(), capabilities: z.unknown().optional(), rate_limit_info: z.unknown().optional(),
  request_id: z.string().optional(), request: claudeRequest.optional(), response: z.looseObject({ request_id: z.string(), subtype: z.string().optional(), error: z.unknown().optional(), response: object.optional(), pending_permission_requests: z.array(z.unknown()).optional() }).optional(),
  event: z.looseObject({ type: z.string().optional(), message: z.looseObject({ id: z.string().optional() }).optional(), message_id: z.string().optional(), index: z.number().optional(), content_block: claudeContent.optional(), delta: z.looseObject({ type: z.string().optional(), text: z.string().optional(), thinking: z.string().optional(), partial_json: z.string().optional(), stop_reason: z.string().nullable().optional() }).optional() }).optional(),
  message: z.looseObject({ id: z.string().optional(), content: z.union([z.string(), z.array(claudeContent)]).optional() }).optional(),
});
export type ClaudePacket = z.infer<typeof claudePacketSchema>;
export type ClaudeContent = z.infer<typeof claudeContent>;
export type ClaudeRequest = z.infer<typeof claudeRequest>;
