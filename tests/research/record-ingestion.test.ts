import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { ResearchCommandService } from "../../src/services/research/research-command-service.js";
import { ResearchState } from "../../src/services/research/research-state.js";
import { TopologyService } from "../../src/services/topology/topology-service.js";
import { sha256 } from "../../src/lib/hash.js";
import { spawnSync } from "node:child_process";
import { collectorPackage } from "../../src/services/research/experiments/collector-package.js";
import { ManagedRecordCollectors } from "../../src/services/environments/managed-record-collectors.js";
import { unzipSync } from "fflate";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-ingestion-"));
  let c, db;
  const actor = {
    isAgent: false,
    user: { id: "owner" },
    projectId: "ingestion",
    permissions: ["*"],
  };
  const start = async () => {
    db = new DatabaseSync(path.join(root, "data.sqlite"));
    const topologyService = new TopologyService({ demo: false });
    c = new ResearchCommandService({
      db,
      state: new ResearchState(topologyService.build()),
      topologyService,
      projectId: "ingestion",
      assetRoot: path.join(root, "assets"),
    });
    await c.assets.initialize();
    return c;
  };
  await start();
  t.after(async () => {
    await c.records.close();
    await c.assets.close();
    db.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const view = c.changes.direct(
    [
      {
        op: "addNode",
        clientRef: "n",
        kind: "experiment",
        core: { nodeName: "Synthetic" },
      },
      {
        op: "addBlock",
        owner: { kind: "node", id: "@n" },
        clientRef: "b",
        title: "Records",
        type: "experimentRecord",
        payload: { provider: "wandb", runs: [] },
      },
      {
        op: "addBlock",
        owner: { kind: "node", id: "@n" },
        clientRef: "other",
        title: "Independent",
        type: "experimentRecord",
        payload: { provider: "tensorboard", runs: [] },
      },
    ],
    actor,
  );
  const blockId = view.allocation["block:b"],
    nodeId = view.allocation["node:n"],
    otherId = view.allocation["block:other"];
  const batch = (events) => ({
    version: 1,
    provider: "wandb",
    streamId: "source",
    writerId: "writer",
    generation: "first",
    events: events.map((event, index) => ({
      sourceRunId: "native-run",
      seq: index,
      ...event,
    })),
  });
  return {
    c,
    actor,
    root,
    blockId,
    otherId,
    nodeId,
    batch,
    restart: async () => {
      await c.records.close();
      await c.assets.close();
      db.close();
      return start();
    },
  };
}

test("managed deployments bundle only the shared reader sources", async () => {
  const files = unzipSync(Buffer.from(await collectorPackage(), "base64"));
  assert.deepEqual(Object.keys(files).sort(), ["topolumia_collector/__init__.py", "topolumia_collector/adapters.py", "topolumia_collector/cli.py", "topolumia_collector/spool.py", "wandb_record_reader.py"]);
  assert.match(Buffer.from(files["topolumia_collector/cli.py"]).toString(), /connectionId/);
});

test("durable identities survive ACK loss and restart while real repeated/reset steps remain exact", async (t) => {
  const f = await fixture(t);
  let { c } = f;
  const input = f.batch([
    { kind: "run", label: "Native", status: "running" },
    ...[0, 0, 10, 1].map((x, i) => ({
      kind: "scalar",
      key: "loss",
      x,
      value: i + 0.25,
    })),
  ]);
  const revision = c.nodes.node(f.nodeId).revision;
  const ack = c.ingestion.receive(f.blockId, input, f.actor);
  assert.equal(ack.accepted, 5);
  assert.equal(ack.indexedWatermark, ack.durableWatermark);
  c = await f.restart();
  assert.equal(c.ingestion.receive(f.blockId, input, f.actor).duplicate, 5);
  const runs = c.records.overview(f.nodeId, f.actor, undefined, f.blockId).runs;
  assert.equal(runs.length, 1);
  const result = await c.records.read(
    {
      mode: "series",
      nodeId: f.nodeId,
      blockId: f.blockId,
      runId: runs[0].id,
      metric: "loss",
    },
    f.actor,
  );
  assert.deepEqual(
    result.data.points,
    [0, 0, 10, 1].map((x, i) => ({ x, y: i + 0.25 })),
  );
  assert.equal(c.ingestion.rebuild(f.blockId, f.actor).replayed, 5);
  assert.deepEqual(
    c.ingestion.points(f.blockId, runs[0].id, "loss", "step", { limit: 100 }, 5)
      .points,
    result.data.points,
  );
  assert.equal(c.nodes.node(f.nodeId).revision, revision);
  assert.equal(
    c.records.overview(f.nodeId, f.actor, undefined, f.otherId).runs.length,
    0,
  );
  const conflict = f.batch([
    { seq: 5, kind: "scalar", key: "loss", x: 11, value: 1 },
    { seq: 1, kind: "scalar", key: "loss", x: 0, value: 999 },
  ]);
  assert.throws(() => c.ingestion.receive(f.blockId, conflict, f.actor), {
    code: "INGESTION_IDENTITY_CONFLICT",
  });
  assert.equal(c.ingestion.watermark(f.blockId), 5);
});

test("fixed snapshots preserve directory, source revision, exact typed numbers and range reads", async (t) => {
  const { c, actor, blockId, nodeId, batch } = await fixture(t);
  const typed = { dtype: "int64", value: "18014398509481985" };
  c.ingestion.receive(
    blockId,
    batch([
      { kind: "run", label: "First label", status: "running" },
      { kind: "scalar", key: "counter", x: 0, value: typed },
    ]),
    actor,
  );
  const snapshot = c.ingestion.snapshot(blockId, actor),
    runId = snapshot.runs[0].id;
  c.ingestion.receive(
    blockId,
    batch([
      { seq: 2, kind: "run", label: "Later label", status: "succeeded" },
      { seq: 3, kind: "scalar", key: "counter", x: 1, value: 2 },
    ]),
    actor,
  );
  const exact = await c.records.read(
    {
      mode: "series",
      nodeId,
      blockId,
      snapshotId: snapshot.id,
      runId,
      metric: "counter",
    },
    actor,
  );
  assert.equal(exact.data.pointCount, 1);
  assert.deepEqual(exact.data.points, [{ x: 0, y: typed }]);
  assert.equal(
    c.ingestion.getSnapshot(snapshot.id, actor).runs[0].label,
    "First label",
  );
  const live = await c.records.read(
    { mode: "metrics", nodeId, blockId, runId },
    actor,
  );
  assert.equal(live.data.items[0].pointCount, 2);
  const sample = c.ingestion.points(
    blockId,
    runId,
    "counter",
    "step",
    { maxPoints: 100 },
    4,
  );
  assert.equal(sample.points.length, 2);
});

test("grants bind one block, recheck permissions, renew and revoke without exposing stored secrets", async (t) => {
  const { c, actor, blockId, otherId, batch } = await fixture(t);
  const grant = c.ingestion.grant(blockId, actor);
  const collector = c.ingestion.authenticate(grant.token, () => actor);
  assert.throws(
    () =>
      c.ingestion.receive(
        otherId,
        batch([{ kind: "run", label: "X" }]),
        collector,
      ),
    { code: "INGESTION_SCOPE_MISMATCH" },
  );
  assert.throws(
    () =>
      c.ingestion.authenticate(grant.token, () => ({
        ...actor,
        permissions: ["research.view"],
      })),
    { code: "FORBIDDEN" },
  );
  assert.ok(
    !JSON.stringify(c.ingestion.status(blockId, actor)).includes(grant.token),
  );
  c.ingestion.changeGrant(blockId, grant.id, "renew", actor);
  c.ingestion.receive(
    blockId,
    batch([{ kind: "run", label: "Allowed" }]),
    collector,
  );
  c.ingestion.changeGrant(blockId, grant.id, "revoke", actor);
  assert.throws(
    () =>
      c.ingestion.receive(
        blockId,
        batch([{ kind: "run", label: "Allowed" }]),
        collector,
      ),
    { code: "COLLECTOR_CREDENTIAL_INVALID" },
  );
  assert.throws(() => c.ingestion.authenticate(grant.token, () => actor), {
    code: "COLLECTOR_CREDENTIAL_INVALID",
  });
});

test("attachments arrive separately, are hash checked and do not block metric visibility", async (t) => {
  const { c, actor, blockId, batch } = await fixture(t);
  const data = Buffer.from("synthetic artifact"),
    hash = sha256(data);
  const ack = c.ingestion.receive(
    blockId,
    batch([
      {
        kind: "media",
        key: "preview",
        data: { attachments: [{ sha256: hash, name: "image.txt" }] },
      },
    ]),
    actor,
  );
  assert.equal(ack.attachmentsComplete, false);
  await assert.rejects(
    c.ingestion.uploadAttachment(
      blockId,
      hash,
      Readable.from([Buffer.from("bad")]),
      actor,
    ),
    { code: "ATTACHMENT_CHECKSUM_MISMATCH" },
  );
  assert.equal(c.ingestion.pendingAttachments(blockId), 1);
  await c.ingestion.uploadAttachment(
    blockId,
    hash,
    Readable.from([data]),
    actor,
  );
  await c.ingestion.uploadAttachment(
    blockId,
    hash,
    Readable.from([data]),
    actor,
  );
  assert.equal(c.ingestion.pendingAttachments(blockId), 0);
  assert.deepEqual(await readFile(c.ingestion.blobPath(blockId, hash)), data);
});

test("large histories use bounded sampling and indexed exact pages including step regressions", async (t) => {
  const { c, actor, blockId, nodeId, batch } = await fixture(t);
  for (let offset = 0; offset < 12000; offset += 120)
    c.ingestion.receive(
      blockId,
      batch(
        Array.from({ length: 120 }, (_, i) => ({
          seq: offset + i,
          kind: "scalar",
          key: "loss",
          x: (offset + i) % 500,
          value: i === 40 ? 100 : Math.sin(i),
        })),
      ),
      actor,
    );
  const run = c.records.overview(nodeId, actor).runs[0];
  const plot = await c.records.plot(
    { selections: [{ nodeId, blockId, runId: run.id }], maxPoints: 100 },
    actor,
  );
  assert.ok(plot.series[0].points.length <= 100);
  assert.equal(plot.series[0].pointCount, 12000);
  assert.ok(plot.series[0].points.some((point) => point.y === 100));
  const page = c.ingestion.points(
    blockId,
    run.id,
    "loss",
    "step",
    { offset: 11990, limit: 10 },
    c.ingestion.watermark(blockId),
  );
  assert.equal(page.points.length, 10);
  assert.equal(page.points[0].x, 490);
});

test("archived blocks and deleted nodes retain snapshot evidence and attachment export authorization", async (t) => {
  const { c, actor, blockId, nodeId, batch } = await fixture(t);
  const bytes = Buffer.from("original native file"),
    hash = sha256(bytes);
  c.ingestion.receive(
    blockId,
    batch([
      { kind: "scalar", key: "loss", x: 0, value: 0.5 },
      {
        kind: "file",
        key: "native/source",
        data: { attachments: [{ sha256: hash, name: "source.wandb" }] },
      },
    ]),
    actor,
  );
  await c.ingestion.uploadAttachment(
    blockId,
    hash,
    Readable.from([bytes]),
    actor,
  );
  const snapshot = c.ingestion.snapshot(blockId, actor);
  const exported = await c.assets.export(
    {
      target: { kind: "recordAttachment", blockId, sha256: hash },
      variant: "original",
      idempotencyKey: "native-download",
    },
    actor,
  );
  assert.equal(exported.checksum, "sha256:" + hash);
  const revision = c.store.get("blocks", blockId).revision;
  c.changes.direct(
    [
      {
        op: "archiveBlock",
        owner: { kind: "node", id: nodeId },
        blockId,
        expectedRevision: revision,
      },
    ],
    actor,
  );
  c.changes.direct(
    [
      {
        op: "deleteNode",
        nodeId,
        expectedNodeRevision: c.nodes.node(nodeId).revision,
      },
    ],
    actor,
  );
  const raw = await c.records.read(
    {
      mode: "series",
      nodeId,
      blockId,
      snapshotId: snapshot.id,
      runId: snapshot.runs[0].id,
      metric: "loss",
    },
    actor,
  );
  assert.deepEqual(raw.data.points, [{ x: 0, y: 0.5 }]);
  await assert.rejects(
    c.records.read(
      {
        mode: "series",
        nodeId,
        blockId,
        snapshotId: snapshot.id,
        runId: snapshot.runs[0].id,
        metric: "loss",
      },
      { ...actor, permissions: [] },
    ),
    { code: "FORBIDDEN" },
  );
});

test("large native records are bounded in directories and exactly readable by event ranges", async (t) => {
  const { c, actor, blockId, nodeId, batch } = await fixture(t);
  const text = "x".repeat(70000);
  c.ingestion.receive(
    blockId,
    batch([{ kind: "config", data: { update: { long: text } } }]),
    actor,
  );
  const directory = await c.records.read(
    { mode: "events", nodeId, blockId, eventKind: "config" },
    actor,
  );
  assert.equal(directory.data.items.length, 1);
  assert.equal(directory.data.items[0].event.data.truncated, true);
  assert.equal(directory.coverage.complete, false);
  assert.ok(directory.coverage.omissions.includes("recordPreview"));
  const exact = c.ingestion.eventText(blockId, 1, actor, 10000, 12000);
  assert.equal(exact.text.length, 12000);
  assert.equal(exact.nextOffset, 22000);
  assert.ok(exact.text.split("").every((char) => char === "x"));
});

test("editing a live run note preserves subsequent source lifecycle changes", async (t) => {
  const { c, actor, blockId, nodeId, batch } = await fixture(t);
  c.ingestion.receive(
    blockId,
    batch([{ kind: "run", label: "Live", status: "running" }]),
    actor,
  );
  const run = c.records.overview(nodeId, actor, undefined, blockId).runs[0];
  c.changes.direct(
    [
      {
        op: "editExperiment",
        owner: { kind: "node", id: nodeId },
        blockId,
        expectedExperimentRevision: 1,
        patch: {
          updateRuns: [{ id: run.id, note: "Observed on training host" }],
        },
      },
    ],
    actor,
  );
  c.ingestion.receive(
    blockId,
    batch([
      {
        seq: 1,
        kind: "lifecycle",
        data: { status: "succeeded", evidence: "native-exit" },
      },
    ]),
    actor,
  );
  const current = c.records.overview(nodeId, actor, undefined, blockId).runs[0];
  assert.equal(current.note, "Observed on training host");
  assert.equal(current.status, "succeeded");
});

test("one-time collection handover preserves legacy metadata and original block evidence", async (t) => {
  const f = await fixture(t);
  const node = f.c.store.get("nodes", f.nodeId);
  f.c.store.put("nodes", f.nodeId, {
    ...node,
    runs: [
      {
        id: "run:preserved",
        label: "Original attempt",
        status: "failed",
        sources: [],
      },
    ],
    materialLinks: [],
    experimentRevision: 4,
  });
  f.c.store.remove("collections", f.blockId);
  f.c.store.remove("collections", f.otherId);
  let c = await f.restart();
  assert.equal(c.nodes.node(f.nodeId).runs, undefined);
  assert.equal(
    c.records.overview(f.nodeId, f.actor).runs[0].label,
    "Original attempt",
  );
  assert.equal(
    c.store.get("settings", "preserved-node-records:" + f.nodeId).node.runs[0]
      .id,
    "run:preserved",
  );
  const before = c.store.all("collections");
  c = await f.restart();
  assert.deepEqual(c.store.all("collections"), before);
});

test("a killed receiver preserves its acknowledged transaction without graceful cleanup", async (t) => {
  const { c, root, blockId, batch } = await fixture(t);
  const input = batch([{ kind: "scalar", key: "loss", x: 1, value: 0.25 }]);
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    import { ResearchCommandService } from ${JSON.stringify(new URL("../../src/services/research/research-command-service.js", import.meta.url).href)};
    const db = new DatabaseSync(${JSON.stringify(path.join(root, "data.sqlite"))});
    const c = new ResearchCommandService({ db, projectId: 'ingestion', assetRoot: ${JSON.stringify(path.join(root, "assets"))} });
    c.ingestion.receive(${JSON.stringify(blockId)}, ${JSON.stringify(input)}, { isAgent: false, user: { id: 'owner' }, projectId: 'ingestion', permissions: ['*'] });
    process.kill(process.pid, 'SIGKILL');
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { timeout: 10000, windowsHide: true },
  );
  assert.ok(result.signal === "SIGKILL" || result.status !== 0);
  assert.equal(c.ingestion.watermark(blockId), 1);
  const runId = c.ingestion.runs(blockId)[0].id;
  assert.deepEqual(
    c.ingestion.points(blockId, runId, "loss", "step", { limit: 10 }, 1).points,
    [{ x: 1, y: 0.25 }],
  );
});

test("event sequence gaps fail without advancing while retrying older batches never rewinds progress", async (t) => {
  const { c, actor, blockId, batch } = await fixture(t);
  const first = batch([{ kind: "scalar", key: "loss", x: 0, value: 1 }]);
  c.ingestion.receive(blockId, first, actor);
  assert.throws(
    () =>
      c.ingestion.receive(
        blockId,
        batch([{ seq: 2, kind: "scalar", key: "loss", x: 1, value: 1 }]),
        actor,
      ),
    { code: "INGESTION_SEQUENCE_GAP" },
  );
  assert.equal(c.ingestion.watermark(blockId), 1);
  c.ingestion.receive(
    blockId,
    batch([{ seq: 1, kind: "scalar", key: "loss", x: 1, value: 0.5 }]),
    actor,
  );
  c.ingestion.receive(blockId, first, actor);
  assert.equal(c.ingestion.status(blockId, actor).streams[0].lastSequence, 1);
});

test("project collection discovers unassigned runs and explicit blocks isolate curves, rich events and attachments", async t => {
  const { c, actor, nodeId, blockId, otherId, batch } = await fixture(t);
  const source = c.projectRecords.configure({ hostId: "local", hostLabel: "Training host", provider: "wandb", directory: "/training/project" }, actor);
  const hash = sha256("private-to-b");
  c.ingestion.receive(source.id, { ...batch([
    { kind: "run", sourceRunId: "a", label: "Attempt A", status: "running" },
    { kind: "scalar", sourceRunId: "a", key: "loss", x: 0, value: .8 },
    { kind: "config", sourceRunId: "a", data: { rank: 4 } },
    { kind: "run", sourceRunId: "b", label: "Attempt B", status: "failed" },
    { kind: "scalar", sourceRunId: "b", key: "loss", x: 0, value: .2 },
    { kind: "file", sourceRunId: "b", data: { attachments: [{ sha256: hash }] } },
  ]), streamId: "experiments/rank4/run.wandb" }, actor);
  await c.ingestion.uploadAttachment(source.id, hash, Readable.from([Buffer.from("private-to-b")]), actor);
  const available = c.projectRecords.directory(actor, { unassigned: true });
  assert.equal(available.total, 2);
  const [a, b] = available.items.sort((a, b) => a.label.localeCompare(b.label));
  for (const [id, entry] of [[blockId, a], [otherId, b]]) {
    const old = c.store.get("blocks", id);
    c.changes.direct([{ op: "updateBlock", owner: { kind: "node", id: nodeId }, blockId: id, expectedRevision: old.revision, patch: { payload: { provider: "wandb", runs: [{ sourceId: entry.sourceId, label: entry.label, status: entry.status, assetIds: [], projectSource: entry.projectSource }] } } }], actor);
  }
  assert.equal(c.projectRecords.directory(actor, { unassigned: true }).total, 0);
  const first = await c.records.plot({ nodeId, blockId }, actor);
  assert.equal(first.runs.length, 1); assert.equal(first.runs[0].runLabel, "Attempt A");
  assert.deepEqual(first.series[0].points, [{ x: 0, y: .8 }]);
  const second = await c.records.plot({ nodeId, blockId: otherId }, actor);
  assert.deepEqual(second.series[0].points, [{ x: 0, y: .2 }]);
  const events = c.ingestion.events(blockId, actor, { kind: "config" });
  assert.equal(events.items.length, 1); assert.equal(events.items[0].event.data.rank, 4);
  assert.equal(c.ingestion.events(blockId, actor, { kind: "file" }).items.length, 0);
  assert.throws(() => c.projectRecords.attachment(c.store.get("blocks", blockId), hash), { code: "ATTACHMENT_NOT_FOUND" });
  assert.ok(c.projectRecords.attachment(c.store.get("blocks", otherId), hash).path);
  assert.equal(c.ingestion.sql("SELECT count(*) AS count FROM record_events WHERE project=?").get(c.projectId).count, 6, "binding must not copy records");
  const result = await c.records.read({ mode: "available", actor, maxChars: 16000 }, actor);
  assert.equal(result.data.items.length, 2);
});

test("source snapshots freeze run selection and watermarks across new runs, removal and source lifecycle updates", async t => {
  const { c, actor, nodeId, blockId, batch } = await fixture(t);
  const source = c.projectRecords.configure({ hostId: "local", hostLabel: "Host", provider: "wandb", directory: "/project" }, actor);
  const native = events => ({ ...batch(events), streamId: "experiments/rank4/run.wandb" });
  c.ingestion.receive(source.id, native([{ kind: "run", label: "First", status: "running" }, { kind: "scalar", key: "loss", x: 0, value: 1 }, { kind: "config", data: { rank: 4 } }]), actor);
  const block = c.store.get("blocks", blockId);
  c.changes.direct([{ op: "updateBlock", owner: { kind: "node", id: nodeId }, blockId, expectedRevision: block.revision, patch: { payload: { provider: "wandb", runs: [], followSources: [{ sourceId: source.id, directory: "experiments/rank4" }] } } }], actor);
  const pinned = c.ingestion.snapshot(blockId, actor), runId = pinned.runs[0].id;
  c.ingestion.receive(source.id, native([{ seq: 3, kind: "scalar", key: "loss", x: 1, value: .5 }, { seq: 4, kind: "lifecycle", data: { status: "failed" } }, { seq: 5, kind: "run", sourceRunId: "second", label: "Retry", status: "running" }, { seq: 6, kind: "scalar", sourceRunId: "second", key: "loss", x: 0, value: .3 }]), actor);
  assert.equal(c.records.overview(nodeId, actor, undefined, blockId).runs.length, 2);
  const fixed = await c.records.table({ nodeId, blockId, runId, snapshotId: pinned.id, metrics: [{ key: "loss", xKey: "step" }] }, actor);
  assert.deepEqual(fixed.columns[0].points, [{ x: 0, y: 1 }]);
  assert.equal(c.ingestion.getSnapshot(pinned.id, actor).runs[0].status, "running");
  assert.equal(c.ingestion.events(blockId, actor, { snapshotId: pinned.id, kind: "lifecycle" }).items.length, 0);
  const event = c.ingestion.events(blockId, actor, { snapshotId: pinned.id, kind: "config" }).items[0];
  assert.match(c.ingestion.eventText(blockId, event.watermark, actor, 0, 4000, pinned.id).text, /rank/);
  const current = c.store.get("blocks", blockId);
  c.changes.direct([{ op: "updateBlock", owner: { kind: "node", id: nodeId }, blockId, expectedRevision: current.revision, patch: { payload: { provider: "wandb", runs: [] } } }], actor);
  assert.equal(c.records.overview(nodeId, actor, undefined, blockId).runs.length, 0);
  const preserved = await c.records.table({ nodeId, blockId, runId, snapshotId: pinned.id, metrics: [{ key: "loss", xKey: "step" }] }, actor);
  assert.deepEqual(preserved.columns[0].points, [{ x: 0, y: 1 }]);
});

test("project source credentials cannot alter membership and auto-assignment rejects common roots", async t => {
  const { c, actor, blockId } = await fixture(t);
  const source = c.projectRecords.configure({ hostId: "local", hostLabel: "Host", provider: "wandb", directory: "/project" }, actor);
  assert.throws(() => c.projectRecords.configure({ ...source }, { ...actor, permissions: ["research.view", "research.applyChange"] }), { code: "FORBIDDEN" });
  const grant = c.ingestion.grant(source.id, actor), collector = c.ingestion.authenticate(grant.token, () => actor);
  assert.throws(() => c.ingestion.block(blockId, collector, true), { code: "INGESTION_SCOPE_MISMATCH" });
  assert.throws(() => c.projectRecords.assign({ runs: [] }, collector), { code: "FORBIDDEN" });
  for (const directory of ["wandb", "runs", "../outside", "/project", "logs"]) assert.throws(() => c.projectRecords.validateRules([{ sourceId: source.id, directory }], "wandb"), { code: "RECORD_RULE_INVALID" });
  assert.doesNotThrow(() => c.projectRecords.validateRules([{ sourceId: source.id, directory: "experiments/rank4" }], "wandb"));
  c.projectRecords.save({ ...source, enabled: false });
  assert.throws(() => c.ingestion.block(source.id, collector, true), { code: "COLLECTION_PAUSED" });
});

test("resuming one managed directory preserves other collectors and invalid replacement ranges leave them enabled", async t => {
  const { c, actor, root } = await fixture(t), first = path.join(root, "first"), second = path.join(root, "second");
  await mkdir(first); await mkdir(second);
  const runtime = { config: { project: { id: c.projectId, root }, experimentRecords: { pythonCommand: "python" } }, researchCommands: c };
  const manager = new ManagedRecordCollectors({ runtimes: new Map(), address: () => ({ host: "127.0.0.1", port: 12345 }), collaboration: { actorForUser: () => actor } });
  t.after(() => manager.close());
  manager.control = async () => ({ status: "starting" });
  await manager.enable(runtime, actor, "local", "wandb", [first, second]);
  await Promise.all([...manager.tasks.values()]);
  const source = c.projectRecords.all().find(source => source.directory === first);
  await manager.pause(runtime, actor, source.id);
  await manager.resume(runtime, actor, source.id);
  await Promise.all([...manager.tasks.values()]);
  assert.equal(c.projectRecords.all().filter(source => source.enabled).length, 2);
  await assert.rejects(() => manager.enable(runtime, actor, "local", "wandb", [first, path.join(first, "child")]), { code: "COLLECTION_CONFIG_INVALID" });
  await assert.rejects(() => manager.enable(runtime, actor, "local", "wandb", [path.join(root, "missing")]), { code: "COLLECTION_CONFIG_INVALID" });
  assert.equal(c.projectRecords.all().filter(source => source.enabled).length, 2);
});
