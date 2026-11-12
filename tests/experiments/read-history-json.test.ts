import test from "node:test";
import assert from "node:assert/strict";
import { readHistoryJson } from "../../src/services/research/experiments/record-reader.js";

test("JSON exports retain nested config or params and nonnumeric summary events", () => {
  const config = { optimizer: { name: "AdamW", learningRate: 0.001 }, seeds: [13, 42], enabled: false };
  const summary = { bestLoss: 0.25, outcome: "completed", evaluation: { split: "validation" } };
  for (const field of ["config", "params"]) {
    const [run] = readHistoryJson({ sourceId: "training-run", [field]: config, summary, history: [{ step: 0, loss: 1 }] }, "asset:fallback", "Training");
    assert.deepEqual(run.events?.filter(event => event.kind !== "scalar"), [
      { kind: "config", sourceRunId: "training-run", seq: 1, data: { update: config, remove: [] } },
      { kind: "summary", sourceRunId: "training-run", seq: 2, data: { update: summary, remove: [] } },
    ]);
    assert.deepEqual(run.events?.[0], { kind: "scalar", key: "loss", xKey: "step", x: 0, value: 1, sourceRunId: "training-run", seq: 0 });
    assert.deepEqual(run.metrics, { bestLoss: 0.25 });
  }
});

test("JSON exports assign missing event identities and preserve explicit native identities", () => {
  const [run] = readHistoryJson({
    runId: "original-run",
    events: [
      { kind: "extension", seq: 8, sourceRunId: "native-stream", data: { observed: true } },
      { kind: "summary", seq: null, sourceRunId: null, data: { update: { outcome: "failed" }, remove: [] } },
    ],
  }, "asset:fallback", "Training");
  assert.deepEqual(run.events, [
    { kind: "extension", seq: 8, sourceRunId: "native-stream", data: { observed: true } },
    { kind: "summary", seq: 1, sourceRunId: "original-run", data: { update: { outcome: "failed" }, remove: [] } },
  ]);
});

test("JSON exports retain runId across assets while accepting the run_id alias", () => {
  for (const field of ["runId", "run_id"]) {
    for (const assetId of ["asset:part-one", "asset:part-two"]) {
      const [run] = readHistoryJson({ [field]: "shared-training-run", history: [] }, assetId, "Training");
      assert.equal(run.sourceId, "shared-training-run");
    }
  }
  assert.equal(readHistoryJson({ id: "preferred-id", runId: "other-id" }, "asset:fallback", "Training")[0].sourceId, "preferred-id");
});

test("JSON keyed histories keep wall_time in exact observations and prefer an explicit timestamp", () => {
  const [run] = readHistoryJson({ sourceId: "training-run", scalars: { loss: [
    { step: 0, value: 1, wall_time: 1234 },
    { step: 0, value: 0.5, timestamp: 0, wall_time: 5678 },
  ] } }, "asset:fallback", "Training");
  assert.deepEqual(run.series[0].points, [{ x: 0, y: 1, timestamp: 1234 }, { x: 0, y: 0.5, timestamp: 0 }]);
  assert.deepEqual(run.events?.map(event => event.timestamp), [1234, 0]);
});
