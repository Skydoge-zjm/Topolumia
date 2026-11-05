import { AppError } from "../../lib/errors.js";
import {
  metricSummary,
  normalizeRun,
  normalizeSeries,
} from "../../domain/experiments/experiment-domain.js";
import {
  METRIC_INGESTION_SCHEMA,
  normalizeMetricEvent,
  providerFromRunRef,
  validateMetricBatch,
  validateRunRef,
} from "../../domain/experiments/metric-ingestion.js";

const SIMULATION_CAPABILITIES = {
  structuredRun: { status: "supported" },
  history: { status: "supported", xKey: "step" },
  metricHistory: { status: "supported", xKey: "step" },
  artifacts: { status: "unavailable", reason: "simulation does not create provider artifacts" },
  inputs: { status: "unavailable", reason: "simulation does not declare input lineage" },
  inputLineage: { status: "unavailable", reason: "simulation does not declare input lineage" },
  media: { status: "unavailable", reason: "simulation emits metrics only" },
};

function nowIso(clock) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function clone(value) {
  return structuredClone(value);
}

/**
 * Keep source snapshots and list/status responses bounded. The ingestion
 * overlay retains full histories internally for detail/series/chart queries,
 * but callers that only need run identity and summaries must not receive the
 * raw event arrays by accident.
 */
export function summarizeIngestedRun(run) {
  if (!run || typeof run !== "object") return null;
  const metricPointCounts = Object.fromEntries(Object.entries(run.metricHistory ?? {}).map(([metric, points]) => [metric, Array.isArray(points) ? points.length : 0]));
  const eventCount = Object.values(metricPointCounts).reduce((sum, count) => sum + count, 0);
  const { metricHistory: _metricHistory, metricEvents: _metricEvents, ...summary } = run;
  return {
    ...clone(summary),
    metricPointCounts,
    eventCount,
  };
}

function normalizeRunMetadata(run, { mode, source, clock }) {
  const ref = validateRunRef(run?.ref);
  const provider = providerFromRunRef(ref);
  return {
    ref,
    provider,
    externalId: String(run.externalId ?? ref.split(":run:")[1]),
    kind: "run",
    label: String(run.label ?? run.name ?? ref),
    group: run.group ?? run.params?.group ?? "simulation",
    status: String(run.status ?? "RUNNING").toUpperCase(),
    startedAt: run.startedAt ?? nowIso(clock),
    endedAt: run.endedAt ?? null,
    experiment: run.experiment ?? { id: "workbench-simulation", name: "workbench-training-simulation" },
    params: run.params ?? {},
    tags: run.tags ?? {},
    nativeLocator: run.nativeLocator ?? null,
    source: source ?? "workbench-simulator",
    mode,
  };
}

function compareEvents(a, b) {
  return a.step - b.step || String(a.timestamp).localeCompare(String(b.timestamp)) || a.eventId.localeCompare(b.eventId);
}

export class MetricIngestionStore {
  constructor({ clock = () => new Date(), maxRuns = 32, maxEventsPerRun = 300_000, maxBatchEvents = 300_000 } = {}) {
    this.id = "workbench-simulator";
    this.clock = clock;
    this.maxRuns = Math.max(1, Number(maxRuns) || 32);
    this.maxEventsPerRun = Math.max(1, Number(maxEventsPerRun) || 300_000);
    this.maxBatchEvents = Math.max(1, Number(maxBatchEvents) || 300_000);
    this.records = new Map();
  }

  updateLimits({ maxRuns = this.maxRuns, maxEventsPerRun = this.maxEventsPerRun, maxBatchEvents = this.maxBatchEvents } = {}) {
    this.maxRuns = Math.max(1, Number(maxRuns) || this.maxRuns);
    this.maxEventsPerRun = Math.max(1, Number(maxEventsPerRun) || this.maxEventsPerRun);
    this.maxBatchEvents = Math.max(1, Number(maxBatchEvents) || this.maxBatchEvents);
    while (this.records.size > this.maxRuns) {
      const oldest = [...this.records.values()].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))[0];
      if (!oldest) break;
      this.records.delete(oldest.metadata.ref);
    }
    for (const record of this.records.values()) {
      if (record.eventIds.size <= this.maxEventsPerRun) continue;
      const events = [...record.eventsByMetric.values()].flat().sort(compareEvents).slice(-this.maxEventsPerRun);
      record.eventsByMetric = new Map();
      record.eventIds = new Set();
      for (const event of events) {
        const bucket = record.eventsByMetric.get(event.metric) ?? [];
        bucket.push(event);
        record.eventsByMetric.set(event.metric, bucket);
        record.eventIds.add(event.eventId);
      }
      record.acceptedEvents = events.length;
      this._rebuild(record);
    }
  }

  get size() {
    return this.records.size;
  }

  has(ref) {
    return this.records.has(String(ref));
  }

  hasProvider(provider) {
    const wanted = String(provider).toLowerCase();
    return [...this.records.keys()].some((ref) => providerFromRunRef(ref) === wanted);
  }

  _record(ref, run, { mode, source }) {
    let record = this.records.get(ref);
    if (!record) {
      if (this.records.size >= this.maxRuns) {
        throw new AppError("METRIC_RUN_LIMIT_REACHED", "摄入 overlay 已达到 run 数量上限。", { status: 429 });
      }
      record = {
        metadata: normalizeRunMetadata(run, { mode, source, clock: this.clock }),
        eventsByMetric: new Map(),
        eventIds: new Set(),
        revision: 0,
        acceptedEvents: 0,
        updatedAt: nowIso(this.clock),
      };
      this.records.set(ref, record);
    } else {
      record.metadata = {
        ...record.metadata,
        ...normalizeRunMetadata({ ...record.metadata, ...run, ref }, { mode, source, clock: this.clock }),
        mode,
        source: source ?? record.metadata.source,
      };
    }
    return record;
  }

  _rebuild(record) {
    const metricHistory = {};
    const metricUnits = {};
    const metricEvents = {};
    for (const [metric, events] of record.eventsByMetric) {
      const sorted = [...events].sort(compareEvents);
      metricEvents[metric] = sorted.map(clone);
      metricHistory[metric] = sorted.map((event) => ({
        x: event.step,
        y: event.value,
        timestamp: event.timestamp,
      }));
      const unit = sorted.find((event) => event.unit)?.unit;
      if (unit) metricUnits[metric] = unit;
    }
    const metrics = Object.fromEntries(Object.entries(metricHistory)
      .filter(([, points]) => points.length)
      .map(([metric, points]) => [metric, points.at(-1).y]));
    const observedAt = record.updatedAt;
    record.run = normalizeRun({
      ...record.metadata,
      metricHistory,
      metricEvents,
      metricUnits,
      metrics,
      metricSummary: metricSummary(metricHistory, metrics),
      ingestionRevision: record.revision,
      observedAt,
      capabilities: SIMULATION_CAPABILITIES,
    }, {
      provider: record.metadata.provider,
      mode: record.metadata.mode,
      sourceStatus: "ready",
      capabilityProfile: Object.fromEntries(Object.entries(SIMULATION_CAPABILITIES).map(([key, detail]) => [key, detail.status !== "unavailable"])),
      observedAt,
    });
  }

  ingest({ run, events, mode = "simulation", source = "workbench-simulator" } = {}) {
    const ref = validateRunRef(run?.ref ?? events?.[0]?.runRef);
    const batch = validateMetricBatch(events ?? [], { maxEvents: this.maxBatchEvents });
    const previousMetadata = this.records.has(ref) ? JSON.stringify(this.records.get(ref).metadata) : null;
    const record = this._record(ref, { ...(run ?? {}), ref }, { mode, source });
    const metadataChanged = previousMetadata !== JSON.stringify(record.metadata);
    if (record.acceptedEvents + batch.length > this.maxEventsPerRun) {
      throw new AppError("METRIC_RUN_TOO_LARGE", "该 run 的指标事件超过存储上限。", {
        status: 422,
        detail: { maxEventsPerRun: this.maxEventsPerRun },
      });
    }
    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    const errors = [];
    for (const raw of batch) {
      try {
        const event = normalizeMetricEvent(raw, { runRef: ref, source, clock: this.clock });
        if (event.runRef !== ref) {
          throw new AppError("METRIC_EVENT_RUN_MISMATCH", "事件 runRef 与批次 run 不一致。", { status: 422 });
        }
        if (record.eventIds.has(event.eventId)) {
          duplicates += 1;
          continue;
        }
        record.eventIds.add(event.eventId);
        const metricEvents = record.eventsByMetric.get(event.metric);
        if (metricEvents) metricEvents.push(event);
        else record.eventsByMetric.set(event.metric, [event]);
        accepted += 1;
      } catch (error) {
        rejected += 1;
        errors.push({ eventId: raw?.eventId ?? null, code: error.code ?? "METRIC_EVENT_INVALID", message: error.message });
      }
    }
    const changed = Boolean(accepted || metadataChanged || !record.run);
    if (changed) {
      record.acceptedEvents += accepted;
      record.revision += 1;
      record.updatedAt = nowIso(this.clock);
      if (String(run?.status ?? "").toUpperCase() === "FINISHED") record.metadata.endedAt = run.endedAt ?? record.updatedAt;
      this._rebuild(record);
    }
    return {
      schemaVersion: METRIC_INGESTION_SCHEMA,
      runRef: ref,
      accepted,
      duplicates,
      rejected,
      errors,
      changed,
      latest: clone(record.run?.metrics ?? {}),
      metricSummary: clone(record.run?.metricSummary ?? {}),
      revision: record.revision,
      mode: record.metadata.mode,
      sourceStatus: "ready",
      observedAt: record.updatedAt,
    };
  }

  get(ref) {
    const record = this.records.get(String(ref));
    if (!record) return null;
    return {
      run: clone(record.run),
      revision: record.revision,
      observedAt: record.updatedAt,
      source: record.metadata.source,
    };
  }

  listRuns({ limit = 100, group = null, status = null } = {}) {
    let runs = [...this.records.values()].map((record) => record.run).filter(Boolean);
    if (group) runs = runs.filter((run) => String(run.group) === String(group));
    if (status) runs = runs.filter((run) => String(run.status).toLowerCase() === String(status).toLowerCase());
    runs.sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)));
    return {
      items: runs.slice(0, Math.min(300, Number(limit) || 100)).map(summarizeIngestedRun),
      nextCursor: null,
      sourceStatus: "ready",
      mode: "simulation",
      observedAt: nowIso(this.clock),
    };
  }

  listExperiments({ limit = 100 } = {}) {
    if (!this.records.size) return { items: [], nextCursor: null, sourceStatus: "ready", mode: "simulation", observedAt: nowIso(this.clock) };
    return {
      items: [{ id: "workbench-simulation", name: "workbench-training-simulation", provider: "simulation", kind: "simulation" }].slice(0, Number(limit) || 100),
      nextCursor: null,
      sourceStatus: "ready",
      mode: "simulation",
      observedAt: nowIso(this.clock),
    };
  }

  detail(ref, { metricKeys = [], maxPoints = 240 } = {}) {
    const item = this.get(ref);
    if (!item) throw new AppError("EXPERIMENT_REF_NOT_FOUND", "没有找到摄入的实验 run。", { status: 404, detail: { ref } });
    const lines = this.series(ref, { metricKeys, maxPoints });
    return {
      schemaVersion: "experiment-detail.v1",
      run: { ...item.run, series: lines.series },
      series: lines,
      source: { provider: item.run.provider, mode: item.run.mode, degradedReason: null, observedAt: item.observedAt },
      capabilities: item.run.capabilityProfile,
      capabilityDetails: item.run.capabilityDetails,
      warnings: [],
    };
  }

  series(ref, { metricKeys = [], maxPoints = 240 } = {}) {
    const item = this.get(ref);
    if (!item) throw new AppError("EXPERIMENT_REF_NOT_FOUND", "没有找到摄入的实验 run。", { status: 404, detail: { ref } });
    const series = normalizeSeries(item.run.metricHistory, { metricKeys, maxPoints }).map((line) => ({
      ...line,
      unit: item.run.metricUnits?.[line.key] ?? null,
      aggregation: line.downsampled ? "extrema-bucket" : "none",
    }));
    return {
      schemaVersion: "experiment-series.v1",
      ref: item.run.ref,
      provider: item.run.provider,
      sourceStatus: "ready",
      mode: item.run.mode,
      revision: item.revision,
      observedAt: item.observedAt,
      series,
    };
  }

  snapshot() {
    return {
      source: "workbench-simulator",
      provider: "simulation",
      mode: "simulation",
      sourceStatus: "ready",
      observedAt: nowIso(this.clock),
      runs: [...this.records.values()].map((record) => record.run).filter(Boolean).map(summarizeIngestedRun),
    };
  }

  descriptor() {
    return {
      id: "workbench-simulator",
      kind: "source",
      provider: "simulation",
      contract: "experiment-provider.v1",
      label: "Training simulator",
      mode: "simulation",
      capabilities: ["metric-ingestion", "scalar-history", "summary", "agent-context", "chart"],
      capabilityProfile: {
        structuredRun: true,
        history: true,
        metricHistory: true,
        artifacts: false,
        inputs: false,
        inputLineage: false,
        media: false,
      },
      capabilityDetails: SIMULATION_CAPABILITIES,
      health: { status: "ready", detail: `${this.records.size} simulated run(s) in memory`, checkedAt: nowIso(this.clock) },
    };
  }

  status() {
    return {
      observedAt: nowIso(this.clock),
      mode: "simulation",
      sourceStatus: "ready",
      runCount: this.records.size,
      eventCount: [...this.records.values()].reduce((sum, record) => sum + record.acceptedEvents, 0),
      revisions: Object.fromEntries([...this.records.entries()].map(([ref, record]) => [ref, record.revision])),
    };
  }
}
