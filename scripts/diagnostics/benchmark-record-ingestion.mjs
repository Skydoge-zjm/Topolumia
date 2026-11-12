/** Isolated durable ingestion and indexed query load; no application/user data. */
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { ResearchCommandService } from "../../dist/src/services/research/research-command-service.js";
import { ResearchState } from "../../dist/src/services/research/research-state.js";
import { TopologyService } from "../../dist/src/services/topology/topology-service.js";
const root = await mkdtemp(
  path.join(os.tmpdir(), "topolumia-ingestion-bench-"),
);
const db = new DatabaseSync(path.join(root, "data.sqlite")),
  topologyService = new TopologyService({ demo: false });
const c = new ResearchCommandService({
  db,
  projectId: "bench",
  state: new ResearchState(topologyService.build()),
  topologyService,
  assetRoot: path.join(root, "assets"),
});
const actor = {
  isAgent: false,
  user: { id: "bench" },
  permissions: ["*"],
  projectId: "bench",
};
const count = Number(process.argv[2] ?? 120000);
assert.ok(Number.isSafeInteger(count) && count >= 1000 && count <= 1000000);
try {
  await c.assets.initialize();
  const view = c.changes.direct(
    [
      {
        op: "addNode",
        clientRef: "n",
        kind: "experiment",
        core: { nodeName: "Synthetic benchmark" },
      },
      {
        op: "addBlock",
        owner: { kind: "node", id: "@n" },
        clientRef: "b",
        type: "experimentRecord",
        title: "Records",
        payload: { provider: "wandb", runs: [] },
      },
    ],
    actor,
  );
  const nodeId = view.allocation["node:n"],
    blockId = view.allocation["block:b"],
    revision = c.nodes.node(nodeId).revision;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed,
    start = performance.now(),
    batches = [];
  for (let offset = 0; offset < count; offset += 128) {
    const batch = {
      version: 1,
      provider: "custom",
      streamId: "bench",
      writerId: "writer",
      generation: "1",
      events: Array.from({ length: Math.min(128, count - offset) }, (_, i) => ({
        seq: offset + i,
        sourceRunId: "run",
        kind: "scalar",
        key: "loss",
        xKey: "step",
        x: (offset + i) % 3000,
        value: Math.sin(i / 20),
      })),
    };
    const tick = performance.now();
    c.ingestion.receive(blockId, batch, actor);
    batches.push(performance.now() - tick);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const ingestionMs = performance.now() - start;
  const runId = c.records.overview(nodeId, actor).runs[0].id;
  let tick = performance.now();
  const exact = c.ingestion.points(
    blockId,
    runId,
    "loss",
    "step",
    { offset: count - 100, limit: 100 },
    count,
  );
  const exactPageMs = performance.now() - tick;
  tick = performance.now();
  const plot = await c.records.plot(
    { blockId, selections: [{ nodeId, blockId, runId }], maxPoints: 800 },
    actor,
  );
  const sampledPlotMs = performance.now() - tick;
  delay.disable();
  assert.equal(exact.points.length, 100);
  assert.equal(exact.pointCount, count);
  assert.ok(plot.series[0].points.length <= 800);
  assert.equal(c.nodes.node(nodeId).revision, revision);
  const allocatedHeapMiB =
    (process.memoryUsage().heapUsed - heapBefore) / 1024 ** 2;
  global.gc?.();
  batches.sort((a, b) => a - b);
  const report = {
    points: count,
    ingestionMs,
    pointsPerSecond: (count / ingestionMs) * 1000,
    batchP95Ms: batches[Math.floor(batches.length * 0.95)],
    exactPageMs,
    sampledPlotMs,
    returnedPlotPoints: plot.series[0].points.length,
    gcAvailable: Boolean(global.gc),
    allocatedHeapMiB,
    heapGrowthMiB: (process.memoryUsage().heapUsed - heapBefore) / 1024 ** 2,
    eventLoopP95Ms: delay.percentile(95) / 1e6,
    eventLoopMaxMs: delay.max / 1e6,
  };
  await mkdir("runtime/self-review", { recursive: true });
  await writeFile(
    "runtime/self-review/record-ingestion-performance.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await c.records.close();
  await c.assets.close();
  db.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
