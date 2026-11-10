import { compactId } from "../../lib/hash.js";
import { validateResearchEvent } from "../../domain/validators.js";
import type { ResearchActor, ResearchTopology, SourceSnapshot } from "../../domain/research/types.js";
import type { ResearchCommandService } from "./research-command-service.js";
import type { TopologyCuratorResult, CuratorTriggerStatus } from "../topology/curator-types.js";
import type { ExecutionPreview, ExecutionRecord } from "../../adapters/execution/docker-adapter.js";
export type ResearchEvent = {schemaVersion:string;id:string;type:string;occurredAt:string;actor:string;sessionId:string|null;nodeIds:string[];sourceRefs:string[];payload:Record<string,unknown>};
export type ResearchCandidateView=Omit<ReturnType<ResearchCommandService["auditCandidate"]>,"status">&{status:ReturnType<ResearchCommandService["auditCandidate"]>["status"]|"stale";staleReason?:string};
export type ResearchData = {candidates:ResearchCandidateView[];reads:unknown[];history:unknown[]};
type ErrorReport = {code:string;message:string;at:string};
type SourceRefreshState = {status:string;lastOutcome:string|null;lastReason:string|null;lastCheckedAt:string|null;lastUpdatedAt:string|null;nextScheduledAt:string|null;lastError:ErrorReport|null};
export type ResearchStateView = {
  schemaVersion:string;research:ResearchData;workspaceStatus:string;snapshot:SourceSnapshot|null;sourceRefresh:SourceRefreshState;
  curatorResult:TopologyCuratorResult|null;curatorTrigger:CuratorTriggerStatus|null;executionPreview:ExecutionPreview|null;
  executionRecord:ExecutionRecord|null;agentEvents:ResearchEvent[];topology:ResearchTopology|null;lastError:ErrorReport|null;
};
const reportError = (error:unknown,fallback:string):ErrorReport => ({code:error&&typeof error==="object"&&"code" in error?String(error.code):fallback,message:error instanceof Error?error.message:String(error),at:new Date().toISOString()});

export class ResearchState {
  workspaceStatus:string;
  snapshot:SourceSnapshot|null;
  sourceRefresh:SourceRefreshState;
  curatorResult:TopologyCuratorResult|null;
  curatorTrigger:CuratorTriggerStatus|null;
  executionPreview:ExecutionPreview|null;
  executionRecord:ExecutionRecord|null;
  topology:ResearchTopology|null;
  lastError:ErrorReport|null;
  agentEvents:ResearchEvent[];
  _eventKeys:Set<string>;
  research:ResearchData;
  constructor(initialTopology:ResearchTopology|null = null) {
    this.workspaceStatus = "booting";
    this.snapshot = null;
    this.sourceRefresh = {
      status: "idle",
      lastOutcome: null,
      lastReason: null,
      lastCheckedAt: null,
      lastUpdatedAt: null,
      nextScheduledAt: null,
      lastError: null,
    };
    this.curatorResult = null;
    this.curatorTrigger = null;
    this.executionPreview = null;
    this.executionRecord = null;
    this.topology = initialTopology;
    this.lastError = null;
    this.agentEvents = [];
    this._eventKeys = new Set();
    this.research = { candidates: [], reads: [], history: [] };
  }

  hydrate(view:Partial<ResearchStateView>|null|undefined, fallbackTopology = this.topology) {
    if (!view || typeof view !== "object") return false;
    this.workspaceStatus = view.workspaceStatus ?? "booting";
    this.snapshot = view.snapshot ?? null;
    this.sourceRefresh = structuredClone(view.sourceRefresh ?? this.sourceRefresh);
    this.curatorResult = view.curatorResult ?? null;
    this.curatorTrigger = view.curatorTrigger ?? null;
    this.executionPreview = view.executionPreview ?? null;
    this.executionRecord = view.executionRecord ?? null;
    this.topology = view.topology ?? fallbackTopology;
    this.lastError = view.lastError ?? null;
    this.agentEvents = Array.isArray(view.agentEvents) ? view.agentEvents : [];
    this._eventKeys = new Set(this.agentEvents.map((event) => event.id).filter(Boolean));
    this.research = structuredClone(view.research ?? { candidates: [], reads: [], history: [] });
    return true;
  }

  reset(topology:ResearchTopology|null = null) {
    const next = new ResearchState(topology);
    this.hydrate(next.view(), topology);
  }

  setSnapshot(snapshot:SourceSnapshot, topology = this.topology) {
    this.workspaceStatus = "ready";
    this.snapshot = snapshot;
    this.curatorResult = null;
    this.executionPreview = null;
    this.executionRecord = null;
    this.topology = topology;
    this.lastError = null;
    this.research = {
      ...this.research,
      candidates: (this.research?.candidates ?? []).map((candidate) => ["pending", "deferred"].includes(candidate.status)
        ? { ...candidate, status: "stale", staleReason: "source snapshot changed" }
        : candidate),
    };
  }

  invalidateSourceCheck() {
    this.sourceRefresh = { ...this.sourceRefresh, status: "idle", lastCheckedAt: null, lastReason: "tool-configuration-changed" };
  }

  confirmSnapshot(snapshot:SourceSnapshot) {
    this.workspaceStatus = "ready";
    this.snapshot = snapshot;
    this.lastError = null;
  }

  beginSourceRefresh(reason:string) {
    this.sourceRefresh = {
      ...this.sourceRefresh,
      status: "checking",
      lastReason: reason,
      lastError: null,
    };
  }

  completeSourceRefresh({ outcome, reason, checkedAt, changed = false }: {outcome:string;reason:string;checkedAt:string;changed?:boolean}) {
    this.sourceRefresh = {
      ...this.sourceRefresh,
      status: "ready",
      lastOutcome: outcome,
      lastReason: reason,
      lastCheckedAt: checkedAt,
      lastUpdatedAt: changed ? checkedAt : this.sourceRefresh.lastUpdatedAt,
      lastError: null,
    };
  }

  deferSourceRefresh(reason:string) {
    this.sourceRefresh = {
      ...this.sourceRefresh,
      status: "deferred",
      lastOutcome: "deferred",
      lastReason: reason,
    };
  }

  failSourceRefresh(error:unknown, reason:string) {
    this.sourceRefresh = {
      ...this.sourceRefresh,
      status: "error",
      lastOutcome: "failed",
      lastReason: reason,
      lastError: reportError(error,"SOURCE_REFRESH_FAILED"),
    };
  }

  setNextSourceRefresh(at:string|null) {
    this.sourceRefresh = { ...this.sourceRefresh, nextScheduledAt: at };
  }

  setCuratorResult(result:TopologyCuratorResult|null|undefined) {
    this.curatorResult = result ?? null;
  }

  setCuratorTrigger(trigger:CuratorTriggerStatus|null|undefined) {
    this.curatorTrigger = trigger ? structuredClone(trigger) : null;
  }

  recordEvent(input:Partial<ResearchEvent> & {type:string}, options: {skipValidation?:boolean} = {}):ResearchEvent {
    if (input?.id) {
      const existing = this.agentEvents.find((event) => event.id === input.id);
      if (existing) return existing;
    }
    const event = {
      schemaVersion: "research-event.v1",
      id: input.id ?? compactId("evt"),
      type: input.type,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      actor: input.actor ?? "system",
      sessionId: input.sessionId ?? null,
      nodeIds: [...new Set(input.nodeIds ?? [])],
      sourceRefs: [...new Set(input.sourceRefs ?? [])],
      payload: input.payload ?? {},
    };
    if (!options.skipValidation) validateResearchEvent(event);
    this.agentEvents.push(event);
    if (this.agentEvents.length > 400) this.agentEvents.splice(0, this.agentEvents.length - 400);
    return event;
  }

  setExecutionPreview(preview:ExecutionPreview|null, topology = this.topology) {
    this.executionPreview = preview;
    this.executionRecord = null;
    this.topology = topology;
  }

  setExecutionRecord(record:ExecutionRecord|null) {
    this.executionRecord = record;
  }

  setError(error:unknown) {
    this.lastError = reportError(error,"INTERNAL_ERROR");
  }

  view():ResearchStateView {
    return {
      schemaVersion: "research-workbench-state.v1",
      research: this.research,
      workspaceStatus: this.workspaceStatus,
      snapshot: this.snapshot,
      sourceRefresh: this.sourceRefresh,
      curatorResult: this.curatorResult,
      curatorTrigger: this.curatorTrigger,
      executionPreview: this.executionPreview,
      executionRecord: this.executionRecord,
      agentEvents: this.agentEvents,
      topology: this.topology,
      lastError: this.lastError,
    };
  }

  commitResearch(research:ResearchData, topology = this.topology, _meta?:{actor:ResearchActor;reason:string}) {
    this.research = structuredClone(research);
    this.topology = structuredClone(topology);
  }
}
