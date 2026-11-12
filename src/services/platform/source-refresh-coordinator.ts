import type { AdapterRegistry } from "./adapter-registry.js";
import type { TopologyService } from "../topology/topology-service.js";
import type { ResearchState } from "../research/research-state.js";
import type { SourceSnapshot } from "../../domain/research/types.js";
export type SourceRefreshResult = { schemaVersion: string; outcome: string; reason: string; changed: boolean; previousStateVersion: string | null; stateVersion: string | null; checkedAt: string | null; snapshot: SourceSnapshot | null };
type RefreshOptions = { registry: AdapterRegistry; topologyService: TopologyService; state: ResearchState; intervalMs?: number; freshForMs?: number; enabled?: boolean; isBlocked?: () => boolean; onResult?: ((result: SourceRefreshResult) => unknown) | null; now?: () => Date | string | number };
function asDate(value: Date | string | number) {
  return value instanceof Date ? value : new Date(value);
}

export class SourceRefreshCoordinator {
  registry: AdapterRegistry; topologyService: TopologyService; state: ResearchState;
  intervalMs: number; freshForMs: number; enabled: boolean; isBlocked: () => boolean;
  onResult: RefreshOptions["onResult"]; now: NonNullable<RefreshOptions["now"]>;
  inFlight: Promise<SourceRefreshResult> | null; timer: ReturnType<typeof setInterval> | null;
  constructor({
    registry,
    topologyService,
    state,
    intervalMs = 60_000,
    freshForMs = 15_000,
    enabled = true,
    isBlocked = () => false,
    onResult = null,
    now = () => new Date(),
  }: RefreshOptions) {
    this.registry = registry;
    this.topologyService = topologyService;
    this.state = state;
    this.intervalMs = Math.max(1_000, Number(intervalMs) || 60_000);
    this.freshForMs = Math.max(0, Number(freshForMs) || 0);
    this.enabled = Boolean(enabled);
    this.isBlocked = isBlocked;
    this.onResult = onResult;
    this.now = now;
    this.inFlight = null;
    this.timer = null;
  }

  start({ immediate = true } = {}) {
    if (!this.enabled || this.timer) return;
    this.scheduleNext();
    this.timer = setInterval(() => {
      this.scheduleNext();
      void this.refresh({ reason: "scheduled", force: true }).catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
    if (immediate) queueMicrotask(() => {
      void this.refresh({ reason: "server-start", force: true }).catch(() => {});
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state.setNextSourceRefresh(null);
  }

  updateSettings({ enabled = this.enabled, intervalMs = this.intervalMs, freshForMs = this.freshForMs } = {}) {
    const nextEnabled = Boolean(enabled);
    const nextInterval = Math.max(1_000, Number(intervalMs) || this.intervalMs);
    const nextFreshFor = Math.max(0, Number(freshForMs) || 0);
    const changed = nextEnabled !== this.enabled || nextInterval !== this.intervalMs || nextFreshFor !== this.freshForMs;
    this.enabled = nextEnabled;
    this.intervalMs = nextInterval;
    this.freshForMs = nextFreshFor;
    if (!changed) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.enabled) this.start({ immediate: false });
    else this.state.setNextSourceRefresh(null);
  }

  scheduleNext() {
    const next = new Date(asDate(this.now()).getTime() + this.intervalMs).toISOString();
    this.state.setNextSourceRefresh(next);
  }

  isFresh(maxAgeMs = this.freshForMs) {
    if (!this.state.snapshot || !this.state.sourceRefresh.lastCheckedAt) return false;
    const checkedAt = new Date(this.state.sourceRefresh.lastCheckedAt).getTime();
    return Number.isFinite(checkedAt) && asDate(this.now()).getTime() - checkedAt < Math.max(0, maxAgeMs);
  }

  result(outcome: string, reason: string, details: Partial<Pick<SourceRefreshResult, "previousStateVersion" | "stateVersion" | "checkedAt">> = {}): SourceRefreshResult {
    const hasPreviousStateVersion = Object.hasOwn(details, "previousStateVersion");
    const hasStateVersion = Object.hasOwn(details, "stateVersion");
    return {
      schemaVersion: "source-refresh-result.v1",
      outcome,
      reason,
      changed: outcome === "updated",
      previousStateVersion: hasPreviousStateVersion ? details.previousStateVersion ?? null : (this.state.snapshot?.stateVersion ?? null),
      stateVersion: hasStateVersion ? details.stateVersion ?? null : (this.state.snapshot?.stateVersion ?? null),
      checkedAt: details.checkedAt ?? this.state.sourceRefresh.lastCheckedAt,
      snapshot: this.state.snapshot,
    };
  }

  ensureFresh({ reason = "context-boundary", maxAgeMs = this.freshForMs } = {}) {
    return this.refresh({ reason, force: false, maxAgeMs });
  }

  async refresh({ reason = "manual", force = false, maxAgeMs = this.freshForMs } = {}) {
    if (this.inFlight) return this.inFlight;
    if (this.isBlocked()) {
      this.state.deferSourceRefresh(reason);
      return this.result("deferred", reason);
    }
    if (!force && this.isFresh(maxAgeMs)) {
      const checkedAt = this.state.sourceRefresh.lastCheckedAt ?? asDate(this.now()).toISOString();
      this.state.completeSourceRefresh({ outcome: "skipped_fresh", reason, checkedAt, changed: false });
      const skipped = this.result("skipped_fresh", reason, { checkedAt });
      try { Promise.resolve(this.onResult?.(skipped)).catch(() => {}); } catch { /* observers must not break refresh */ }
      return skipped;
    }

    const previousStateVersion = this.state.snapshot?.stateVersion ?? null;
    this.state.beginSourceRefresh(reason);
    this.inFlight = (async () => {
      try {
        const snapshot = await this.registry.syncSources();
        const changed = snapshot.stateVersion !== previousStateVersion;
        if (changed) {
          const refreshedTopology = this.topologyService.build(snapshot);
          const mergedTopology = this.topologyService.mergePersistentState(refreshedTopology, this.state.topology);
          this.state.setSnapshot(snapshot, mergedTopology);
        } else {
          this.state.confirmSnapshot(snapshot);
        }
        const checkedAt = snapshot.observedAt ?? asDate(this.now()).toISOString();
        this.state.completeSourceRefresh({
          outcome: changed ? "updated" : "unchanged",
          reason,
          checkedAt,
          changed,
        });
        const refreshed = this.result(changed ? "updated" : "unchanged", reason, {
          previousStateVersion,
          stateVersion: snapshot.stateVersion,
          checkedAt,
        });
        try { Promise.resolve(this.onResult?.(refreshed)).catch(() => {}); } catch { /* observers must not break refresh */ }
        return refreshed;
      } catch (error) {
        this.state.failSourceRefresh(error, reason);
        throw error;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}
