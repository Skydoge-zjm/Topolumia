import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundledRoot } from "../../src/config.js";
import { ResearchCommandService } from "../../src/services/research/research-command-service.js";
import { ResearchState } from "../../src/services/research/research-state.js";
import { TopologyService } from "../../src/services/topology/topology-service.js";
import { nodeRef } from "../../src/domain/research/object-ref.js";

const execute = promisify(execFile);
test("native offline W&B and TensorBoard files keep original bytes, all runs and exact scalar history", async (t) => {
  const python = process.env.TOPOLUMIA_RECORD_TEST_PYTHON ?? "python";
  const root = await mkdtemp(
      path.join(os.tmpdir(), "topolumia-native-records-"),
    ),
    db = new DatabaseSync(":memory:");
  const topologyService = new TopologyService({ demo: false });
  const c = new ResearchCommandService({
    db,
    state: new ResearchState(topologyService.build()),
    topologyService,
    projectId: "native",
    projectName: "Native records",
    assetRoot: path.join(root, "assets"),
    recordOptions: { pythonCommand: python },
  });
  await c.assets.initialize();
  t.after(async () => {
    await c.records.close();
    await c.assets.close();
    db.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const generated = await execute(
    python,
    [
      path.join(bundledRoot, "scripts/testing/generate-native-records.py"),
      "--output",
      path.join(root, "source"),
    ],
    {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        WANDB_MODE: "offline",
        WANDB_SILENT: "true",
      },
    },
  );
  const files = JSON.parse(generated.stdout);
  assert.equal(files.wandb.length, 3);
  assert.equal(files.tensorboard.length, 1);
  const actor = {
    isAgent: false,
    user: { id: "native-user" },
    projectId: "native",
    permissions: ["*"],
  };
  const result = c.changes.direct(
      [
        {
          op: "addNode",
          clientRef: "experiment",
          kind: "experiment",
          core: { nodeName: "LoRA native records" },
        },
      ],
      actor,
    ),
    nodeId = result.allocation["node:experiment"];
  for (const provider of ["wandb", "tensorboard"]) {
    const assets = [];
    for (const file of files[provider]) {
      const bytes = await readFile(file),
        asset = await c.assets.upload(
          Readable.from([bytes]),
          {
            originalName: path.basename(file),
            mediaType: "application/octet-stream",
            idempotencyKey: provider + ":" + file,
          },
          actor,
        );
      await writeFile(file, "Changed external project file");
      assert.deepEqual(
        await readFile(c.assets.file(c.assets.assert(asset.id, actor))),
        bytes,
      );
      assets.push(asset);
    }
    const imported = await c.records.inspect(
      provider,
      assets.map((asset) => asset.id),
      actor,
    );
    assert.equal(imported.runs.length, provider === "wandb" ? 3 : 1);
    assert.ok(
      imported.runs.every(
        (run) => run.metrics.length === (run.status === "failed" ? 0 : 4),
      ),
    );
    if (provider === "wandb")
      assert.equal(
        imported.runs.filter((run) => run.status === "failed").length,
        1,
      );
    const saved = c.changes.direct(
      [
        {
          op: "addBlock",
          owner: nodeRef(nodeId),
          clientRef: provider,
          title: provider,
          type: "experimentRecord",
          payload: {
            provider,
            runs: imported.runs.map(({ metrics, ...run }) => run),
          },
          representations: assets.map((asset) => ({
            kind: "asset",
            role: "source",
            assetId: asset.id,
          })),
        },
      ],
      actor,
    );
    const block = saved.blocks.find(
      (block) => block.id === saved.allocation["block:" + provider],
    );
    const plot = await c.records.plot(
      {
        selections: block.payload.runs.map((run) => ({
          nodeId,
          runId: run.runId,
        })),
        blockId: block.id,
      },
      actor,
    );
    assert.equal(
      plot.series.length,
      imported.runs.filter((run) => run.status !== "failed").length * 4,
    );
    assert.ok(
      plot.series.every(
        (line) => !line.sampled && line.points.length === line.pointCount,
      ),
    );
    const richEvents = await c.records.read(
      { mode: "events", nodeId, blockId: block.id, limit: 100 },
      actor,
    );
    assert.ok(richEvents.data.items.some((item) => item.event.kind !== "scalar"));
    if (provider === "wandb")
      assert.ok(richEvents.data.items.some((item) => ["config", "summary", "media", "distribution"].includes(item.event.kind)));
    assert.ok(richEvents.data.items.every((item) => item.readHint?.tool === "read_experiment" || item.event.kind === "scalar"));
    const firstAsset = c.assets.assert(assets[0].id, actor);
    await rm(c.records.indexPath(firstAsset, provider));
    c.changes.direct(
      [
        {
          op: "updateBlock",
          owner: nodeRef(nodeId),
          blockId: block.id,
          expectedRevision: block.revision,
          patch: { title: provider + " archived" },
        },
      ],
      actor,
    );
    const rebuilt = await c.records.plot(
      {
        selections: [{ nodeId, runId: block.payload.runs[0].runId }],
        blockId: block.id,
      },
      actor,
    );
    assert.deepEqual(
      rebuilt.series.map((line) => line.points),
      plot.series
        .filter((line) => line.runId === block.payload.runs[0].runId)
        .map((line) => line.points),
    );
    for (const run of block.payload.runs) {
      if (run.status === "failed") {
        await assert.rejects(
          c.records.read(
            {
              mode: "series",
              nodeId,
              runId: run.runId,
              blockId: block.id,
              metric: "train/loss",
            },
            actor,
          ),
          { code: "EXPERIMENT_METRIC_NOT_FOUND" },
        );
        continue;
      }
      const raw = await c.records.read(
        {
          mode: "series",
          nodeId,
          runId: run.runId,
          blockId: block.id,
          metric: "train/loss",
          pointLimit: 100,
        },
        actor,
      );
      assert.equal(raw.data.points[0].x, 0);
      assert.equal(raw.data.sampled, false);
      assert.equal(raw.data.points.length, 8);
    }
  }
});
