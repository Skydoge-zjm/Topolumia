import { AppError } from "../../lib/errors.js";
import {
  EXPERIMENT_CONTEXT_SCHEMA,
  EXPERIMENT_DETAIL_SCHEMA,
  EXPERIMENT_INDEX_SCHEMA,
  EXPERIMENT_SERIES_SCHEMA,
  MAX_ARTIFACT_BYTES,
  MAX_CONTEXT_METRICS,
  MAX_CONTEXT_RUNS,
  hashLocator,
  normalizeRun,
  renderMetricChart,
  sanitizeSvg,
  svgDataUrl,
  validateExperimentQuery,
} from "../../domain/experiments/experiment-domain.js";
import {
  aggregateSourceStatus,
  assertExperimentProvider,
  capabilityProfileWithDetails,
  mergeCapabilityProfiles,
  providerSourceStatus,
} from "../../domain/experiments/experiment-provider.js";
import { MetricIngestionStore } from "./metric-ingestion-store.js";

const DEFAULTS = Object.freeze({
  listTtlMs: 15_000,
  detailTtlMs: 30_000,
  seriesTtlMs: 30_000,
  contextTtlMs: 30_000,
  descriptorTtlMs: 30_000,
  maxListRuns: 300,
  maxCacheEntries: 256,
  maxIngestionRuns: 32,
  maxIngestionEventsPerRun: 300_000,
  maxIngestionBatchEvents: 300_000,
});

function nowIso(clock) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function nowMs(clock) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).getTime();
}

function asError(error, fallbackCode = "EXPERIMENT_PROVIDER_UNAVAILABLE") {
  if (error instanceof AppError) return error;
  return new AppError(fallbackCode, error?.message ?? String(error), {
    status: 503,
    retryable: true,
    detail: { reason: error?.message ?? String(error) },
  });
}

function compactResource(resource) {
  const rawUri = resource?.uri ?? null;
  let uri = rawUri;
  if (typeof rawUri === "string") {
    try {
      const parsed = new URL(rawUri);
      parsed.search = "";
      parsed.hash = "";
      uri = parsed.toString();
    } catch {
      uri = rawUri.split("?")[0].split("#")[0];
    }
  }
  return Object.fromEntries(Object.entries({
    ref: resource?.ref ?? null,
    path: resource?.path ?? resource?.name ?? null,
    name: resource?.name ?? null,
    kind: resource?.kind ?? null,
    mimeType: resource?.mimeType ?? null,
    size: resource?.size ?? null,
    uri,
    digest: resource?.digest ?? null,
    direction: resource?.direction ?? null,
    downloadable: resource?.downloadable ?? false,
  }).filter(([, value]) => value !== null));
}

function boundedValue(value, depth = 0) {
  if (typeof value === "string") return value.length > 2_000 ? `${value.slice(0, 2_000)}...` : value;
  if (value === null || ["number", "boolean"].includes(typeof value)) return value;
  if (depth >= 4) return "[nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => boundedValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, boundedValue(item, depth + 1)]));
  }
  return String(value ?? "");
}

function compactMap(value, { keys = null, limit = 64 } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const selected = Array.isArray(keys) && keys.length ? keys.filter((key) => Object.hasOwn(source, key)) : Object.keys(source).slice(0, limit);
  return Object.fromEntries(selected.map((key) => [key, boundedValue(source[key])]));
}

function compactRun(run, source = {}, { includeResourceRefs = false, metricKeys = null } = {}) {
  const compact = {
    ref: run.ref,
    provider: run.provider,
    externalId: run.externalId,
    label: run.label,
    group: run.group ?? null,
    status: run.status,
    startedAt: run.startedAt ?? null,
    endedAt: run.endedAt ?? null,
    observedAt: run.observedAt ?? source.observedAt ?? null,
    sourceStatus: run.sourceStatus ?? providerSourceStatus(source),
    mode: run.mode ?? source.mode ?? "fixture",
    experiment: run.experiment ?? (run.experimentId ? { id: run.experimentId } : null),
    metrics: compactMap(run.metrics, { keys: metricKeys }),
    metricSummary: compactMap(run.metricSummary, { keys: metricKeys }),
    metricPointCounts: compactMap(run.metricPointCounts, { limit: 64 }),
    eventCount: run.eventCount ?? null,
    params: compactMap(run.params, { limit: 100 }),
    tags: compactMap(run.tags, { limit: 100 }),
    artifactCount: run.artifacts?.length ?? 0,
    inputCount: run.inputs?.length ?? 0,
    capabilityProfile: run.capabilityProfile ?? {},
    capabilityDetails: run.capabilityDetails ?? run.capabilities ?? {},
    errorMessage: run.errorMessage ?? null,
  };
  if (includeResourceRefs) {
    compact.artifacts = (run.artifacts ?? []).slice(0, 32).map(compactResource);
    compact.inputs = (run.inputs ?? []).slice(0, 32).map(compactResource);
  }
  return compact;
}

function cacheAge(entry, clock) {
  if (!entry) return Infinity;
  return Math.max(0, nowMs(clock) - entry.createdAt);
}

function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(",")}}`;
}

function sourceSummary(key, adapter, snapshot, error = null) {
  const source = snapshot ?? {};
  const status = error
    ? ((source.runs?.length ?? 0) > 0 ? "degraded" : "unavailable")
    : providerSourceStatus(source);
  return {
    provider: key,
    adapterId: adapter?.id ?? `${key}-adapter`,
    status,
    mode: source.mode ?? (error ? "unavailable" : "fixture"),
    observedAt: source.observedAt ?? null,
    degradedReason: source.degradedReason ?? error?.message ?? null,
    runCount: Array.isArray(source.runs) ? source.runs.length : 0,
  };
}

function normalizeSnapshot(provider, adapter, snapshot, clock) {
  const raw = snapshot && typeof snapshot === "object" ? snapshot : {};
  const mode = raw.mode ?? "fixture";
  const sourceStatus = providerSourceStatus(raw, mode === "unavailable" ? "unavailable" : "ready");
  const observedAt = raw.observedAt ?? nowIso(clock);
  const runs = (raw.runs ?? raw.items ?? []).map((run) => normalizeRun(run, {
    provider,
    mode,
    sourceStatus,
    capabilityProfile: raw.capabilityProfile ?? {},
    observedAt,
  }));
  return {
    ...raw,
    source: raw.source ?? adapter?.id ?? `${provider}-adapter`,
    provider,
    mode,
    sourceStatus,
    observedAt,
    runs,
  };
}

function snapshotFingerprint(snapshot) {
  return JSON.stringify((snapshot?.runs ?? []).map((run) => ({
    ref: run.ref,
    version: run.version ?? null,
    status: run.status ?? null,
    metrics: run.metrics ?? {},
    metricSummary: run.metricSummary ?? {},
    params: run.params ?? {},
    tags: run.tags ?? {},
    artifacts: run.artifacts ?? [],
    inputs: run.inputs ?? [],
    errorMessage: run.errorMessage ?? null,
  })));
}

/**
 * Provider-neutral orchestration layer for experiment tracking sources.
 * Adapters own provider protocols; this class owns research semantics,
 * freshness, fan-out, bounded context generation and degradation behavior.
 */
export class ExperimentTrackingGateway {
  constructor(config = {}, options = {}) {
    this.config = config;
    this.clock = options.clock ?? (() => new Date());
    this.options = { ...DEFAULTS, ...(config.experimentGateway ?? {}) };
    this.providers = new Map();
    for (const [name, adapter] of Object.entries(options.providers ?? {})) {
      this.register(name, adapter);
    }
    this.snapshotCache = new Map();
    this.queryCache = new Map();
    this.descriptorCache = null;
    this.inFlight = new Map();
    this.ingestion = options.ingestionStore ?? new MetricIngestionStore({
      clock: this.clock,
      maxRuns: this.options.maxIngestionRuns,
      maxEventsPerRun: this.options.maxIngestionEventsPerRun,
      maxBatchEvents: this.options.maxIngestionBatchEvents,
    });
    this.lastSync = null;
    this.lastSyncSelection = null;
    this.stats = {
      syncCount: 0,
      syncFailures: 0,
      cacheHits: 0,
      cacheMisses: 0,
      queryCount: 0,
      ingestedEvents: 0,
    };
  }

  updateSettings(settings = {}) {
    const numeric = (key, fallback) => {
      const value = Number(settings[key]);
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    this.options = {
      ...this.options,
      listTtlMs: numeric("listTtlMs", this.options.listTtlMs),
      detailTtlMs: numeric("detailTtlMs", this.options.detailTtlMs),
      seriesTtlMs: numeric("seriesTtlMs", this.options.seriesTtlMs),
      contextTtlMs: numeric("contextTtlMs", this.options.contextTtlMs),
      descriptorTtlMs: numeric("descriptorTtlMs", this.options.descriptorTtlMs),
      maxListRuns: numeric("maxListRuns", this.options.maxListRuns),
      maxCacheEntries: numeric("maxCacheEntries", this.options.maxCacheEntries),
      maxIngestionRuns: numeric("maxIngestionRuns", this.options.maxIngestionRuns),
      maxIngestionEventsPerRun: numeric("maxIngestionEventsPerRun", this.options.maxIngestionEventsPerRun),
      maxIngestionBatchEvents: numeric("maxIngestionBatchEvents", this.options.maxIngestionBatchEvents),
    };
    this.ingestion.updateLimits?.({
      maxRuns: this.options.maxIngestionRuns,
      maxEventsPerRun: this.options.maxIngestionEventsPerRun,
      maxBatchEvents: this.options.maxIngestionBatchEvents,
    });
    this._invalidateQueries();
    this.descriptorCache = null;
    return this.options;
  }

  register(name, adapter) {
    const key = String(name).toLowerCase();
    this.providers.set(key, assertExperimentProvider(adapter, key));
    this.descriptorCache = null;
    return this;
  }

  invalidateConnection(provider) {
    const adapter = this.providers.get(provider);
    if (adapter) { adapter.lastSnapshot = null; adapter.lastLiveError = null; }
    this.snapshotCache.delete(provider);
    this.lastSync = null;
    this.lastSyncSelection = null;
    this.descriptorCache = null;
    this._invalidateQueries();
  }

  providerFor(ref) {
    const match = String(ref ?? "").match(/^([a-z0-9_-]+):run:/i);
    if (!match) {
      throw new AppError("EXPERIMENT_REF_INVALID", "实验引用格式无效。", { status: 422, detail: { ref } });
    }
    const provider = match[1].toLowerCase();
    const adapter = this.providers.get(provider);
    if (!adapter) {
      throw new AppError("EXPERIMENT_PROVIDER_UNAVAILABLE", `没有配置 ${provider} 实验适配器。`, {
        status: 503,
        detail: { provider },
      });
    }
    return adapter;
  }

  ingestMetrics(input = {}) {
    const result = this.ingestion.ingest(input);
    this.stats.ingestedEvents += result.accepted;
    if (result.changed) {
      this._invalidateQueries();
      this.descriptorCache = null;
    }
    return result;
  }

  simulationSnapshot() {
    return this.ingestion.size ? this.ingestion.snapshot() : null;
  }

  simulationStatus() {
    return {
      schemaVersion: "training-simulation-status.v1",
      ...this.ingestion.status(),
      runs: this.ingestion.listRuns({ limit: this.options.maxIngestionRuns }).items,
    };
  }

  _runWithKey(key, task) {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(task).finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  async _cached(key, ttlMs, task) {
    this.stats.queryCount += 1;
    const entry = this.queryCache.get(key);
    if (entry && cacheAge(entry, this.clock) < ttlMs) {
      this.stats.cacheHits += 1;
      return entry.value;
    }
    this.stats.cacheMisses += 1;
    return this._runWithKey(`query:${key}`, async () => {
      const secondChance = this.queryCache.get(key);
      if (secondChance && cacheAge(secondChance, this.clock) < ttlMs) {
        this.stats.cacheHits += 1;
        return secondChance.value;
      }
      const value = await task();
      this.queryCache.set(key, { value, createdAt: nowMs(this.clock) });
      this._pruneCache();
      return value;
    });
  }

  _pruneCache() {
    const current = nowMs(this.clock);
    const maxTtl = Math.max(this.options.listTtlMs, this.options.detailTtlMs, this.options.seriesTtlMs, this.options.contextTtlMs);
    for (const [key, entry] of this.queryCache) {
      if (current - entry.createdAt > maxTtl) this.queryCache.delete(key);
    }
    const limit = Math.max(16, Number(this.options.maxCacheEntries) || DEFAULTS.maxCacheEntries);
    if (this.queryCache.size <= limit) return;
    const oldest = [...this.queryCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [key] of oldest.slice(0, this.queryCache.size - limit)) this.queryCache.delete(key);
  }

  _invalidateQueries(provider = null) {
    if (!provider) {
      this.queryCache.clear();
      return;
    }
    // A context/compare cache can contain refs in an array, so matching every
    // cache entry is safer than trying to infer provider ownership from a key.
    // The cache is intentionally bounded by request budgets and remains small
    // in the local-first MVP.
    this.queryCache.clear();
  }

  async descriptors({ force = false } = {}) {
    if (!force && this.descriptorCache && cacheAge(this.descriptorCache, this.clock) < this.options.descriptorTtlMs) {
      return this.descriptorCache.value;
    }
    const descriptors = await Promise.all([...this.providers.entries()].map(async ([provider, adapter]) => {
      try {
        const descriptor = await adapter.descriptor();
        const rich = capabilityProfileWithDetails(descriptor.capabilityProfile ?? {}, descriptor.capabilityDetails);
        return { ...descriptor, provider: descriptor.provider ?? provider, capabilityProfile: rich.capabilityProfile, capabilityDetails: rich.capabilities };
      } catch (error) {
        const normalized = asError(error);
        return {
          id: adapter.id ?? `${provider}-adapter`,
          kind: "source",
          provider,
          label: provider,
          mode: "unavailable",
          capabilities: [],
          capabilityProfile: {},
          capabilityDetails: {},
          health: { status: "unavailable", detail: normalized.message, checkedAt: nowIso(this.clock) },
          error: { code: normalized.code, message: normalized.message },
        };
      }
    }));
    if (this.ingestion.size) descriptors.push(this.ingestion.descriptor());
    this.descriptorCache = { value: descriptors, createdAt: nowMs(this.clock) };
    return descriptors;
  }

  async sync({ providers = null, reason = "manual", force = false } = {}) {
    const requested = providers
      ? [...new Set(providers.map((item) => String(item).toLowerCase()))]
      : [...this.providers.keys()];
    const includeSimulation = requested.includes("simulation") || providers === null;
    const selected = requested.filter((provider) => provider !== "simulation");
    for (const provider of selected) {
      if (!this.providers.has(provider)) {
        throw new AppError("EXPERIMENT_PROVIDER_UNAVAILABLE", `没有配置 ${provider} 实验适配器。`, { status: 503, detail: { provider } });
      }
    }
    if (requested.includes("simulation") && !this.ingestion.size) {
      throw new AppError("EXPERIMENT_PROVIDER_UNAVAILABLE", "尚未有可同步的 simulation overlay。", { status: 503, detail: { provider: "simulation" } });
    }
    const selectionKey = [...requested].sort().join(",");
    if (!force && this.lastSync && this.lastSyncSelection === selectionKey && cacheAge({ createdAt: Date.parse(this.lastSync.completedAt) }, this.clock) < this.options.listTtlMs) {
      return { ...this.lastSync, reason, skipped: true, skipReason: "fresh" };
    }
    const key = `sync:${selectionKey}:${force ? "force" : "normal"}`;
    return this._runWithKey(key, async () => {
      const startedAt = nowMs(this.clock);
      const entries = await Promise.all(selected.map(async (provider) => {
        const adapter = this.providers.get(provider);
        const previous = this.snapshotCache.get(provider)?.snapshot ?? null;
        try {
          const raw = await adapter.snapshot();
          const snapshot = normalizeSnapshot(provider, adapter, raw, this.clock);
          const changed = snapshotFingerprint(snapshot) !== snapshotFingerprint(previous);
          this.snapshotCache.set(provider, { snapshot, createdAt: nowMs(this.clock), lastError: null });
          this._invalidateQueries(provider);
          return { provider, adapter, snapshot, changed, error: null };
        } catch (error) {
          const normalized = asError(error);
          this.stats.syncFailures += 1;
          const fallback = previous
            ? normalizeSnapshot(provider, adapter, { ...previous, mode: previous.mode, sourceStatus: "degraded", degradedReason: normalized.message }, this.clock)
            : normalizeSnapshot(provider, adapter, {
              source: adapter.id,
              provider,
              mode: "unavailable",
              sourceStatus: "unavailable",
              degradedReason: normalized.message,
              observedAt: nowIso(this.clock),
              runs: [],
            }, this.clock);
          this.snapshotCache.set(provider, { snapshot: fallback, createdAt: nowMs(this.clock), lastError: normalized });
          return { provider, adapter, snapshot: fallback, changed: false, error: normalized };
        }
      }));
      this.stats.syncCount += 1;
      const snapshots = Object.fromEntries(entries.map((entry) => [entry.provider, entry.snapshot]));
      const simulation = includeSimulation ? this.simulationSnapshot() : null;
      if (simulation) snapshots.simulation = simulation;
      const sourceSummaries = entries.map((entry) => sourceSummary(entry.provider, entry.adapter, entry.snapshot, entry.error));
      if (simulation) sourceSummaries.push(sourceSummary("simulation", this.ingestion, simulation));
      const warnings = entries.filter((entry) => entry.error || entry.snapshot.degradedReason).map((entry) => ({
        provider: entry.provider,
        code: entry.error?.code ?? "EXPERIMENT_SOURCE_DEGRADED",
        message: entry.error?.message ?? entry.snapshot.degradedReason,
      }));
      const result = {
        schemaVersion: "experiment-gateway-sync.v1",
        reason,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: nowIso(this.clock),
        durationMs: Math.max(0, nowMs(this.clock) - startedAt),
        snapshots,
        providers: sourceSummaries,
        warnings,
        sourceStatus: aggregateSourceStatus(sourceSummaries.map((item) => item.status)),
        changed: entries.some((entry) => entry.changed),
      };
      this.lastSync = result;
      this.lastSyncSelection = selectionKey;
      return result;
    });
  }

  /** Compatibility method used by the existing source refresh coordinator. */
  async syncSnapshots(options = {}) {
    const result = await this.sync(options);
    return result.snapshots;
  }

  async _listProvider(provider, adapter, options) {
    try {
      const page = await adapter.listRuns(options);
      const snapshot = this.snapshotCache.get(provider)?.snapshot;
      const source = { ...snapshot, ...page, provider };
      const items = (page.items ?? page.runs ?? []).map((run) => normalizeRun(run, {
        provider,
        mode: page.mode ?? snapshot?.mode ?? "fixture",
        sourceStatus: page.sourceStatus ?? providerSourceStatus(snapshot),
        observedAt: page.observedAt ?? snapshot?.observedAt ?? nowIso(this.clock),
        capabilityProfile: page.capabilityProfile ?? snapshot?.capabilityProfile ?? {},
      }));
      return { provider, adapter, page: { ...page, items, source }, error: null };
    } catch (error) {
      const normalized = asError(error);
      const snapshot = this.snapshotCache.get(provider)?.snapshot;
      if (snapshot) {
        return {
          provider,
          adapter,
          page: {
            items: snapshot.runs ?? [],
            nextCursor: null,
            sourceStatus: "degraded",
            mode: snapshot.mode,
            observedAt: snapshot.observedAt,
            source: snapshot,
          },
          error: normalized,
        };
      }
      return {
        provider,
        adapter,
        page: { items: [], nextCursor: null, sourceStatus: "unavailable", mode: "unavailable", observedAt: nowIso(this.clock), source: {} },
        error: normalized,
      };
    }
  }

  _listIngestion(options = {}) {
    const page = this.ingestion.listRuns(options);
    return {
      provider: "simulation",
      adapter: this.ingestion,
      page: {
        ...page,
        items: page.items,
        source: this.ingestion.snapshot(),
      },
      error: null,
    };
  }

  async list({ provider = null, experiment = null, limit = 100, group = null, status = null, cursor = null } = {}) {
    const requestedProvider = provider ? String(provider).toLowerCase() : null;
    const simulationRequested = requestedProvider === "simulation";
    if (requestedProvider && !this.providers.has(requestedProvider) && !(simulationRequested && this.ingestion.hasProvider("simulation"))) {
      throw new AppError("EXPERIMENT_PROVIDER_UNAVAILABLE", `没有配置 ${requestedProvider} 实验适配器。`, { status: 503, detail: { provider: requestedProvider } });
    }
    const selected = requestedProvider
      ? (simulationRequested ? [] : [requestedProvider])
      : [...this.providers.keys()];
    const boundedLimit = Math.min(this.options.maxListRuns, Math.max(1, Number(limit) || 100));
    const key = stableKey({ provider: requestedProvider, experiment, group, status, cursor, limit: boundedLimit });
    return this._cached(`list:${key}`, this.options.listTtlMs, async () => {
      const pages = await Promise.all([
        ...selected.map((name) => this._listProvider(name, this.providers.get(name), { limit: boundedLimit, group, status, cursor })),
        ...((!requestedProvider || simulationRequested) && this.ingestion.size ? [this._listIngestion({ limit: boundedLimit, group, status })] : []),
      ]);
      let items = pages.flatMap(({ page }) => (page.items ?? []).map((run) => compactRun(run, page.source ?? page)));
      if (experiment) {
        const wanted = String(experiment).toLowerCase();
        items = items.filter((item) => String(item.experiment?.name ?? item.experiment?.id ?? "").toLowerCase().includes(wanted));
      }
      items.sort((a, b) => String(b.observedAt ?? "").localeCompare(String(a.observedAt ?? "")));
      const descriptors = await this.descriptors();
      const warnings = pages.filter((item) => item.error).map((item) => ({
        provider: item.provider,
        code: item.error.code,
        message: item.error.message,
      }));
      return {
        schemaVersion: EXPERIMENT_INDEX_SCHEMA,
        items: items.slice(0, boundedLimit),
        nextCursor: pages.find((item) => item.page.nextCursor)?.page.nextCursor ?? null,
        providers: descriptors,
        warnings,
        sourceStatus: aggregateSourceStatus(pages.map((item) => item.page.sourceStatus ?? (item.error ? "unavailable" : "ready"))),
        observedAt: nowIso(this.clock),
      };
    });
  }

  async listExperiments({ provider = null, limit = 100 } = {}) {
    const requested = provider ? String(provider).toLowerCase() : null;
    if (requested === "simulation" && !this.ingestion.size) {
      return { schemaVersion: "experiment-index.v1", items: [], warnings: [], observedAt: nowIso(this.clock) };
    }
    if (requested && requested !== "simulation" && !this.providers.has(requested)) {
      throw new AppError("EXPERIMENT_PROVIDER_UNAVAILABLE", `没有配置 ${requested} 实验适配器。`, { status: 503 });
    }
    const selected = requested
      ? (requested === "simulation" ? [] : [requested])
      : [...this.providers.keys()];
    const pages = await Promise.all(selected.map(async (name) => {
      const adapter = this.providers.get(name);
      if (!adapter) throw new AppError("EXPERIMENT_PROVIDER_UNAVAILABLE", `没有配置 ${name} 实验适配器。`, { status: 503 });
      if (typeof adapter.listExperiments !== "function") return { provider: name, items: [] };
      try { return { provider: name, ...(await adapter.listExperiments({ limit })) }; }
      catch (error) { return { provider: name, items: [], error: asError(error) }; }
    }));
    const items = pages.flatMap((page) => (page.items ?? []).map((item) => ({ ...item, provider: item.provider ?? page.provider })));
    if ((!requested || requested === "simulation") && this.ingestion.size) {
      items.push(...(this.ingestion.listExperiments({ limit }).items ?? []));
    }
    return {
      schemaVersion: "experiment-index.v1",
      items,
      warnings: pages.filter((page) => page.error).map((page) => ({ provider: page.provider, code: page.error.code, message: page.error.message })),
      observedAt: nowIso(this.clock),
    };
  }

  async detail(ref, { metricKeys = [], maxPoints = 240 } = {}) {
    const query = validateExperimentQuery({ metrics: metricKeys, maxPoints });
    if (this.ingestion.has(ref)) {
      const key = stableKey({ ref, metrics: query.metrics, maxPoints: query.maxPoints });
      return this._cached(`detail:${key}`, this.options.detailTtlMs, async () => this.ingestion.detail(ref, {
        metricKeys: query.metrics,
        maxPoints: query.maxPoints,
      }));
    }
    const adapter = this.providerFor(ref);
    const key = stableKey({ ref, metrics: query.metrics, maxPoints: query.maxPoints });
    return this._cached(`detail:${key}`, this.options.detailTtlMs, async () => {
      const detail = await adapter.getRun(ref);
      const run = normalizeRun(detail?.run ?? detail, {
        provider: String(ref).split(":", 1)[0].toLowerCase(),
        mode: detail?.source?.mode ?? "fixture",
        sourceStatus: detail?.source?.degradedReason ? "degraded" : "ready",
        capabilityProfile: detail?.run?.capabilityProfile ?? detail?.capabilities ?? {},
        observedAt: detail?.source?.observedAt ?? nowIso(this.clock),
      });
      const [seriesResult, artifactsResult] = await Promise.allSettled([
        adapter.getSeries(ref, { metricKeys: query.metrics, maxPoints: query.maxPoints }),
        typeof adapter.listArtifacts === "function" ? adapter.listArtifacts(ref) : Promise.resolve({ items: [] }),
      ]);
      const warnings = [];
      let series;
      if (seriesResult.status === "fulfilled") {
        series = seriesResult.value;
      } else {
        const error = asError(seriesResult.reason, "EXPERIMENT_CAPABILITY_UNAVAILABLE");
        warnings.push({ code: error.code, message: error.message });
        series = {
          schemaVersion: EXPERIMENT_SERIES_SCHEMA,
          ref: run.ref,
          provider: run.provider,
          sourceStatus: "partial",
          observedAt: run.observedAt,
          series: [],
        };
      }
      const artifacts = artifactsResult.status === "fulfilled"
        ? artifactsResult.value?.items ?? run.artifacts ?? []
        : run.artifacts ?? [];
      if (artifactsResult.status === "rejected") {
        const error = asError(artifactsResult.reason, "EXPERIMENT_CAPABILITY_UNAVAILABLE");
        warnings.push({ code: error.code, message: error.message });
      }
      const normalizedRun = {
        ...run,
        series: series.series ?? [],
        artifacts,
        sourceStatus: series.sourceStatus ?? run.sourceStatus,
      };
      return {
        schemaVersion: EXPERIMENT_DETAIL_SCHEMA,
        run: normalizedRun,
        series,
        source: {
          provider: run.provider,
          mode: run.mode,
          degradedReason: detail?.source?.degradedReason ?? null,
          observedAt: detail?.source?.observedAt ?? run.observedAt,
        },
        capabilities: normalizedRun.capabilityProfile,
        capabilityDetails: normalizedRun.capabilityDetails ?? normalizedRun.capabilities,
        warnings,
      };
    });
  }

  async series(ref, options = {}) {
    const query = validateExperimentQuery(options);
    if (this.ingestion.has(ref)) {
      const key = stableKey({ ref, metrics: query.metrics, maxPoints: query.maxPoints });
      return this._cached(`series:${key}`, this.options.seriesTtlMs, async () => this.ingestion.series(ref, {
        metricKeys: query.metrics,
        maxPoints: query.maxPoints,
      }));
    }
    const adapter = this.providerFor(ref);
    const key = stableKey({ ref, metrics: query.metrics, maxPoints: query.maxPoints });
    return this._cached(`series:${key}`, this.options.seriesTtlMs, async () => {
      const result = await adapter.getSeries(ref, { metricKeys: query.metrics, maxPoints: query.maxPoints });
      return {
        ...result,
        schemaVersion: EXPERIMENT_SERIES_SCHEMA,
        sourceStatus: result.sourceStatus ?? "ready",
        observedAt: result.observedAt ?? nowIso(this.clock),
      };
    });
  }

  async chart(ref, { metricKeys = [], maxPoints = 240, width = 760, height = 360 } = {}) {
    const query = validateExperimentQuery({ metrics: metricKeys, maxPoints });
    const boundedWidth = Math.min(1_600, Math.max(320, Number(width) || 760));
    const boundedHeight = Math.min(2_400, Math.max(148, Number(height) || 360));
    const key = stableKey({ ref, metrics: query.metrics, maxPoints: query.maxPoints, width: boundedWidth, height: boundedHeight });
    return this._cached(`chart:${key}`, this.options.detailTtlMs, async () => {
      const detail = await this.detail(ref, { metricKeys: query.metrics, maxPoints: query.maxPoints });
      const content = renderMetricChart([detail.run], {
        metricKeys: query.metrics.length ? query.metrics : null,
        maxPoints: query.maxPoints,
        width: boundedWidth,
        height: boundedHeight,
      });
      return {
        schemaVersion: "experiment-chart.v1",
        ref,
        provider: detail.run.provider,
        mode: detail.run.mode,
        sourceStatus: detail.run.sourceStatus,
        revision: detail.run.ingestionRevision ?? null,
        observedAt: detail.run.observedAt,
        mimeType: "image/svg+xml",
        size: Buffer.byteLength(content, "utf8"),
        content: sanitizeSvg(content),
      };
    });
  }

  async compare(refs = [], { metricKeys = [], maxPoints = 240 } = {}) {
    const uniqueRefs = [...new Set((Array.isArray(refs) ? refs : []).map(String).filter(Boolean))];
    if (uniqueRefs.length < 2 || uniqueRefs.length > MAX_CONTEXT_RUNS) {
      throw new AppError("EXPERIMENT_CONTEXT_INVALID", "比较需要提供 2 到 8 个实验引用。", { status: 422 });
    }
    const query = validateExperimentQuery({ metrics: metricKeys, maxPoints });
    const results = await Promise.allSettled(uniqueRefs.map((ref) => this.detail(ref, {
      metricKeys: query.metrics,
      maxPoints: query.maxPoints,
    })));
    const warnings = [];
    const details = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") details.push(result.value);
      else {
        const error = asError(result.reason);
        warnings.push({ ref: uniqueRefs[index], code: error.code, message: error.message });
      }
    });
    if (!details.length) {
      const first = results.find((result) => result.status === "rejected");
      throw first?.reason ?? new AppError("EXPERIMENT_REF_NOT_FOUND", "没有可比较的实验。", { status: 404 });
    }
    const runs = details.map((item) => compactRun(item.run, item.source, { metricKeys: query.metrics }));
    const series = details.flatMap((item) => (item.series.series ?? []).map((line) => ({
      ...line,
      runRef: item.run.ref,
      provider: item.run.provider,
      label: item.run.label,
    })));
    const byMetric = new Map();
    for (const line of series) {
      const unit = line.unit ?? null;
      const current = byMetric.get(line.key) ?? new Set();
      current.add(unit);
      byMetric.set(line.key, current);
    }
    for (const [metric, units] of byMetric) {
      if (units.size > 1) warnings.push({ code: "EXPERIMENT_METRIC_UNIT_MISMATCH", metric, message: `${metric} 在不同来源中的单位不一致，未进行数值换算。` });
    }
    return {
      schemaVersion: "experiment-compare.v1",
      refs: uniqueRefs,
      runs,
      series,
      warnings,
      sourceStatus: warnings.length ? "partial" : "ready",
      observedAt: nowIso(this.clock),
    };
  }

  async agentContext(body = {}) {
    const refs = [...new Set(Array.isArray(body.refs) ? body.refs.map(String).filter(Boolean) : [])];
    if (!refs.length || refs.length > MAX_CONTEXT_RUNS) {
      throw new AppError("EXPERIMENT_CONTEXT_INVALID", "请提供 1 到 8 个实验引用。", { status: 422 });
    }
    const metricKeys = [...new Set(Array.isArray(body.metrics) ? body.metrics.map(String).filter(Boolean) : [])];
    if (metricKeys.length > MAX_CONTEXT_METRICS) {
      throw new AppError("EXPERIMENT_CONTEXT_INVALID", "一次最多提供 8 个指标。", { status: 422 });
    }
    const maxPoints = body.maxPoints === undefined ? 240 : Number(body.maxPoints);
    validateExperimentQuery({ metrics: metricKeys, maxPoints });
    const cacheKey = stableKey({ refs: [...refs].sort(), metrics: [...metricKeys].sort(), maxPoints, includeCharts: Boolean(body.includeCharts), accepts: body.accepts ?? [] });
    return this._cached(`context:${cacheKey}`, this.options.contextTtlMs, async () => {
      const results = await Promise.allSettled(refs.map((ref) => this.detail(ref, { metricKeys, maxPoints })));
      const details = [];
      const warnings = [];
      const errors = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          details.push(result.value);
          for (const warning of result.value.warnings ?? []) warnings.push(`${refs[index]}: ${warning.message}`);
          if (result.value.run.capabilityProfile?.history === false) warnings.push(`${refs[index]}: metric history unavailable`);
          if (result.value.run.capabilityProfile?.inputs === false) warnings.push(`${refs[index]}: input lineage unavailable`);
        } else {
          const error = asError(result.reason);
          warnings.push(`${refs[index]}: ${error.message}`);
          errors.push({ ref: refs[index], code: error.code, message: error.message, retryable: error.retryable });
        }
      });
      if (!details.length) {
        const first = results.find((result) => result.status === "rejected");
        throw first?.reason ?? new AppError("EXPERIMENT_REF_NOT_FOUND", "没有可用的实验上下文。", { status: 404 });
      }
      const runs = details.map((item) => compactRun(item.run, item.source, { includeResourceRefs: true, metricKeys }));
      const series = details.flatMap((item) => (item.series.series ?? []).map((line) => ({ ...line, runRef: item.run.ref, provider: item.run.provider, label: item.run.label })));
      const assets = [];
      if (body.includeCharts) {
        const accepts = Array.isArray(body.accepts) ? body.accepts : ["text"];
        if (accepts.includes("image/svg+xml") || accepts.includes("image/*") || accepts.includes("image/png")) {
          const svg = renderMetricChart(details.map((item) => item.run), {
            metricKeys: metricKeys.length ? metricKeys : null,
            maxPoints,
          });
          const bytes = Buffer.byteLength(svg, "utf8");
          if (bytes <= MAX_ARTIFACT_BYTES) {
            assets.push({
              ref: `workbench:chart:${hashLocator(refs.join("|"))}`,
              kind: "chart",
              mimeType: "image/svg+xml",
              size: bytes,
              encoding: "utf8",
              content: sanitizeSvg(svg),
              dataUrl: svgDataUrl(svg),
              runRefs: refs,
            });
          } else warnings.push("chart asset exceeds the multimodal context size limit");
        } else warnings.push("includeCharts requested, but caller did not advertise an image input");
      }
      const merged = mergeCapabilityProfiles(details.map((item) => item.run));
      const capabilityDetails = {
        ...merged.details,
        metricSummary: { status: "supported" },
        metricHistory: { status: series.length ? "supported" : "unavailable" },
        chartImage: { status: assets.length ? "supported" : "unavailable" },
        fullLogs: { status: "unavailable", reason: "bounded Agent context does not include full logs" },
      };
      const capabilityFlags = {
        ...merged.flags,
        metricSummary: true,
        metricHistory: series.length > 0,
        chartImage: assets.length > 0,
        fullLogs: false,
      };
      const textPayload = JSON.stringify({ runs, series, warnings, errors, capabilityDetails });
      const content = [{ type: "text", text: textPayload }];
      for (const asset of assets) {
        const data = String(asset.dataUrl ?? "").split(",")[1] ?? "";
        if (data) content.push({ type: "image", mimeType: asset.mimeType, data, assetRef: asset.ref });
      }
      return {
        schemaVersion: EXPERIMENT_CONTEXT_SCHEMA,
        runs,
        series,
        assets,
        content,
        capabilities: capabilityFlags,
        capabilityDetails,
        sourceStatus: aggregateSourceStatus(details.map((item) => item.run.sourceStatus)).toLowerCase() === "ready" && warnings.length ? "partial" : aggregateSourceStatus(details.map((item) => item.run.sourceStatus)),
        warnings,
        errors,
        provenance: {
          refs,
          generatedAt: nowIso(this.clock),
          adapterIds: [...new Set(details.map((item) => item.source?.provider).filter(Boolean))],
          modes: [...new Set(details.map((item) => item.source?.mode).filter(Boolean))],
        },
      };
    });
  }

  async status() {
    const descriptors = await this.descriptors();
    const providers = descriptors.map((descriptor) => {
      if (descriptor.provider === "simulation") {
        return { ...descriptor, snapshot: this.ingestion.status() };
      }
      const cache = this.snapshotCache.get(descriptor.provider);
      return {
        ...descriptor,
        snapshot: cache ? {
          observedAt: cache.snapshot.observedAt ?? null,
          mode: cache.snapshot.mode ?? null,
          sourceStatus: providerSourceStatus(cache.snapshot),
          runCount: cache.snapshot.runs?.length ?? 0,
          lastError: cache.lastError ? { code: cache.lastError.code, message: cache.lastError.message } : null,
        } : null,
      };
    });
    return {
      schemaVersion: "experiment-gateway-status.v1",
      gateway: {
        contract: "experiment-gateway.v1",
        providerCount: this.providers.size + (this.ingestion.size ? 1 : 0),
        inFlight: this.inFlight.size,
        cacheEntries: this.queryCache.size,
        lastSync: this.lastSync,
        stats: { ...this.stats },
      },
      providers,
      observedAt: nowIso(this.clock),
    };
  }
}
