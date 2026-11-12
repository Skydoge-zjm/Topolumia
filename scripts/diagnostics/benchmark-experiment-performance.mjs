import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { readFile } from "node:fs/promises";
import { ResearchCommandService } from "../../dist/src/services/research/research-command-service.js";
import { ResearchState } from "../../dist/src/services/research/research-state.js";
import { TopologyService } from "../../dist/src/services/topology/topology-service.js";

// Isolated synthetic records only. Build the backend before running this benchmark.
const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-performance-"));
const db = new DatabaseSync(":memory:");
const topologyService = new TopologyService({ demo: false });
const c = new ResearchCommandService({
  db,
  topologyService,
  state: new ResearchState(topologyService.build()),
  projectId: "perf",
  projectName: "Synthetic benchmark",
  assetRoot: root,
});
const actor = {
  projectId: "perf",
  user: { id: "perf" },
  permissions: ["*"],
  isAgent: false,
};
const measurements = {};
const tick = () => new Promise((resolve) => setTimeout(resolve, 8));
async function measure(name, action) {
  let last = performance.now(),
    lag = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, now - last - 2);
    last = now;
  }, 2);
  const start = performance.now();
  try {
    await action();
    const elapsed = performance.now() - start;
    await tick();
    measurements[name] = {
      ms: +elapsed.toFixed(2),
      eventLoopDelayMs: +Math.max(0, lag).toFixed(2),
    };
  } catch (error) {
    measurements[name] = { error: error.message };
  } finally {
    clearInterval(timer);
  }
}
try {
  await c.assets.initialize();
  const count = 60,
    steps = 2000,
    metricCount = 4;
  const source = JSON.stringify({
    runs: Array.from({ length: count }, (_, run) => ({
      id: "r" + run,
      name: "Run " + run,
      history: Array.from({ length: steps }, (_, step) =>
        Object.fromEntries([
          ["_step", step],
          ...Array.from({ length: metricCount }, (_, metric) => [
            "metric/" + metric,
            step * 0.01 + run + metric,
          ]),
        ]),
      ),
    })),
  });
  const asset = await c.assets.upload(
    Readable.from([source]),
    {
      originalName: "records.json",
      mediaType: "application/json",
      idempotencyKey: "records",
    },
    actor,
  );
  let imported;
  await measure("import480kPoints", async () => {
    imported = await c.records.inspect("wandb", [asset.id], actor);
  });
  c.changes.direct(
    [
      {
        op: "addNode",
        clientRef: "experiment",
        kind: "experiment",
        core: { nodeName: "Synthetic" },
      },
    ],
    actor,
  );
  const node = c.nodes.nodes()[0];
  c.changes.direct(
    [
      {
        op: "addBlock",
        owner: { kind: "node", id: node.id },
        clientRef: "record",
        type: "experimentRecord",
        title: "Records",
        payload: {
          provider: "wandb",
          runs: imported.runs.map(({ metrics, ...run }) => run),
        },
        representations: [{ kind: "asset", assetId: asset.id, role: "source" }],
      },
    ],
    actor,
  );
  for (let index = 0; index < 500; index++)
    c.store.put("blocks", "block:unrelated" + index, {
      id: "block:unrelated" + index,
      owner: { kind: "node", id: "unrelated" },
      type: "richText",
      payload: { body: "x".repeat(4096) },
      lifecycle: "active",
      revision: 1,
    });
  const selections = c.records
    .overview(node.id, actor)
    .runs.map((run) => ({ nodeId: node.id, runId: run.id }));
  await measure("plot60Runs480kPoints", async () => {
    const plot = await c.records.plot(
      { selections, blockId: c.nodes.blocks(node.id)[0].id },
      actor,
    );
    measurements.plotOutputPoints = plot.series.reduce(
      (sum, line) => sum + line.points.length,
      0,
    );
  });
  await measure("read4Columns", async () => {
    for (let metric = 0; metric < 4; metric++)
      await c.records.read(
        {
          mode: "series",
          nodeId: node.id,
          runId: selections[0].runId,
          metric: "metric/" + metric,
          pointOffset: 100,
          pointLimit: 100,
          maxChars: 16000,
        },
        actor,
      );
  });
  if (typeof c.records.table === "function")
    await measure("read4ColumnsBatched", () =>
      c.records.table(
        {
          nodeId: node.id,
          runId: selections[0].runId,
          metrics: Array.from({ length: 4 }, (_, i) => ({ key: "metric/" + i, xKey: "step" })),
          pointOffset: 100,
          pointLimit: 100,
        },
        actor,
      ),
    );
  const coldReader = new c.records.constructor(c);
  await measure("coldIndex480kPoints", () =>
    coldReader.indexed(asset.id, "wandb", actor),
  );
  await coldReader.close();
  const longAsset = await c.assets.upload(
    Readable.from([
      JSON.stringify({
        id: "long-run",
        series: [
          {
            key: "long/metric",
            points: Array.from({ length: 150_000 }, (_, x) => ({
              x,
              y: x / 10,
            })),
          },
        ],
      }),
    ]),
    {
      originalName: "long.json",
      mediaType: "application/json",
      idempotencyKey: "long",
    },
    actor,
  );
  const longRecords = await c.records.inspect("wandb", [longAsset.id], actor);
  const longView = c.changes.direct(
    [
      {
        op: "addBlock",
        owner: { kind: "node", id: node.id },
        clientRef: "long",
        title: "Long run",
        type: "experimentRecord",
        payload: {
          provider: "wandb",
          runs: longRecords.runs.map(({ metrics, ...run }) => run),
        },
        representations: [
          { kind: "asset", assetId: longAsset.id, role: "source" },
        ],
      },
    ],
    actor,
  );
  const longRunId = longView.blocks.find(
    (block) => block.id === longView.allocation["block:long"],
  ).payload.runs[0].runId;
  await measure("read150kPointSeries", async () => {
    const result = await c.records.read(
      {
        mode: "series",
        nodeId: node.id,
        runId: longRunId,
        metric: "long/metric",
        pointOffset: 149900,
        pointLimit: 100,
        maxChars: 16000,
      },
      actor,
    );
    if (result.data.points[0]?.x !== 149900)
      throw new Error("Incorrect long series range");
  });
  const modelSource = await readFile(
    "frontend/src/features/experiments/chartModel.ts",
    "utf8",
  );
  const modelFile = path.join(root, "chart-model.mjs");
  await writeFile(
    modelFile,
    ts.transpileModule(modelSource, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    }).outputText,
  );
  const model = await import(pathToFileURL(modelFile).href);
  const lines = Array.from({ length: 200 }, (_, run) => ({
    nodeId: "n",
    runId: "r" + run,
    key: "loss",
    xKey: "step",
    points: Array.from({ length: 200 }, (_, step) => ({
      x: step * 200 + run,
      y: step + run,
    })),
  }));
  const build = model.buildFacetedData ?? model.buildData;
  await measure("chart200Runs40kDistinctPoints", () => {
    const data = build(lines);
    measurements.chartNumericSlots = model.buildFacetedData
      ? data
          .slice(1)
          .reduce((sum, line) => sum + line[0].length + line[1].length, 0)
      : data.reduce((sum, line) => sum + line.length, 0);
  });
  const report = {
    workload: {
      runs: count,
      steps,
      metrics: metricCount,
      unrelatedBlocks: 500,
      sourceBytes: Buffer.byteLength(source),
    },
    measurements,
  };
  const output = process.argv[2];
  if (output) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await c.records.close();
  await c.assets.close();
  db.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
