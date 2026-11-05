import { installTopologyFixture } from "../helpers/topology-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../src/server.js";
import { TopologyService } from "../../src/services/topology/topology-service.js";
import { ResearchState } from "../../src/services/research/research-state.js";
import {
  TopologyCuratorTriggerCoordinator,
  normalizeBTriggerEnvelope,
} from "../../src/services/topology/topology-curator-trigger-coordinator.js";

function makeHarness({ result = null, delay = 0, fail = null, settings = {} } = {}) {
  const topologyService = new TopologyService();
  const topology = topologyService.build();
  const state = new ResearchState(topology);
  const event = state.recordEvent({
    type: "humanResearchMove",
    actor: "user",
    nodeIds: [topology.nodes[0].id],
    sourceRefs: [],
    payload: { text: "需要重新比较两个实验。" },
  }, { skipValidation: true });
  let calls = 0;
  let lastInput = null;
  const driver = {
    async preview(input) {
      calls += 1;
      lastInput = input;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (fail) throw fail;
      return result ?? {
        schemaVersion: "topology-curator-result.v1",
        disposition: "no_op",
        summary: "没有新的长期状态。",
        reason: "当前材料已经覆盖本轮记录。",
        sourceRefs: [],
        evidenceNodeIds: [topology.nodes[0].id],
        inspectedNodeIds: [topology.nodes[0].id],
        inspectedEdgeIds: [],
        uncertainties: [],
        questions: [],
        patch: null,
      };
    },
  };
  const coordinator = new TopologyCuratorTriggerCoordinator({
    topologyCurator: driver,
    topologyService,
    state,
    getSettings: () => ({ curator: { automation: { enabled: false, ...settings } } }),
  });
  return { topologyService, topology, state, event, coordinator, get calls() { return calls; }, get lastInput() { return lastInput; } };
}

test("normalizes an empty or selected working set without fixing B output", () => {
  const harness = makeHarness();
  const empty = normalizeBTriggerEnvelope({}, { topology: harness.topology, snapshot: null });
  assert.equal(empty.mode, "manual");
  assert.equal(empty.cause, "user_request");
  assert.deepEqual(empty.nodeIds, []);
  const selected = normalizeBTriggerEnvelope({ nodeIds: [harness.topology.nodes[0].id], entryContext: { surface: "topology" } }, { topology: harness.topology, snapshot: null });
  assert.deepEqual(selected.nodeIds, [harness.topology.nodes[0].id]);
  assert.equal(selected.entryContext.surface, "topology");
});

test("suggested trigger does not run B; confirmation through manual trigger does", async () => {
  const harness = makeHarness();
  const suggested = await harness.coordinator.trigger({ mode: "suggested", cause: "session_checkpoint" });
  assert.equal(suggested.status, "suggested");
  assert.equal(suggested.requiresConfirmation, true);
  assert.equal(harness.calls, 0);
  const result = await harness.coordinator.trigger({ mode: "manual", cause: "session_checkpoint" });
  assert.equal(result.result.disposition, "no_op");
  assert.equal(harness.calls, 1);
  assert.equal(harness.lastInput.context.trigger.cause, "session_checkpoint");
  assert.equal(harness.lastInput.context.trigger.mode, "manual");
  assert.equal(harness.coordinator.statusView().pendingEventCount, 0);
});

test("background trigger is queued, single-flight, and consumes events only after success", async () => {
  const harness = makeHarness({ delay: 25, settings: { enabled: true, backgroundMode: "background", minPendingEvents: 1 } });
  const queued = await harness.coordinator.trigger({ mode: "background", cause: "experiment_delta" });
  assert.equal(queued.status, "queued");
  const skipped = await harness.coordinator.trigger({ mode: "background", cause: "experiment_delta", entryContext: { action: "duplicate" } });
  assert.equal(skipped.status, "skipped");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(harness.calls, 1);
  assert.equal(harness.coordinator.statusView().status, "available");
  assert.equal(harness.coordinator.statusView().pendingEventCount, 0);
  harness.coordinator.stop();
});

test("manual trigger reports a typed conflict while another B run is active", async () => {
  const harness = makeHarness({ delay: 25 });
  const first = harness.coordinator.trigger({ mode: "manual", cause: "user_request" });
  await assert.rejects(
    () => harness.coordinator.trigger({ mode: "manual", cause: "formal_state_request" }),
    (error) => error.code === "CURATOR_TRIGGER_RUNNING" && error.status === 409,
  );
  await first;
});

test("same successful fingerprint is deduplicated while a failed run leaves events pending", async () => {
  const harness = makeHarness();
  const first = await harness.coordinator.trigger({ mode: "manual", cause: "user_request" });
  const second = await harness.coordinator.trigger({ mode: "manual", cause: "user_request" });
  assert.equal(second.deduplicated, true);
  assert.equal(harness.calls, 1);

  const failure = new Error("runtime unavailable");
  const failed = makeHarness({ fail: failure });
  await assert.rejects(() => failed.coordinator.trigger({ mode: "manual" }), /runtime unavailable/);
  assert.equal(failed.coordinator.statusView().pendingEventCount, 1);
  assert.equal(failed.coordinator.statusView().status, "error");
  assert.equal(first.result.disposition, "no_op");
});

test("automatic trigger obeys the automation switch and pending threshold", async () => {
  const disabled = makeHarness({ settings: { enabled: false } });
  const skipped = await disabled.coordinator.consider("session_checkpoint");
  assert.equal(skipped.status, "skipped");
  assert.equal(disabled.calls, 0);

  const enabled = makeHarness({ settings: { enabled: true, backgroundMode: "suggested", minPendingEvents: 2 } });
  const below = await enabled.coordinator.consider("idle_batch");
  assert.equal(below.status, "skipped");
  const highValue = await enabled.coordinator.consider("session_checkpoint", { force: true });
  assert.equal(highValue.status, "suggested");
  enabled.coordinator.stop();
});

test("topology-change events never become an automatic recursion source", async () => {
  const harness = makeHarness({ settings: { enabled: true, minPendingEvents: 1, backgroundMode: "background" } });
  harness.coordinator.consumedEventIds.add(harness.event.id);
  harness.state.recordEvent({
    type: "topologyChange",
    actor: "agent-b",
    nodeIds: [harness.topology.nodes[0].id],
    sourceRefs: [],
    payload: { action: "preview" },
  }, { skipValidation: true });
  const result = await harness.coordinator.consider("session_checkpoint", { force: true });
  assert.equal(result.status, "skipped");
  assert.equal(harness.calls, 0);
  harness.coordinator.stop();
});

test("a queued trigger is rejected if the formal topology changes before B starts", async () => {
  const harness = makeHarness({ delay: 10, settings: { enabled: true, backgroundMode: "background", minPendingEvents: 1 } });
  const queued = await harness.coordinator.trigger({ mode: "background", cause: "experiment_delta" });
  assert.equal(queued.status, "queued");
  const update = {
    schemaVersion: "topology-patch-proposal.v1",
    id: "patch-test-version",
    idempotencyKey: `sha256:${"c".repeat(64)}`,
    baseStateVersion: harness.state.topology.stateVersion,
    eventRange: { from: null, to: null },
    reason: "test",
    sourceRefs: [],
    evidenceNodeIds: [harness.topology.nodes[0].id],
    curator: { adapter: "test", mode: "real", model: "test" },
    operations: [{ op: "updateNode", nodeId: harness.topology.nodes[0].id, patch: { status: "active" } }],
  };
  harness.state.topology = harness.topologyService.withObjects(harness.state.topology, harness.state.topology.nodes.map(node => node.id === update.operations[0].nodeId ? { ...node, ...update.operations[0].patch } : node), harness.state.topology.edges);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(harness.coordinator.statusView().status, "error");
  assert.equal(harness.coordinator.statusView().pendingEventCount, 1);
  harness.coordinator.stop();
});

test("source version is part of the trigger contract and rejects stale requests", () => {
  const harness = makeHarness();
  const snapshot = { stateVersion: "source-v1", git: { ref: "git:head" } };
  const envelope = normalizeBTriggerEnvelope({ sourceStateVersion: "source-v1" }, { topology: harness.topology, snapshot });
  assert.equal(envelope.sourceStateVersion, "source-v1");
  assert.throws(
    () => normalizeBTriggerEnvelope({ sourceStateVersion: "source-v0" }, { topology: harness.topology, snapshot }),
    (error) => error.code === "SOURCE_VERSION_CONFLICT",
  );
});

test("HTTP trigger and status endpoints expose read-only curation reports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "research-workbench-trigger-api-"));
  let app;
  const driver = {
    async run({ topology }) {
      const id = topology.nodes[0].id;
      return {
        runId: "api-trigger-run",
        model: "test-driver",
        threadId: null,
        usage: null,
        workspacePath: null,
        trace: { observedNodeIds: [id], observedEdgeIds: [], commandExecutions: [] },
        result: {
          schemaVersion: "topology-curator-result.v1",
          disposition: "no_op",
          summary: "没有新的长期状态。",
          reason: "API 合同测试。",
          sourceRefs: [],
          evidenceNodeIds: [id],
          inspectedNodeIds: [id],
          inspectedEdgeIds: [],
          uncertainties: [],
          questions: [],
          patch: null,
        },
      };
    },
  };
  try {
    app = await startMvpServer({
      port: 0,
      config: { sourceRefresh: { enabled: false } },
      userSettingsFile: path.join(root, "settings.json"),
      topologyCuratorDriver: driver,
    });
  installTopologyFixture(app);
    const status = await fetch(`${app.url}/api/topology/curation/status`).then((response) => response.json());
    assert.equal(status.status, "idle");
    const triggerResponse = await fetch(`${app.url}/api/topology/curation/trigger`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "manual", cause: "formal_state_request" }),
    });
    const trigger = await triggerResponse.json();
    assert.equal(triggerResponse.status, 200);
    assert.equal(trigger.status, "available");
    assert.equal(trigger.result.disposition, "no_op");
    const state = await fetch(`${app.url}/api/state`).then((response) => response.json());
    assert.equal(state.curatorTrigger.status, "available");
    const schema = await fetch(`${app.url}/api/schemas/topology-curator-trigger-status`).then((response) => response.json());
    assert.equal(schema.title, "TopologyCuratorTriggerStatusV1");
  } finally {
    if (app?.server) await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
