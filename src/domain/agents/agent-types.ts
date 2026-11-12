import type { ConversationEvent } from "./agent-conversation.js";
import type { AgentApproval, AgentApprovalSelection } from "./agent-approval.js";
import type { StoredAgentImageAttachment as AgentAttachment, AgentImageAttachment } from "./agent-attachments.js";

export type AgentProvider = "codex" | "claude" | "opencode" | "fixture" | (string & {});
export interface AgentModel { id: string; label: string; reasoningEfforts?: string[] }
export interface NativePermissionRule { action: string; resource: string; effect: "allow" | "deny" | "ask" }
export interface ClaudeNativePermissions { defaultMode?: string; allow?: string[]; deny?: string[]; ask?: string[]; [key: string]: unknown }
/** Provider options are preserved as data; known launch controls are typed here. */
export interface NativeConfig extends Record<string, unknown> {
  model?: string | { providerID: string; model: string; variant?: string }; model_provider?: string; model_reasoning_effort?: string;
  approval_policy?: string; sandbox_mode?: string; developer_instructions?: string;
  effortLevel?: string; env?: Record<string, string>;
  permissions?: ClaudeNativePermissions | NativePermissionRule[];
  mcp_servers?: Record<string, Record<string, unknown>>;
}
export interface AgentProfile {
  id: string; label: string; provider: AgentProvider; command: string;
  driver?: string; transport?: string; source?: string; description?: string;
  args?: string[]; launcherArgs?: string[]; extraArgs?: string[]; env?: Record<string, string>;
  cwd?: string; runtimeCommand?: string; runtimeArgs?: string[]; requiresRuntime?: string;
  managedWrapper?: string; versionArgs?: string[]; versionTimeoutMs?: number; minVersion?: string; maxVersion?: string; requireVersion?: boolean;
  model?: string | null; reasoningEffort?: string | null; models?: AgentModel[]; reasoningEfforts?: string[];
  approvalPolicy?: string; permissionMode?: string; sandbox?: string; ephemeral?: boolean; allowedTools?: string[];
  authProbe?: { kind?: string; args?: string[]; timeoutMs?: number };
  capabilities?: string[]; nativeConfig?: NativeConfig; nativeConfigFile?: string;
  nativeConfigRevision?: string; nativeConfigRoot?: string;
}
export interface ResearchMcpBinding {
  name: string; command: string; args: string[]; cwd: string; instructions?: string;
  env: Record<string, string>; skillDelivery?: { name: string; mode: string; version?: string; bundleHash?: string };
}
export interface DriverEvent { type: string; turnId?: string | null; payload: Record<string, unknown> }
export interface AgentDriverOptions {
  cwd?: string; env?: Record<string, string>; requestTimeoutMs?: number;
  model?: string | null; reasoningEffort?: string | null; onEvent?: (event: DriverEvent) => void; expectedDriver?: string;
}
export interface AgentStartInput {
  cwd?: string; context?: Record<string, unknown> | null; developerInstructions?: string | null;
  resumeThreadId?: string | null; researchMcp?: ResearchMcpBinding | null;
}
export interface AgentCapabilities extends Record<string, unknown> {
  session?: { resume?: boolean; close?: boolean; sync?: boolean };
  sessionCapabilities?: { close?: boolean }; promptCapabilities?: { embeddedContext?: boolean };
  approval?: { interactive?: boolean; policy?: string; command?: boolean; fileChange?: boolean; permissions?: boolean };
}
export interface AgentStartResult {
  nativeSessionId: string; capabilities: AgentCapabilities; model?: string | null;
  agentInfo?: { name?: string; title?: string; version?: string | null; transport?: string } | null;
  authMethods?: unknown[];
}
export interface AgentPromptPart { type: string; text?: string; resource?: { uri?: string; text?: string; mimeType?: string }; path?: string; mimeType?: string; name?: string }
export interface AgentPromptInput { turnId: string; content: AgentPromptPart[]; model?: string | null; reasoningEffort?: string | null }
export interface AgentTurnResult { stopReason: string; nativeTurnId?: string | null; nativeSessionId?: string | null; usage?: unknown; cost?: number }
export interface AgentAdapterContract {
  profile: AgentProfile; closed?: boolean;
  start(input?: AgentStartInput): Promise<AgentStartResult>;
  prompt(input: AgentPromptInput): Promise<AgentTurnResult>;
  cancel(): void;
  resolvePermission(requestId: string, optionId: string | null, cancelled?: boolean, selection?: { permissionKeys?: string[] }): Promise<unknown>;
  readSnapshot?(input?: { nativeSessionId?: string | null }): Promise<unknown>;
  close(): Promise<void>;
}
export interface AgentPayload extends Record<string, unknown> {
  text?: string; delta?: string; messageId?: string | null; blockId?: string | null;
  nativeItemId?: string | null; nativeMessageId?: string | null; nativeParentId?: string | null;
  nativeTurnId?: string | null; nativeEventId?: string | null; nativeSessionId?: string | null;
  toolCallId?: string | null; title?: string; tool?: string; server?: string; kind?: string;
  agentId?: string | null; parentToolUseId?: string | null; restored?: boolean; targetId?: string;
  reasoningId?: string; phase?: string; completion?: string; status?: string;
  requestId?: string; optionId?: string; options?: AgentApproval["options"]; risk?: AgentApproval["risk"];
  category?: AgentApproval["category"]; command?: AgentApproval["command"]; cwd?: AgentApproval["cwd"];
  permissions?: AgentApproval["permissions"]; network?: AgentApproval["network"]; paths?: AgentApproval["paths"]; fileChanges?: AgentApproval["fileChanges"];
  imageCaptured?: boolean; imageAttachment?: AgentImageAttachment; imageCaptureError?: string;
  item?: { id?: string; server?: string; tool?: string; result?: unknown; output?: unknown; [key: string]: unknown };
  rawOutput?: unknown; result?: unknown; expected?: boolean;
  decision?: AgentApproval["decision"]; selectedScope?: AgentApproval["selectedScope"]; permissionKeys?: AgentApproval["permissionKeys"];
}
export type AgentEvent = Omit<ConversationEvent, "payload"> & { payload: AgentPayload };
export interface AssistantMessage extends AgentPayload { messageId: string; text: string; completed: boolean }
export interface TurnMessage { text: string; attachments?: AgentAttachment[]; clientMessageId?: string; submissionHash?: string; model?: string | null; reasoningEffort?: string | null }
export interface AgentTurn {
  schemaVersion?: string; id: string; sessionId: string; status: string; input: AgentPromptPart[];
  attachments?: AgentAttachment[]; clientMessageId?: string; submissionHash?: string; model?: string | null; reasoningEffort?: string | null;
  assistantText: string; assistantMessages: AssistantMessage[]; stopReason?: string | null;
  startedAt: string; completedAt?: string | null; nativeTurnId?: string | null; nativeMessageId?: string | null;
}
export interface QueuedMessage extends TurnMessage { id: string; createdAt: string; editedAt?: string; input?: AgentPromptPart[] }
export interface SessionContext extends Record<string, unknown> { topologyStateVersion?: string | null; sourceStateVersion?: string | null; focus?: string; nodeIds?: string[]; sourceRefs?: string[]; handoff?: { previousSessionId?: string } }
export interface AgentSync { source?: string; status?: string; lastSyncedAt?: string | null; lastEventAt?: string | null; lastReason?: string; lastNativeUpdatedAt?: unknown; error?: unknown }
export interface PermissionGrant { requestId?: string; optionId?: string; label?: string; mode?: string; patterns: string[]; grantedAt: string; runtimeInstanceId: string }
export interface StoredAgentSession {
  nativeDriver?: string;
  schemaVersion: string; id: string; title: string; profileId: string; researchInterface: string; researchSessionId: string;
  runtimeInstanceId: string; ownerUserId: string | null; model: string | null; reasoningEffort: string | null;
  provider: string | null; status: string; nativeSessionId: string | null; capabilities: AgentCapabilities;
  agentInfo: AgentStartResult["agentInfo"]; authMethods: unknown[]; context: SessionContext; locale: string;
  createdAt: string; updatedAt: string; turns: AgentTurn[]; queuedMessages: QueuedMessage[];
  events: AgentEvent[]; conversationEvents: AgentEvent[]; permissionGrants?: PermissionGrant[];
  candidateTurns?: Record<string, string>; sync: AgentSync; nativeSnapshot?: unknown; usage?: unknown;
  pinned: boolean; archived: boolean; lastReadCursor: number; latestMessageCursor: number;
  parentSessionId?: string | null; resumedFrom?: string | null; queuePaused: boolean; activeTurnId: string | null;
  historyStatus: string; historyError?: string | null; runtimeStatus?: string | null; lastCursor?: number;
  traceFormat: string; traceDroppedEvents: number; pendingApprovals: RuntimeApproval[];
}
export interface AgentRuntimeSession extends Omit<StoredAgentSession, "pendingApprovals"> {
  permissionGrants: PermissionGrant[]; pendingApprovals: Map<string, RuntimeApproval>; subscribers: Set<(event: AgentEvent) => void>;
  adapter: AgentAdapterContract | null; cursor: number; streamEvents: AgentEvent[];
  closing?: boolean; closePromise?: Promise<PublicAgentSessionSnapshot> | null; imageCaptures?: Set<Promise<void>>;
  drainScheduled?: boolean; reasoningSegment?: { turnId: string | null | undefined; id: string } | null;
}
export type PublicAgentSession = Omit<StoredAgentSession, "traceFormat" | "traceDroppedEvents" | "events" | "conversationEvents"> & {
  permissionGrants: PermissionGrant[]; candidateTurns: Record<string, string>; lastCursor: number; resumable: boolean;
  events?: AgentEvent[]; conversationEvents?: AgentEvent[];
  eventRetention?: { limit: number; firstCursor: number | null; droppedEvents: number };
};
export type PublicAgentSessionSnapshot = PublicAgentSession & Required<Pick<PublicAgentSession, "events" | "conversationEvents" | "eventRetention">>;
export type AgentSessionSummary = Pick<StoredAgentSession, "id" | "title" | "profileId" | "provider" | "model" | "ownerUserId" | "pinned" | "archived" | "status" | "createdAt" | "updatedAt" | "lastReadCursor" | "latestMessageCursor"> & {
  lastCursor: number; turnCount: number; queuedMessageCount: number;
  pendingApprovals: Pick<RuntimeApproval, "requestId" | "toolName" | "category">[];
};
export interface CreateAgentSessionInput {
  profileId?: string; title?: string; ownerUserId?: string; researchSessionId?: string; model?: string | null;
  reasoningEffort?: string | null; parentSessionId?: string; resumedFrom?: string; context?: SessionContext; locale?: string;
  cwd?: string; developerInstructions?: string; resumeNativeThreadId?: string | null;
  mcpBindingFactory?: (scope: { runtimeInstanceId: string; researchSessionId: string }) => ResearchMcpBinding | Promise<ResearchMcpBinding>;
}
export interface RuntimeApproval extends AgentApproval {
  resolving?: boolean; nativeResolved?: boolean; resolution?: Partial<AgentApproval>;
  selection?: AgentApprovalSelection;
}
