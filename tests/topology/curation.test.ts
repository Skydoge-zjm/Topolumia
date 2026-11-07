import { installTopologyFixture } from "../helpers/topology-fixture.js";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startMvpServer } from "../../src/server.js";

let app;
let curatorDisposition = "proposal";

const contractCuratorDriver = {
  async run({ topology }) {
    if (curatorDisposition === "no_op" || curatorDisposition === "needs_clarification") {
      return {
        runId: `test-curator-${curatorDisposition}`,
        model: "test-curator-driver",
        threadId: null,
        usage: null,
        workspacePath: null,
        trace: { commands: [], observedNodeIds: ["experiment:g1"], observedEdgeIds: [], commandExecutions: [] },
        result: {
          schemaVersion: "topology-curator-result.v1",
          disposition: curatorDisposition,
          summary: curatorDisposition === "no_op" ? "没有新的长期状态。" : "需要研究者确认冲突证据。",
          reason: curatorDisposition === "no_op" ? "已有拓扑已覆盖当前记录。" : "当前证据不足以安全更新结论。",
          sourceRefs: [],
          evidenceNodeIds: ["experiment:g1"],
          inspectedNodeIds: ["experiment:g1"],
          inspectedEdgeIds: [],
          uncertainties: curatorDisposition === "no_op" ? [] : ["evaluator 版本未确定"],
          questions: curatorDisposition === "no_op" ? [] : ["是否将 evaluator 版本差异作为独立缺口记录？"],
          patch: null,
        },
      };
    }
    return {
      runId: "test-curator-run",
      model: "test-curator-driver",
      threadId: null,
      usage: null,
      workspacePath: null,
      trace: { commands: [], observedNodeIds: ["experiment:g1"], observedEdgeIds: [], commandExecutions: [] },
      result: {
        schemaVersion: "topology-curator-result.v1",
        disposition: "proposal",
        summary: "保留一个来自实验比较的观察。",
        reason: "测试驱动仅验证候选层合同。",
        sourceRefs: [],
        evidenceNodeIds: ["experiment:g1"],
        inspectedNodeIds: ["experiment:g1"],
        inspectedEdgeIds: [],
        uncertainties: [],
        questions: [],
        patch: {
          operations: [
            {
              op: "addNode",
              node: {
                id: "observation-from-test",
                kind: "note",
                code: "T-O1",
                position: { x: 960, y: 980 },
                label: { zh: "测试观察", en: "Test observation" },
                summary: { zh: "测试观察摘要", en: "Test observation summary" },
                status: "candidate",
                data: {},
              },
            },
            {
              op: "addEdge",
              edge: {
                id: "edge-from-test",
                from: {kind:"node",id:"experiment:g1"},
                to: {kind:"node",id:"observation-from-test"},
                type: "produces",
                label: { zh: "产生观察", en: "produces observation" },
                status: "candidate",
              },
            },
          ],
        },
      },
    };
  },
};

before(async () => {
  app = await startMvpServer({ port: 0, topologyCuratorDriver: contractCuratorDriver });
  installTopologyFixture(app);
});

after(async () => {
  if (app?.server) await new Promise((resolve) => app.server.close(resolve));
});

async function request(path, options = {}) {
  const response = await fetch(`${app.url}${path}`, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers ?? {}) },
  });
  const payload = await response.json();
  return { response, payload };
}

test("curator reports remain advisory and cannot bypass research object review", async () => {
  await request("/api/sync", { method: "POST", body: "{}" });
  const event = await request("/api/agent-events", { method: "POST", body: JSON.stringify({ text: "核对实验后，请审阅当前证据缺口。" }) });
  assert.equal(event.response.status, 201);

  const before = await request("/api/state");
  const formalVersion = before.payload.topology.stateVersion;
  const preview = await request("/api/topology/curation/preview", { method: "POST", body: "{}" });
  assert.equal(preview.response.status, 201);
  assert.equal(preview.payload.schemaVersion, "topology-curator-result.v1");
  assert.equal(preview.payload.disposition, "proposal");
  assert.ok(preview.payload.patch.operations.length >= 2);

  const candidateState = await request("/api/state");
  assert.equal(candidateState.payload.topology.stateVersion, formalVersion);
  assert.equal(candidateState.payload.topology.candidateLayer, undefined);
  assert.equal(candidateState.payload.pendingTopologyPatches, undefined);
  const applied = await request("/api/topology/curation/apply", { method: "POST", body: JSON.stringify({ patchId: preview.payload.patch.id }) });
  assert.equal(applied.response.status, 404);
  const rejected = await request("/api/topology/curation/reject", { method: "POST", body: JSON.stringify({ patchId: preview.payload.patch.id }) });
  assert.equal(rejected.response.status, 404);
  assert.equal((await request("/api/state")).payload.topology.stateVersion, formalVersion);
});

test("human research move is validated against current topology and source snapshot", async () => {
  const sync = await request("/api/sync", { method: "POST", body: "{}" });
  const nodeId = "gap:seed-variance";
  const sourceRef = sync.payload.mlflow.runs[0].ref;
  const accepted = await request("/api/agent-events", {
    method: "POST",
    body: JSON.stringify({ text: "先检查 evaluator backbone，再决定是否接受感知收益。", nodeIds: [nodeId], sourceRefs: [sourceRef] }),
  });
  assert.equal(accepted.response.status, 201);
  assert.equal(accepted.payload.type, "humanResearchMove");

  const invalid = await request("/api/agent-events", {
    method: "POST",
    body: JSON.stringify({ text: "invalid ref", nodeIds: ["missing-node"], sourceRefs: ["missing-source"] }),
  });
  assert.equal(invalid.response.status, 422);
  assert.equal(invalid.payload.error.code, "INVALID_RESEARCH_EVENT");
});

test("curator can return no-op or clarification without creating a patch", async () => {
  curatorDisposition = "no_op";
  const noOp = await request("/api/topology/curation/preview", { method: "POST", body: "{}" });
  assert.equal(noOp.response.status, 200);
  assert.equal(noOp.payload.disposition, "no_op");
  assert.equal(noOp.payload.patch, null);
  assert.equal((await request("/api/state")).payload.topology.candidateLayer, undefined);

  curatorDisposition = "needs_clarification";
  const clarification = await request("/api/topology/curation/preview", { method: "POST", body: "{}" });
  assert.equal(clarification.response.status, 200);
  assert.equal(clarification.payload.disposition, "needs_clarification");
  assert.ok(clarification.payload.questions.length > 0);
  assert.equal(clarification.payload.patch, null);
  curatorDisposition = "proposal";
});
