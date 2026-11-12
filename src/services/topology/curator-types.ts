import type { AppConfig } from "../../config.js";
import type {
  ResearchTopology,
  TopologyNode,
  TopologyEdge,
  SourceSnapshot,
} from "../../domain/research/types.js";
import type { ResearchEvent } from "../research/research-state.js";

export type CuratorOperation =
  | { op: "addNode"; node: TopologyNode }
  | { op: "addEdge"; edge: TopologyEdge }
  | { op: "updateNode"; nodeId: string; patch: Partial<TopologyNode> }
  | { op: "deleteNode"; nodeId: string }
  | { op: "noop" };
export type CuratorPatch = {
  schemaVersion: string;
  id: string;
  idempotencyKey: string;
  baseStateVersion: string;
  eventRange: { from: string | null; to: string | null };
  reason: string;
  reasonEn?: string;
  sourceRefs: string[];
  evidenceNodeIds: string[];
  curator: { adapter: string; mode: string; model: string };
  operations: CuratorOperation[];
};
export type CuratorTrace = {
  observedNodeIds: string[];
  observedEdgeIds: string[];
  observedSourceRefs?: string[];
  [key: string]: unknown;
};
export type TopologyCuratorResult = {
  schemaVersion: string;
  disposition: string;
  summary: string;
  reason: string;
  reasonEn?: string;
  sourceRefs: string[];
  evidenceNodeIds: string[];
  inspectedNodeIds: string[];
  inspectedEdgeIds: string[];
  uncertainties: string[];
  questions: string[];
  patch: CuratorPatch | null;
  runId?: string;
  model?: string;
  threadId?: string | null;
  usage?: unknown;
  explorationTrace?: CuratorTrace;
  workspacePath?: string;
};
export type CuratorOutput = Omit<TopologyCuratorResult, "patch" | "explorationTrace" | "workspacePath"> & {
  explorationTrace?: CuratorTrace | null;
  workspacePath?: string | null;
  patch: (Partial<CuratorPatch> & { operations: CuratorOperation[] }) | null;
};
export type CuratorContext = {
  trigger?: unknown;
  operation?: string | null;
  entryContext?: Record<string, unknown> | null;
  workingContext?: Record<string, unknown> | null;
  observedContext?: unknown;
  continuityContext?: unknown;
  focus?: unknown;
  sourceStateVersion?: string | null;
  eventRange?: { from: string | null; to: string | null };
};
export type CuratorInput = {
  topology?: ResearchTopology | null;
  snapshot?: SourceSnapshot | null;
  events?: ResearchEvent[];
  locale?: string;
  context?: CuratorContext;
  nodeIds?: string[];
  edgeIds?: string[];
  sourceRefs?: string[];
  operation?: string | null;
  sourceStateVersion?: string | null;
  mode?: string;
  cause?: string;
  triggerId?: string | null;
  fingerprint?: string | null;
  sessionId?: string | null;
};
export type CuratorDriverResult = {
  result: CuratorOutput;
  trace: CuratorTrace;
  runId: string;
  model: string;
  usage?: unknown;
  threadId: string | null;
  workspacePath: string;
};
export type CuratorMaterialization = {
  runId: string;
  workspacePath: string;
  nodeFileById: Record<string, string>;
  sourceFileByRef: Record<string, string>;
  nodeIds: string[];
  edgeIds: string[];
  sourceRefs: string[];
};
export type CuratorDriver = {
  config?: Partial<AppConfig["curator"]>;
  run(input: CuratorInput): Promise<CuratorDriverResult>;
};
export type CuratorTriggerRecord = {
  id: string;
  fingerprint: string;
  envelope: CuratorEnvelope;
  status: string;
  pendingEventCount: number;
  eventIds: string[];
  startedAt: string | null;
  completedAt: string | null;
  consumedAt: string | null;
  disposition: string | null;
  resultSummary: {
    disposition: string | null;
    summary: string;
    runId: string | null;
    model: string | null;
    patchId: string | null;
  } | null;
  error: { code: string; message: string; retryable: boolean } | null;
  result?: TopologyCuratorResult | null;
};
export type CuratorEnvelope = {
  schemaVersion: string;
  mode: string;
  cause: string;
  entryContext: Record<string, unknown> | null;
  workingContext: Record<string, unknown> & {
    nodeIds: string[];
    edgeIds: string[];
    sourceRefs: string[];
  };
  sessionId: string | null;
  eventIds: string[];
  nodeIds: string[];
  edgeIds: string[];
  sourceRefs: string[];
  baseTopologyVersion: string;
  sourceStateVersion: string | null;
  requestedAt: string;
  locale: string;
  operation: string | null;
  focus: unknown;
  continuityContext: unknown;
};
export type CuratorAutomation = {
  enabled: boolean;
  triggerOnSessionCheckpoint: boolean;
  triggerOnSourceDelta: boolean;
  triggerOnExperimentDelta: boolean;
  triggerOnIdle: boolean;
  triggerOnContinuityBreak: boolean;
  triggerOnTopologyChanged: boolean;
  idleSeconds: number;
  minPendingEvents: number;
  cooldownSeconds: number;
  backgroundMode: string;
};
export type CuratorTriggerStatus = {
  schemaVersion: string;
  status: string;
  pendingEventCount: number;
  pendingEventIds: string[];
  running: boolean;
  cooldownUntil: string | null;
  lastActivityAt: string;
  last: CuratorTriggerRecord | null;
  history: CuratorTriggerRecord[];
  automation: CuratorAutomation;
};
