import test from "node:test";
import assert from "node:assert/strict";
import { TopologyService } from "../../src/services/topology/topology-service.js";
import { deriveExplorationTrace } from "../../src/adapters/agents/codex/codex-exec-client.js";

const forbiddenKinds = new Set([
  "protocol", "experimentGroup", "run", "config", "artifact", "gitCommit",
  "workspaceChange", "delegation", "agentSession", "executionPreview",
]);

test("formal topology is an irregular scientific graph with aggregate experiment nodes", () => {
  const topology = new TopologyService().build();
  assert.equal(topology.schemaVersion, "research-topology.v1");
  assert.ok(topology.nodes.length >= 18);
  assert.ok(topology.edges.length >= 25);
  assert.equal(topology.nodes.some((item) => forbiddenKinds.has(item.kind)), false);
  assert.deepEqual(
    topology.nodes.filter((item) => item.kind === "experiment").map((item) => item.id),
    ["experiment:g0", "experiment:g1", "experiment:g2", "experiment:g3"],
  );
  const g1 = topology.nodes.find((item) => item.id === "experiment:g1");
  assert.equal(g1.data.runSummary.failed, 1);
  assert.equal(g1.data.runSummary.unstable, 1);
  assert.ok(topology.nodes.every(item => ["paper", "experiment", "note"].includes(item.kind)));
  assert.ok(topology.nodes.some(item => item.kind === "note" && item.id === "gap:seed-variance"));
  assert.ok(topology.edges.some((item) => item.type === "alternative"));
  const xPositions = topology.nodes.map((item) => item.position.x);
  assert.ok(new Set(xPositions).size > 14, "nodes must not collapse into regular columns");
  const spine = [
    "question:perception-distortion",
    "hypothesis:conditioning-main-effect",
    "experiment:g1",
    "observation:perception-distortion",
    "inference:factor-confounding",
    "claim:conditioning-provisional",
    "experiment:g3",
  ].map((id) => topology.nodes.find((item) => item.id === id).position.y);
  assert.deepEqual(spine, [...spine].sort((a, b) => a - b), "the scientific spine must remain readable top-to-bottom");
});

test("execution previews remain outside the formal graph", () => {
  const service = new TopologyService();
  const base = service.build();
  const previewed = service.withExecutionPreview(base, { id: "preview" });
  assert.equal(previewed.nodes.some((item) => forbiddenKinds.has(item.kind)), false);
  assert.equal(previewed.nodes.length, base.nodes.length);
  assert.equal(previewed.edges.length, base.edges.length);
});

test("Codex JSONL command evidence maps experiment node files and edge files", () => {
  const trace = deriveExplorationTrace({
    nodeFileById: {
      "question:perception-distortion": "topology/nodes/04-question-perception-distortion.json",
      "experiment:g0": "topology/nodes/09-experiment-g0.json",
    },
    edgeIds: ["e:q-h1", "e:q-g0"],
  }, {
    stderr: "",
    commandExecutions: [{
      id: "item_1",
      command: "Get-Content topology/nodes/04-question-perception-distortion.json; Get-Content topology/nodes/09-experiment-g0.json; Get-Content topology/edges.jsonl",
      output: '{"id":"question:perception-distortion"}\n{"id":"experiment:g0"}\n{"id":"e:q-h1"}',
      exitCode: 0,
      status: "completed",
    }],
  });
  assert.deepEqual(trace.observedNodeIds.sort(), ["experiment:g0", "question:perception-distortion"]);
  assert.deepEqual(trace.observedEdgeIds, ["e:q-h1"]);
  assert.equal(trace.commands.length, 1);
});

test("source refresh preserves accepted scientific objects and drops old runtime objects", () => {
  const service = new TopologyService();
  const base = service.build();
  const legacy = {
    ...base,
    nodes: [...base.nodes, {
      id: "agent:legacy",
      kind: "agentSession",
      code: "AI",
      position: { x: 1000, y: 1000 },
      label: { zh: "旧会话", en: "Legacy session" },
      summary: { zh: "旧运行时对象", en: "Legacy runtime object" },
      status: "completed",
      data: {},
    }],
  };
  const patch = {
    id: "patch_persisted",
    baseStateVersion: base.stateVersion,
    operations: [{
      op: "addNode",
      node: {
        id: "candidate:persisted:decision",
        kind: "note",
        code: "B-KEEP",
        position: { x: 1000, y: 1000 },
        label: { zh: "保留决策", en: "Persist decision" },
        summary: { zh: "已由用户接受", en: "Accepted by the user" },
        status: "candidate",
        data: {},
      },
    }],
  };
  const applied = service.withObjects(base, [...base.nodes, { ...patch.operations[0].node, status: "proposed" }], base.edges);
  legacy.nodes.push(applied.nodes.find((item) => item.id === "candidate:persisted:decision"));
  const refreshed = service.mergePersistentState(service.build(), legacy);
  assert.equal(refreshed.nodes.some((item) => item.kind === "agentSession"), false);
  assert.ok(refreshed.nodes.some((item) => item.id === "candidate:persisted:decision" && item.status === "proposed"));
});
