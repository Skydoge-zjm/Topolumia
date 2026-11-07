import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ResearchCommandService } from "../../src/services/research/research-command-service.js";
import { ResearchState } from "../../src/services/research/research-state.js";
import { TopologyService } from "../../src/services/topology/topology-service.js";
import { researchNodeKinds } from "../../src/domain/research/node-kinds.js";
import { nodeRef } from "../../src/domain/research/object-ref.js";
import {
  exportXlsxTable,
  importTablePreview,
} from "../../src/services/topology/table-importers.js";
import { executeResearchTool } from "../../src/services/research/tool-executor.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-records-")),
    db = new DatabaseSync(":memory:");
  const topologyService = new TopologyService({ demo: false }),
    state = new ResearchState(topologyService.build());
  const c = new ResearchCommandService({
    db,
    state,
    topologyService,
    projectId: "records",
    projectName: "Records",
    assetRoot: root,
  });
  await c.assets.initialize();
  t.after(async () => {
    await c.records.close();
    await c.assets.close();
    db.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const actor = {
    isAgent: false,
    user: { id: "owner", displayName: "Owner" },
    projectId: "records",
    permissions: ["*"],
  };
  const create = (kind, name) => {
    const view = c.changes.direct(
      [{ op: "addNode", clientRef: "new", kind, core: { nodeName: name } }],
      actor,
    );
    return c.nodes.node(view.allocation["node:new"]);
  };
  const upload = async (name, content, uploader = actor) =>
    c.assets.upload(
      Readable.from([Buffer.from(content)]),
      {
        originalName: name,
        mediaType: "application/octet-stream",
        idempotencyKey: "upload:" + name + ":" + content.length,
      },
      uploader,
    );
  const add = (nodeId, value) => {
    const result = c.changes.direct(
      [
        {
          op: "addBlock",
          owner: nodeRef(nodeId),
          clientRef: "block",
          ...value,
        },
      ],
      actor,
    );
    return result.blocks.find(
      (block) => block.id === result.allocation["block:block"],
    );
  };
  return { c, actor, create, upload, add };
}

test("large point reads and batched columns preserve exact ranges without loading project snapshots", async (t) => {
  const { c, actor, create, upload, add } = await fixture(t),
    node = create("experiment", "Large archived run");
  const count = 150_000;
  const asset = await upload(
    "large.json",
    JSON.stringify({
      id: "large-source",
      series: [
        {
          key: "loss",
          points: Array.from({ length: count }, (_, x) => ({ x, y: x / 7 })),
        },
        {
          key: "accuracy",
          points: [
            { x: 0, y: 0.123456789012345 },
            { x: 0, y: 0.9 },
            { x: 2, y: 0.95 },
          ],
        },
      ],
    }),
  );
  const imported = await c.records.inspect("wandb", [asset.id], actor);
  const block = add(node.id, {
    title: "Archived",
    type: "experimentRecord",
    payload: {
      provider: "wandb",
      runs: imported.runs.map(({ metrics, ...run }) => run),
    },
    representations: [{ kind: "asset", assetId: asset.id, role: "source" }],
  });
  const runId = block.payload.runs[0].runId;
  const originalSnapshot = c.snapshot;
  c.snapshot = () => {
    throw new Error(
      "Whole-project snapshot must not be used for formal experiment point reads",
    );
  };
  t.after(() => {
    c.snapshot = originalSnapshot;
  });
  const raw = await c.records.read(
    {
      mode: "series",
      nodeId: node.id,
      runId,
      metric: "loss",
      pointOffset: count - 10,
      pointLimit: 10,
      maxChars: 16000,
    },
    actor,
  );
  assert.equal(raw.data.points.length, 10);
  assert.equal(raw.data.points[0].x, count - 10);
  assert.equal(raw.data.points.at(-1).y, (count - 1) / 7);
  const table = await c.records.table(
    { nodeId: node.id, runId, metricKeys: ["loss", "accuracy"], pointLimit: 3 },
    actor,
  );
  assert.deepEqual(table.columns[1].points, [
    { x: 0, y: 0.123456789012345 },
    { x: 0, y: 0.9 },
    { x: 2, y: 0.95 },
  ]);
  assert.equal(table.columns[0].pointCount, count);
  await assert.rejects(
    c.records.table(
      {
        nodeId: node.id,
        runId,
        metricKeys: ["loss"],
        expectedVersions: { loss: "stale" },
      },
      actor,
    ),
    { code: "OBJECT_VERSION_CONFLICT" },
  );
  await assert.rejects(
    c.records.table({ nodeId: node.id, runId, metricKeys: ["missing"] }, actor),
    { code: "EXPERIMENT_METRIC_NOT_FOUND" },
  );
  await assert.rejects(
    c.records.table(
      { nodeId: node.id, runId, metricKeys: ["loss", "loss"] },
      actor,
    ),
    { code: "INPUT_INVALID" },
  );
  await assert.rejects(
    c.records.table(
      { nodeId: node.id, runId, metricKeys: ["loss"] },
      { ...actor, permissions: [] },
    ),
    { code: "FORBIDDEN" },
  );
});

test("block-scoped reads keep other record blocks out when no revision was supplied", async (t) => {
  const { c, actor, create, upload, add } = await fixture(t);
  const node = create("experiment", "Separate record blocks");
  const blocks = [];
  for (const index of [0, 1]) {
    const asset = await upload(
      "part" + index + ".json",
      JSON.stringify({
        id: "part" + index,
        history: [{ _step: index, loss: index + 0.5 }],
      }),
    );
    const records = await c.records.inspect("wandb", [asset.id], actor);
    blocks.push(
      add(node.id, {
        title: "Part " + index,
        type: "experimentRecord",
        payload: {
          provider: "wandb",
          runs: records.runs.map(({ metrics, ...run }) => ({
            ...run,
            ...(index ? { runId: blocks[0].payload.runs[0].runId } : {}),
          })),
        },
        representations: [{ kind: "asset", assetId: asset.id, role: "source" }],
      }),
    );
  }
  const runId = blocks[0].payload.runs[0].runId;
  const input = {
    mode: "series",
    nodeId: node.id,
    runId,
    metric: "loss",
    pointLimit: 10,
  };
  const all = await c.records.read(input, actor);
  assert.equal(all.data.pointCount, 2);
  const scoped = await c.records.read(
    { ...input, blockId: blocks[0].id },
    actor,
  );
  assert.deepEqual(scoped.data.points, [{ x: 0, y: 0.5 }]);
  assert.equal(scoped.data.sources.length, 1);
  const plot = await c.records.plot(
    { selections: [{ nodeId: node.id, runId }], blockId: blocks[1].id },
    actor,
  );
  assert.deepEqual(plot.series[0].points, [{ x: 1, y: 1.5 }]);
});

test("three types share atomic note bodies and free tags while old scientific identities remain readable", async (t) => {
  const { c, actor, create } = await fixture(t);
  assert.deepEqual(researchNodeKinds, ["paper", "experiment", "note"]);
  const note = create("note", "Question and analysis");
  const body = c.nodes.blocks(note.id).find((block) => block.role === "body");
  assert.equal(body.type, "richText");
  assert.equal(body.payload.body, "");
  c.changes.direct(
    [
      {
        op: "updateCore",
        owner: nodeRef(note.id),
        expectedCoreRevision: 1,
        patch: { tags: ["custom-topic", "问题"] },
      },
      {
        op: "updateBlock",
        owner: nodeRef(note.id),
        blockId: body.id,
        expectedRevision: 1,
        patch: {
          payload: { format: "markdown", body: "My research question" },
        },
      },
    ],
    actor,
  );
  assert.deepEqual(c.nodes.node(note.id).core.tags, ["custom-topic", "问题"]);
  assert.equal(
    c.nodes.block(note.id, body.id).payload.body,
    "My research question",
  );
  assert.throws(() => create("hypothesis", "New old type"), {
    code: "NODE_KIND_INVALID",
  });
  assert.throws(
    () =>
      c.changes.direct(
        [
          {
            op: "updateCore",
            owner: nodeRef(note.id),
            expectedCoreRevision: 2,
            patch: { nodeName: "Must roll back" },
          },
          {
            op: "updateBlock",
            owner: nodeRef(note.id),
            blockId: body.id,
            expectedRevision: 1,
            patch: { title: "Stale" },
          },
        ],
        actor,
      ),
    { code: "OBJECT_VERSION_CONFLICT" },
  );
  assert.equal(c.nodes.node(note.id).core.nodeName, "Question and analysis");
  const stored = c.store.get("nodes", note.id);
  c.store.put("nodes", note.id, { ...stored, kind: "hypothesis" });
  c.state.topology.nodes.find((item) => item.id === note.id).kind =
    "hypothesis";
  assert.equal(
    c.formalTopology().nodes.find((item) => item.id === note.id).kind,
    "note",
  );
  assert.equal(c.nodes.node(note.id).kind, "note");
  assert.equal(
    c.nodes.block(note.id, body.id).payload.body,
    "My research question",
  );
});

test("one record block holds three runs and four exact metrics, with versioned material links and temporary cross-experiment comparison", async (t) => {
  const { c, actor, create, upload, add } = await fixture(t);
  const experiment = create("experiment", "LoRA rank 4");
  const assets = [];
  for (let index = 0; index < 3; index++)
    assets.push(
      await upload(
        `run-${index}.json`,
        JSON.stringify({
          id: `run-${index}`,
          name: `Run ${index + 1}`,
          status: index ? "finished" : "failed",
          history: Array.from({ length: 260 }, (_, step) => ({
            _step: step,
            "train/loss": 1 / (step + index + 1),
            "train/accuracy": step / 300,
            "eval/psnr": 20 + step / 100,
            "eval/ssim": step / 500,
          })),
        }),
      ),
    );
  const imported = await c.records.inspect(
    "wandb",
    assets.map((asset) => asset.id),
    actor,
  );
  const payload = {
    provider: "wandb",
    runs: imported.runs.map(({ metrics, ...run }) => run),
  };
  const block = add(experiment.id, {
    title: "Training curves",
    type: "experimentRecord",
    payload,
    representations: assets.map((asset) => ({
      kind: "asset",
      assetId: asset.id,
      role: "source",
    })),
  });
  const overview = c.records.overview(experiment.id, actor);
  assert.equal(overview.runs.length, 3);
  assert.equal(overview.revision, 2);
  assert.equal(new Set(block.payload.runs.map((run) => run.runId)).size, 3);
  const plot = await c.records.plot(
    {
      selections: overview.runs.map((run) => ({
        nodeId: experiment.id,
        runId: run.id,
      })),
      maxPoints: 50,
    },
    actor,
  );
  assert.equal(plot.series.length, 12);
  assert.equal(plot.metricKeys.length, 4);
  assert.ok(
    plot.series.every(
      (line) =>
        line.points.length <= 50 && line.pointCount === 260 && line.sampled,
    ),
  );
  const raw = await c.records.read(
    {
      mode: "series",
      nodeId: experiment.id,
      runId: overview.runs[0].id,
      metric: "train/loss",
      pointOffset: 100,
      pointLimit: 20,
    },
    actor,
  );
  assert.equal(raw.data.points.length, 20);
  assert.equal(raw.data.points[0].x, 100);
  assert.equal(raw.data.nextOffset, 120);
  assert.equal(raw.data.sampled, false);
  const again = add(experiment.id, {
    title: "Same source again",
    type: "experimentRecord",
    payload,
    representations: assets.map((asset) => ({
      kind: "asset",
      assetId: asset.id,
      role: "source",
    })),
  });
  assert.deepEqual(
    again.payload.runs.map((run) => run.runId),
    block.payload.runs.map((run) => run.runId),
  );
  assert.equal(c.records.overview(experiment.id, actor).runs.length, 3);
  const config = await upload("rank4.yaml", "rank: 4\nbatch_size: 32\n");
  const configBlock = add(experiment.id, {
    title: "Configurations",
    type: "file",
    representations: [{ kind: "asset", assetId: config.id, role: "source" }],
  });
  const table = add(experiment.id, {
    title: "Run parameters",
    type: "table",
    payload: {
      columns: [{ key: "batch", label: "Batch size" }],
      rows: [{ batch: 32 }, { batch: 16 }],
    },
  });
  const revision = c.records.overview(experiment.id, actor).revision;
  c.changes.direct(
    [
      {
        op: "editExperiment",
        owner: nodeRef(experiment.id),
        expectedExperimentRevision: revision,
        patch: {
          addLinks: [
            {
              runId: overview.runs[0].id,
              blockId: configBlock.id,
              blockRevision: 1,
              selection: { kind: "asset", assetId: config.id },
            },
            {
              runId: overview.runs[1].id,
              blockId: table.id,
              blockRevision: 1,
              selection: { kind: "row", rowIndex: 1 },
            },
          ],
        },
      },
    ],
    actor,
  );
  assert.equal(
    c.records.overview(experiment.id, actor).materialLinks.length,
    2,
  );
  c.changes.direct(
    [
      {
        op: "updateBlock",
        owner: nodeRef(experiment.id),
        blockId: table.id,
        expectedRevision: 1,
        patch: {
          payload: { ...table.payload, rows: [{ batch: 64 }, { batch: 8 }] },
        },
      },
    ],
    actor,
  );
  const savedRow = c.records
    .overview(experiment.id, actor)
    .materialLinks.find((link) => link.selection.kind === "row");
  assert.equal(savedRow.blockRevision, 1);
  assert.equal(savedRow.currentRevision, 2);
  assert.deepEqual(savedRow.item, { batch: 16 });
  const other = create("experiment", "LoRA rank 8");
  const second = add(other.id, {
    title: "Training",
    type: "experimentRecord",
    payload: { provider: "wandb", runs: [payload.runs[1]] },
    representations: [{ kind: "asset", assetId: assets[1].id, role: "source" }],
  });
  const before = {
    nodes: c.store.all("nodes"),
    blocks: c.store.all("blocks"),
    candidates: c.store.all("candidates"),
  };
  const compared = await c.records.read(
    {
      mode: "compare",
      selections: [
        { nodeId: experiment.id, runId: overview.runs[2].id },
        { nodeId: other.id, runId: second.payload.runs[0].runId },
      ],
      metricKeys: ["train/loss"],
      pointLimit: 10,
    },
    actor,
  );
  assert.equal(compared.data.temporary, true);
  assert.equal(compared.data.items.length, 2);
  assert.equal(compared.data.metricKeys.length, 4);
  assert.ok(compared.data.items.every((line) => line.key === "train/loss"));
  assert.deepEqual(
    {
      nodes: c.store.all("nodes"),
      blocks: c.store.all("blocks"),
      candidates: c.store.all("candidates"),
    },
    before,
  );
  const unmatched = await c.records.plot(
    {
      selections: [{ nodeId: other.id, runId: second.payload.runs[0].runId }],
      metricKeys: ["training_loss"],
    },
    actor,
  );
  assert.equal(unmatched.series.length, 0);
  assert.throws(
    () =>
      c.records.overview(experiment.id, {
        ...actor,
        projectId: "another-project",
      }),
    { code: "PROJECT_SCOPE_MISMATCH" },
  );
});

test("experiment metadata and associations remain human-reviewed and use current read receipts", async (t) => {
  const { c, actor, create } = await fixture(t),
    node = create("experiment", "Recorded experiment");
  const agent = {
    isAgent: true,
    user: { id: "owner" },
    principalId: "agent:one",
    sessionId: "session:one",
    projectId: "records",
    permissions: ["research.view", "research.proposeChange"],
  };
  assert.throws(
    () =>
      c.changes.direct(
        [
          {
            op: "editExperiment",
            owner: nodeRef(node.id),
            expectedExperimentRevision: 1,
            patch: { addRuns: [{ label: "Attempt", status: "failed" }] },
          },
        ],
        agent,
      ),
    { code: "REVIEW_REQUIRES_USER" },
  );
  assert.throws(
    () =>
      c.proposals.create(
        {
          reason: "Record a failed attempt",
          nodeChanges: [
            {
              nodeId: node.id,
              expectedExperimentRevision: 1,
              experimentPatch: {
                addRuns: [{ label: "OOM", status: "failed" }],
              },
            },
          ],
        },
        agent,
      ),
    { code: "EVIDENCE_SCOPE_INSUFFICIENT" },
  );
  const read = await c.records.read({ mode: "runs", nodeId: node.id }, agent);
  const candidate = c.proposals.create(
    {
      reason: "Record a failed attempt",
      evidenceReadIds: read.readReceipts.map((receipt) => receipt.id),
      nodeChanges: [
        {
          nodeId: node.id,
          expectedExperimentRevision: 1,
          experimentPatch: { addRuns: [{ label: "OOM", status: "failed" }] },
        },
      ],
    },
    agent,
  );
  assert.equal(c.records.overview(node.id, actor).runs.length, 0);
  c.reviewCandidate({
    actor,
    candidateId: candidate.id,
    expectedRevision: 1,
    decision: "accept",
  });
  assert.equal(c.records.overview(node.id, actor).runs[0].label, "OOM");
  assert.throws(
    () =>
      c.changes.direct(
        [
          {
            op: "editExperiment",
            owner: nodeRef(node.id),
            expectedExperimentRevision: 1,
            patch: { addRuns: [{ label: "Stale" }] },
          },
        ],
        actor,
      ),
    { code: "OBJECT_VERSION_CONFLICT" },
  );
});

test("an Agent can incrementally link its pending record and config, while paginated reads never authorize unseen runs", async (t) => {
  const { c, actor, create, upload } = await fixture(t),
    node = create("experiment", "Agent experiment");
  const agent = {
    isAgent: true,
    user: { id: "owner" },
    principalId: "agent:ingestion",
    sessionId: "session:ingestion",
    projectId: "records",
    permissions: ["research.view", "research.proposeChange"],
  };
  const observed = await c.records.read(
    { mode: "runs", nodeId: node.id },
    agent,
  );
  const asset = await upload(
    "agent-run.json",
    JSON.stringify({
      id: "agent-source",
      name: "Recorded attempt",
      history: [
        { _step: 0, loss: 1 },
        { _step: 1, loss: 0.5 },
      ],
    }),
    agent as any,
  );
  const imported = await c.records.inspect("wandb", [asset.id], agent);
  const proposed = c.proposals.create(
    {
      reason: "Record execution with its config",
      evidenceReadIds: observed.readReceipts.map((receipt) => receipt.id),
      nodeChanges: [
        {
          nodeId: node.id,
          addBlocks: [
            {
              title: "Process",
              type: "experimentRecord",
              payload: {
                provider: "wandb",
                runs: imported.runs.map(({ metrics, ...run }) => run),
              },
              representations: [
                { kind: "asset", assetId: asset.id, role: "source" },
              ],
            },
            {
              title: "Config",
              type: "table",
              payload: {
                columns: [{ key: "batch", label: "Batch size" }],
                rows: [{ batch: 16 }],
              },
            },
          ],
        },
      ],
    },
    agent,
  );
  const preview = c.snapshot(proposed.id, agent),
    pendingRun = preview.nodes.find((item) => item.id === node.id).runs[0],
    config = preview.blocks.find((block) => block.title === "Config");
  const revised = c.proposals.edit(
    {
      candidateId: proposed.id,
      expectedRevision: 1,
      nodeChanges: [
        {
          nodeId: node.id,
          experimentPatch: {
            addLinks: [
              {
                runId: pendingRun.id,
                blockId: config.id,
                blockRevision: 1,
                selection: { kind: "row", rowIndex: 0 },
              },
            ],
          },
        },
      ],
    },
    agent,
  );
  assert.equal(c.records.overview(node.id, actor).runs.length, 0);
  c.reviewCandidate({
    actor,
    candidateId: revised.id,
    expectedRevision: 2,
    decision: "accept",
  });
  assert.equal(
    c.records.overview(node.id, actor).materialLinks[0].runId,
    pendingRun.id,
  );
  const before = c.records.overview(node.id, actor);
  c.changes.direct(
    [
      {
        op: "editExperiment",
        owner: nodeRef(node.id),
        expectedExperimentRevision: before.revision,
        patch: { addRuns: [{ label: "Not yet read", status: "failed" }] },
      },
    ],
    actor,
  );
  const read = await c.records.read(
    { mode: "runs", nodeId: node.id, limit: 1 },
    agent,
  );
  const hidden = c.records.overview(node.id, actor).runs.at(-1);
  assert.equal(read.data.items.length, 1);
  assert.notEqual(read.data.items[0].id, hidden.id);
  assert.throws(
    () =>
      c.proposals.create(
        {
          reason: "Change an unseen attempt",
          evidenceReadIds: read.readReceipts.map((receipt) => receipt.id),
          nodeChanges: [
            {
              nodeId: node.id,
              expectedExperimentRevision: read.data.revision,
              experimentPatch: {
                updateRuns: [{ id: hidden.id, status: "succeeded" }],
              },
            },
          ],
        },
        agent,
      ),
    { code: "EVIDENCE_SCOPE_INSUFFICIENT" },
  );
  assert.equal(c.records.overview(node.id, actor).runs.at(-1).status, "failed");
});

test("distinct uploads with identical anonymous results remain distinct attempts, and failures before the first metric are retained", async (t) => {
  const { c, actor, create, upload, add } = await fixture(t),
    node = create("experiment", "Repeat attempts");
  const history = JSON.stringify([
    { _step: 0, loss: 1 },
    { _step: 1, loss: 0.5 },
  ]);
  const assets = [
    await upload("attempt-one.json", history),
    await upload("attempt-two.json", history),
    await upload(
      "oom.json",
      JSON.stringify({
        id: "failed-at-start",
        name: "Failed before step 0",
        status: "failed",
        history: [],
      }),
    ),
  ];
  assert.equal(assets[0].checksum, assets[1].checksum);
  const imported = await c.records.inspect(
    "wandb",
    assets.map((asset) => asset.id),
    actor,
  );
  assert.equal(imported.runs.length, 3);
  const block = add(node.id, {
    title: "Attempts",
    type: "experimentRecord",
    payload: {
      provider: "wandb",
      runs: imported.runs.map(({ metrics, ...run }) => run),
    },
    representations: assets.map((asset) => ({
      kind: "asset",
      assetId: asset.id,
      role: "source",
    })),
  });
  const overview = c.records.overview(node.id, actor),
    failed = overview.runs.find((run) => run.status === "failed");
  assert.equal(overview.runs.length, 3);
  assert.ok(failed);
  const plot = await c.records.plot(
    {
      selections: overview.runs.map((run) => ({
        nodeId: node.id,
        runId: run.id,
      })),
      blockId: block.id,
    },
    actor,
  );
  assert.equal(plot.runs.length, 3);
  assert.equal(plot.series.length, 2);
  assert.deepEqual(plot.series[0].points, plot.series[1].points);
  assert.ok(plot.series.every((line) => line.runId !== failed.id));
  const directory = await c.records.read(
    { mode: "metrics", nodeId: node.id, runId: failed.id },
    actor,
  );
  assert.equal(directory.data.items.length, 0);
});

test("whole-experiment comparison includes every run beyond the manual selection limit", async (t) => {
  const { c, actor, create, upload, add } = await fixture(t);
  const nodes = [
    create("experiment", "Rank 4"),
    create("experiment", "Rank 8"),
  ];
  for (const [index, node] of nodes.entries()) {
    const asset = await upload(
      `all-runs-${index}.json`,
      JSON.stringify({
        runs: Array.from({ length: 15 }, (_, run) => ({
          id: `source-${index}-${run}`,
          name: `Run ${run}`,
          status: run === 0 ? "failed" : "finished",
          history:
            run === 0
              ? []
              : [
                  { _step: 0, loss: 0.7 },
                  { _step: 1, loss: 0.3 },
                ],
        })),
      }),
    );
    const imported = await c.records.inspect("wandb", [asset.id], actor);
    add(node.id, {
      title: "All attempts",
      type: "experimentRecord",
      payload: {
        provider: "wandb",
        runs: imported.runs.map(({ metrics, ...run }) => run),
      },
      representations: [{ kind: "asset", assetId: asset.id, role: "source" }],
    });
  }
  const nodeIds = nodes.map((node) => node.id),
    readOnly = { ...actor, permissions: ["research.view"] };
  const count = c.store.all("blocks").length;
  const plot = await c.records.plot({ nodeIds }, readOnly);
  assert.equal(plot.temporary, true);
  assert.equal(plot.runs.length, 30);
  assert.equal(plot.series.length, 28);
  assert.equal(plot.runs.filter((run) => run.status === "failed").length, 2);
  assert.equal(c.store.all("blocks").length, count);
  const result = await executeResearchTool(
    { researchCommands: c },
    "read_experiment",
    {
      mode: "compare",
      nodeIds,
      metricKeys: ["loss"],
      pointLimit: 2,
      limit: 1,
      maxChars: 16000,
    },
    readOnly,
    null,
  );
  assert.equal(result.data.runs.length, 30);
  assert.equal(result.data.items.length, 1);
  await assert.rejects(
    c.records.plot({ nodeIds: [nodes[0].id, nodes[0].id] }, actor),
    { code: "INPUT_INVALID" },
  );
  await assert.rejects(c.records.plot({ nodeIds, selections: [] }, actor), {
    code: "INPUT_INVALID",
  });
  await assert.rejects(
    c.records.plot(
      { nodeIds: [nodes[0].id, create("note", "Analysis").id] },
      actor,
    ),
    { code: "NODE_NOT_EXPERIMENT" },
  );
  const empty = await c.records.plot(
    {
      nodeIds: [
        create("experiment", "Empty A").id,
        create("experiment", "Empty B").id,
      ],
    },
    actor,
  );
  assert.equal(empty.runs.length, 0);
  assert.equal(empty.series.length, 0);
});

test("a record block can render more runs than a temporary cross-experiment comparison", async (t) => {
  const { c, actor, create, upload, add } = await fixture(t),
    node = create("experiment", "Many attempts");
  const asset = await upload(
    "attempts.json",
    JSON.stringify({
      runs: Array.from({ length: 25 }, (_, index) => ({
        id: "attempt-" + index,
        name: "Run " + index,
        history: [{ _step: 0, loss: index + 1 }],
      })),
    }),
  );
  const imported = await c.records.inspect("wandb", [asset.id], actor);
  const block = add(node.id, {
    title: "All attempts",
    type: "experimentRecord",
    payload: {
      provider: "wandb",
      runs: imported.runs.map(({ metrics, ...run }) => run),
    },
    representations: [{ kind: "asset", assetId: asset.id, role: "source" }],
  });
  const selections = c.records
    .overview(node.id, actor)
    .runs.map((run) => ({ nodeId: node.id, runId: run.id }));
  const plot = await c.records.plot(
    { selections, blockId: block.id, blockRevision: 1 },
    actor,
  );
  assert.equal(plot.runs.length, 25);
  assert.equal(plot.series.length, 25);
  await assert.rejects(c.records.plot({ selections }, actor), {
    code: "INPUT_INVALID",
  });
  await assert.rejects(c.records.plot({ selections: [null] }, actor), {
    code: "INPUT_INVALID",
  });
});

test("CSV material associations read archived rows beyond the bounded preview", async (t) => {
  const { c, actor, create, upload, add } = await fixture(t),
    node = create("experiment", "CSV config");
  c.changes.direct(
    [
      {
        op: "editExperiment",
        owner: nodeRef(node.id),
        expectedExperimentRevision: 1,
        patch: { addRuns: [{ label: "CSV run" }] },
      },
    ],
    actor,
  );
  const run = c.records.overview(node.id, actor).runs[0];
  const csv =
    "Run,Batch size\n" +
    Array.from(
      { length: 500 },
      (_, index) => `run-${index + 1},${index + 1}`,
    ).join("\n");
  const preview = await importTablePreview(Buffer.from(csv), "config.csv");
  assert.equal(preview.truncated, true);
  assert.equal(preview.rows.length, 300);
  const asset = await upload("config.csv", csv),
    block = add(node.id, {
      title: "Config",
      type: "table",
      representations: [{ kind: "asset", assetId: asset.id, role: "source" }],
    });
  const patch = {
    addLinks: [
      {
        runId: run.id,
        blockId: block.id,
        blockRevision: 1,
        selection: { kind: "assetRow", assetId: asset.id, rowIndex: 400 },
      },
    ],
  };
  await c.records.prepareMaterialSelections(patch, actor);
  c.changes.direct(
    [
      {
        op: "editExperiment",
        owner: nodeRef(node.id),
        expectedExperimentRevision: 2,
        patch,
      },
    ],
    actor,
  );
  const linked = c.records.overview(node.id, actor).materialLinks[0],
    { tool, ...input } = linked.readHint;
  const values = await executeResearchTool(
    { researchCommands: c },
    tool,
    input,
    actor,
    null,
  );
  assert.deepEqual(values.data.items, [
    { index: 400, values: { c1: "run-400", c2: "400" } },
  ]);
  assert.equal(values.data.availableRows, 501);
  await assert.rejects(
    c.records.prepareMaterialSelections(
      {
        addLinks: [
          {
            ...patch.addLinks[0],
            selection: { ...patch.addLinks[0].selection, rowIndex: 501 },
          },
        ],
      },
      actor,
    ),
    { code: "RANGE_INVALID" },
  );
  await assert.rejects(
    c.assets.values(asset.id, actor, {
      sheet: "Missing",
      rowOffset: 0,
      rowLimit: 1,
    }),
    { code: "RANGE_INVALID" },
  );
});

test("uploaded spreadsheet rows use immutable file coordinates and Agent row-read scopes", async (t) => {
  const { c, actor, create, upload, add } = await fixture(t),
    node = create("experiment", "Spreadsheet config");
  c.changes.direct(
    [
      {
        op: "editExperiment",
        owner: nodeRef(node.id),
        expectedExperimentRevision: 1,
        patch: { addRuns: [{ label: "CLI run" }] },
      },
    ],
    actor,
  );
  const run = c.records.overview(node.id, actor).runs[0];
  const workbook = Buffer.from(
    exportXlsxTable(
      {
        columns: [
          { key: "run", label: "Run" },
          { key: "batch", label: "Batch size" },
        ],
        rows: [
          { run: "one", batch: 32 },
          { run: "two", batch: 16 },
        ],
      },
      "Config",
    ),
  );
  const asset = await upload("params.xlsx", workbook),
    block = add(node.id, {
      title: "Workbook",
      type: "spreadsheet",
      payload: { format: "xlsx" },
      representations: [
        {
          kind: "asset",
          assetId: asset.id,
          role: "source",
          label: "params.xlsx",
        },
      ],
    });
  const patch = {
    addLinks: [
      {
        runId: run.id,
        blockId: block.id,
        blockRevision: 1,
        selection: {
          kind: "assetRow",
          assetId: asset.id,
          sheet: "Config",
          rowIndex: 2,
        },
      },
    ],
  };
  await c.records.prepareMaterialSelections(patch, actor);
  c.changes.direct(
    [
      {
        op: "editExperiment",
        owner: nodeRef(node.id),
        expectedExperimentRevision: 2,
        patch,
      },
    ],
    actor,
  );
  const linked = c.records.overview(node.id, actor).materialLinks[0],
    { tool, ...input } = linked.readHint;
  const values = await executeResearchTool(
    { researchCommands: c },
    tool,
    input,
    actor,
    null,
  );
  assert.equal(values.data.items[0].values.c2, 16);
  assert.equal(linked.selection.sheet, "Config");
  const revision = c.records.overview(node.id, actor).revision;
  assert.throws(
    () =>
      c.changes.direct(
        [
          {
            op: "editExperiment",
            owner: nodeRef(node.id),
            expectedExperimentRevision: revision,
            patch: {
              addLinks: [
                {
                  ...patch.addLinks[0],
                  selection: { ...patch.addLinks[0].selection, rowIndex: 99 },
                },
              ],
            },
          },
        ],
        actor,
      ),
    { code: "EXPERIMENT_MATERIAL_INVALID" },
  );
  const agent = {
    isAgent: true,
    user: { id: "owner" },
    principalId: "agent:sheet",
    sessionId: "session:sheet",
    projectId: "records",
    permissions: ["research.view", "research.proposeChange"],
  };
  const runs = await c.records.read({ mode: "runs", nodeId: node.id }, agent),
    manifest = await c.queries.readBlocks({
      actor: agent,
      mode: "read",
      owner: nodeRef(node.id),
      blockId: block.id,
      view: "manifest",
    });
  const ids = [...runs.readReceipts, ...manifest.readReceipts].map(
    (receipt) => receipt.id,
  );
  const candidateInput = {
    reason: "Associate the observed config row",
    nodeChanges: [
      {
        nodeId: node.id,
        expectedExperimentRevision: revision,
        experimentPatch: {
          addLinks: [
            {
              ...patch.addLinks[0],
              selection: { ...patch.addLinks[0].selection, rowIndex: 1 },
            },
          ],
        },
      },
    ],
  };
  assert.throws(
    () =>
      c.proposals.create({ ...candidateInput, evidenceReadIds: ids }, agent),
    { code: "EVIDENCE_SCOPE_INSUFFICIENT" },
  );
  const row = await c.queries.readAssets({
    actor: agent,
    assetId: asset.id,
    view: "values",
    selection: { sheet: "Config", rowOffset: 1, rowLimit: 1 },
  });
  const proposed = c.proposals.create(
    {
      ...candidateInput,
      evidenceReadIds: [
        ...ids,
        ...row.readReceipts.map((receipt) => receipt.id),
      ],
    },
    agent,
  );
  c.reviewCandidate({
    actor,
    candidateId: proposed.id,
    expectedRevision: 1,
    decision: "accept",
  });
  assert.equal(c.records.overview(node.id, actor).materialLinks.length, 2);
});
