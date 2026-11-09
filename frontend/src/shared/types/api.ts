export type Locale = "zh" | "en";
export type { AgentImageAttachment } from "@domain/agents/agent-attachments";

export interface ApiErrorShape {
  code?: string;
  message?: string;
  detail?: unknown;
  retryable?: boolean;
}

export interface AgentEvent {
  id: string;
  cursor: number;
  updatedCursor?: number;
  sessionId: string;
  turnId?: string | null;
  type: string;
  occurredAt: string;
  provider?: string | null;
  payload: Record<string, unknown>;
}

export interface AgentTurn {
  id: string;
  sessionId: string;
  status: string;
  input: Array<{ type: string; text?: string }>;
  assistantText: string;
  startedAt: string;
  completedAt?: string | null;
  clientMessageId?: string;
}

export interface QueuedAgentMessage {
  id: string;
  text: string;
  attachments?: import("@domain/agents/agent-attachments").AgentImageAttachment[];
  model?: string | null;
  reasoningEffort?: string | null;
  createdAt: string;
}

export interface AgentSession {
  id: string;
  title: string;
  profileId: string;
  researchInterface?: "mcp-cli.v1";
  researchSessionId?: string;
  runtimeInstanceId?: string;
  ownerUserId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  provider?: string | null;
  status: string;
  historyStatus?: "live" | "saving" | "persisted" | "failed";
  historyError?: string | null;
  pinned?: boolean;
  archived?: boolean;
  lastReadCursor?: number;
  latestMessageCursor?: number;
  permissionGrants?: Array<{
    requestId: string;
    optionId?: string;
    label?: string;
    mode?: string;
    patterns?: string[];
    grantedAt?: string;
  }>;
  nativeSessionId?: string | null;
  sync?: {
    status?: string;
    source?: string;
    lastEventAt?: string | null;
  } | null;
  locale?: Locale;
  createdAt: string;
  updatedAt: string;
  lastCursor?: number;
  activeTurnId?: string | null;
  cancellingTurnId?: string | null;
  turns?: AgentTurn[];
  queuedMessages?: QueuedAgentMessage[];
  queuePaused?: boolean;
  events?: AgentEvent[];
  conversationEvents?: AgentEvent[];
  eventRetention?: {
    limit: number;
    firstCursor: number | null;
    droppedEvents: number;
  };
  context?: Record<string, unknown>;
  pendingApprovals?: Array<
    import("@domain/agents/agent-approval").AgentApproval
  >;
  capabilities?: {
    session?: { sync?: boolean; resume?: boolean; close?: boolean };
    cancel?: boolean;
    approval?: { interactive?: boolean; policy?: string };
  };
  usage?: import("@domain/agents/agent-usage").AgentUsageSnapshot | null;
}

export interface AgentProfile {
  id: string;
  label: string;
  provider: string;
  availability: string;
  model?: string | null;
  reasoningEffort?: string | null;
  models?: Array<{ id: string; label: string; reasoningEfforts?: string[] }>;
  reasoningEfforts?: string[];
  sandbox?: string | null;
  approvalPolicy?: string | null;
}

export interface ResearchContext {
  stateVersion?: string;
  sources?: unknown[];
  candidates?: Array<Record<string, unknown>>;
  topology?: { nodes?: unknown[]; edges?: unknown[] };
}

export interface CollaborationContext {
  membership?: { role: string; status: string } | null;
  actor?: {
    id: string;
    username?: string;
    displayName?: string;
    serverRole?: string;
  } | null;
  project?: { id: string; name: string; root?: string; workspace?: import("@domain/projects/workspace").ProjectWorkspace } | null;
  projects?: Array<{
    id: string;
    name: string;
    root?: string;
    role?: string;
    status?: string;
    updatedAt?: string;
  }>;
  permissions?: string[];
}
