import { compactId } from "../../lib/hash.js";
import { validateResearchEvent } from "../../domain/validators.js";

export class ResearchState {
  constructor(initialTopology = null) {
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

  hydrate(view, fallbackTopology = this.topology) {
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

  reset(topology = null) {
    const next = new ResearchState(topology);
    this.hydrate(next.view(), topology);
  }

  setSnapshot(snapshot, topology = this.topology) {
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

  confirmSnapshot(snapshot) {
    this.workspaceStatus = "ready";
    this.snapshot = snapshot;
    this.lastError = null;
  }

  beginSourceRefresh(reason) {
    this.sourceRefresh = {
      ...this.sourceRefresh,
      status: "checking",
      lastReason: reason,
      lastError: null,
    };
  }

  completeSourceRefresh({ outcome, reason, checkedAt, changed = false }) {
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

  deferSourceRefresh(reason) {
    this.sourceRefresh = {
      ...this.sourceRefresh,
      status: "deferred",
      lastOutcome: "deferred",
      lastReason: reason,
    };
  }

  failSourceRefresh(error, reason) {
    this.sourceRefresh = {
      ...this.sourceRefresh,
      status: "error",
      lastOutcome: "failed",
      lastReason: reason,
      lastError: {
        code: error.code ?? "SOURCE_REFRESH_FAILED",
        message: error.message,
        at: new Date().toISOString(),
      },
    };
  }

  setNextSourceRefresh(at) {
    this.sourceRefresh = { ...this.sourceRefresh, nextScheduledAt: at };
  }

  setCuratorResult(result) {
    this.curatorResult = result ?? null;
  }

  setCuratorTrigger(trigger) {
    this.curatorTrigger = trigger ? structuredClone(trigger) : null;
  }

  recordEvent(input, options = {}) {
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

  setExecutionPreview(preview, topology = this.topology) {
    this.executionPreview = preview;
    this.executionRecord = null;
    this.topology = topology;
  }

  setExecutionRecord(record) {
    this.executionRecord = record;
  }

  setError(error) {
    this.lastError = {
      code: error.code ?? "INTERNAL_ERROR",
      message: error.message,
      at: new Date().toISOString(),
    };
  }

  view() {
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

  commitResearch(research, topology = this.topology) {
    this.research = structuredClone(research);
    this.topology = structuredClone(topology);
  }
}
