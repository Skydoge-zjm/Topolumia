import test from "node:test";
import assert from "node:assert/strict";
import { ResearchState } from "../../src/services/research/research-state.js";
import { SourceRefreshCoordinator } from "../../src/services/platform/source-refresh-coordinator.js";
import { TopologyService } from "../../src/services/topology/topology-service.js";

function sourceSnapshot(stateVersion, observedAt = "2026-08-18T12:00:00.000Z") {
  return {
    schemaVersion: "source-snapshot.v1",
    stateVersion,
    observedAt,
    git: null,
    files: null,
    sourceErrors: [],
  };
}

function coordinatorFor(snapshots, options = {}) {
  const topologyService = new TopologyService();
  const state = options.state ?? new ResearchState(topologyService.build());
  let calls = 0;
  const registry = {
    async syncSources() {
      const index = Math.min(calls, snapshots.length - 1);
      calls += 1;
      return snapshots[index];
    },
  };
  const coordinator = new SourceRefreshCoordinator({
    registry,
    topologyService,
    state,
    enabled: false,
    now: options.now ?? (() => new Date("2026-08-18T12:00:00.000Z")),
    isBlocked: options.isBlocked ?? (() => false),
  });
  return { coordinator, state, calls: () => calls };
}

test("unchanged source content updates checked time without clearing derived work", async () => {
  const first = sourceSnapshot("source-v1");
  const second = sourceSnapshot("source-v1", "2026-08-18T12:01:00.000Z");
  const { coordinator, state } = coordinatorFor([first, second]);
  await coordinator.refresh({ reason: "manual", force: true });
  state.curatorResult = { id: "curator-keep" };

  const result = await coordinator.refresh({ reason: "manual", force: true });

  assert.equal(result.outcome, "unchanged");
  assert.equal(state.snapshot.observedAt, second.observedAt);
  assert.equal(state.curatorResult.id, "curator-keep");
});

test("changed source content rebuilds current state and invalidates derived curator results", async () => {
  const { coordinator, state } = coordinatorFor([
    sourceSnapshot("source-v1"),
    sourceSnapshot("source-v2", "2026-08-18T12:01:00.000Z"),
  ]);
  await coordinator.refresh({ reason: "manual", force: true });
  state.curatorResult = { id: "curator-stale" };

  const result = await coordinator.refresh({ reason: "scheduled", force: true });

  assert.equal(result.outcome, "updated");
  assert.equal(result.previousStateVersion, "source-v1");
  assert.equal(state.snapshot.stateVersion, "source-v2");
  assert.equal(state.curatorResult, null);
});

test("concurrent source checks share one adapter scan", async () => {
  const topologyService = new TopologyService();
  const state = new ResearchState(topologyService.build());
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const coordinator = new SourceRefreshCoordinator({
    state,
    topologyService,
    enabled: false,
    registry: {
      async syncSources() {
        calls += 1;
        await pending;
        return sourceSnapshot("source-v1");
      },
    },
  });

  const first = coordinator.refresh({ reason: "manual", force: true });
  const second = coordinator.refresh({ reason: "workspace-visible", force: true });
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(firstResult.stateVersion, secondResult.stateVersion);
});

test("freshness guard skips a redundant adapter scan", async () => {
  const now = () => new Date("2026-08-18T12:00:10.000Z");
  const { coordinator, state, calls } = coordinatorFor([sourceSnapshot("source-v1")], { now });
  state.confirmSnapshot(sourceSnapshot("source-v1", "2026-08-18T12:00:00.000Z"));
  state.completeSourceRefresh({ outcome: "unchanged", reason: "manual", checkedAt: "2026-08-18T12:00:00.000Z" });

  const result = await coordinator.ensureFresh({ reason: "before-agent-session", maxAgeMs: 15_000 });

  assert.equal(result.outcome, "skipped_fresh");
  assert.equal(calls(), 0);
});

test("running work defers refresh without reading adapters", async () => {
  const { coordinator, state, calls } = coordinatorFor([sourceSnapshot("source-v1")], { isBlocked: () => true });

  const result = await coordinator.refresh({ reason: "manual", force: true });

  assert.equal(result.outcome, "deferred");
  assert.equal(state.sourceRefresh.status, "deferred");
  assert.equal(calls(), 0);
});

test("refresh failure keeps the last usable snapshot", async () => {
  const topologyService = new TopologyService();
  const state = new ResearchState(topologyService.build());
  state.confirmSnapshot(sourceSnapshot("source-v1"));
  const coordinator = new SourceRefreshCoordinator({
    state,
    topologyService,
    enabled: false,
    registry: { async syncSources() { throw new Error("offline"); } },
  });

  await assert.rejects(coordinator.refresh({ reason: "scheduled", force: true }), /offline/);

  assert.equal(state.snapshot.stateVersion, "source-v1");
  assert.equal(state.sourceRefresh.status, "error");
  assert.equal(state.sourceRefresh.lastOutcome, "failed");
});

test("starting the coordinator performs the first check without user action", async () => {
  const { coordinator, state, calls } = coordinatorFor([sourceSnapshot("source-v1")]);
  coordinator.enabled = true;

  coordinator.start();
  await new Promise((resolve) => setImmediate(resolve));
  coordinator.stop();

  assert.equal(calls(), 1);
  assert.equal(state.snapshot.stateVersion, "source-v1");
});

test("disabling automatic refresh clears the scheduled check", async () => {
  const { coordinator, state } = coordinatorFor([sourceSnapshot("source-v1")]);
  coordinator.enabled = true;
  coordinator.start({ immediate: false });
  assert.ok(state.sourceRefresh.nextScheduledAt);
  coordinator.updateSettings({ enabled: false });
  assert.equal(coordinator.enabled, false);
  assert.equal(state.sourceRefresh.nextScheduledAt, null);
  coordinator.stop();
});
