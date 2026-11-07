import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ResearchCommandService } from "../../src/services/research/research-command-service.js";
import { ResearchState } from "../../src/services/research/research-state.js";
import { TopologyService } from "../../src/services/topology/topology-service.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-read-scopes-"));
  const db = new DatabaseSync(":memory:"), topologyService = new TopologyService({ demo: false });
  const c = new ResearchCommandService({ db, topologyService, state: new ResearchState(topologyService.build()), projectId: "scopes", assetRoot: root });
  const actor = { projectId: "scopes", isAgent: false, user: { id: "owner" }, permissions: ["*"] };
  t.after(async () => { await c.assets.close(); await c.records.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  const created = c.changes.direct([{ op: "addNode", clientRef: "target", kind: "note", core: { nodeName: "Target" } }, { op: "addNode", clientRef: "other", kind: "note", core: { nodeName: "Other" } }], actor);
  return { c, actor, id: created.allocation["node:target"], other: created.allocation["node:other"] };
}

test("node details, overviews, node search and block reads never hydrate unrelated blocks", async t => {
  const { c, actor, id, other } = await fixture(t), owner = { kind: "node", id };
  const change = c.changes.direct([{ op: "addBlock", owner, clientRef: "body", title: "Body", type: "richText", payload: { format: "plain", body: "Only target content" } }], actor);
  c.store.put("blocks", "block:unrelated", { id: "block:unrelated", owner: { kind: "node", id: other }, type: "richText", title: "Other", revision: 1, lifecycle: "active", payload: { format: "plain", body: "x".repeat(100000) } });
  const original = c.store.all.bind(c.store);
  c.store.all = type => { assert.notEqual(type, "blocks", "A scoped read loaded the whole block collection"); return original(type); };
  const detail = c.objects.detail(owner);
  assert.equal(detail.contentBlocks.length, 2); // Automatic note body plus the explicit material.
  assert.ok(detail.contentBlocks.every(block => block.owner.id === id));
  assert.equal(c.queries.readNodes({ actor, nodeIds: [id] }).data.items[0].blockCount, 2);
  assert.deepEqual(c.queries.readNodes({ actor, nodeIds: [id, id] }).data.items.map(item => item.blockCount), [2, 2]);
  assert.equal(c.queries.search({ actor, target: "nodes", query: "Target" }).data.items[0].id, id);
  const block = await c.queries.readBlocks({ actor, owner, mode: "read", blockId: change.allocation["block:body"], view: "text" });
  assert.equal(block.data.text, "Only target content");
});

test("a budget-limited table reports omitted rows and receipts cover only returned data", async t => {
  const { c, actor, id } = await fixture(t), owner = { kind: "node", id };
  const change = c.changes.direct([{ op: "addBlock", owner, clientRef: "table", title: "Results", type: "table", payload: { columns: [{ key: "c1", label: "Value" }], rows: Array.from({ length: 40 }, (_, i) => ({ c1: i + ":" + "x".repeat(220) })) } }], actor);
  const input = { actor, owner, mode: "read", blockId: change.allocation["block:table"], view: "values", selection: { rowOffset: 1, rowLimit: 20 }, maxChars: 2000 };
  const limited = await c.queries.readBlocks(input);
  assert.ok(limited.data.items.length < 20);
  assert.equal(limited.coverage.complete, false);
  assert.deepEqual(limited.coverage.omissions, ["remainingRows"]);
  assert.equal(limited.readReceipts[0].delivered.tableRanges[0].end, 1 + limited.data.items.length);
  assert.equal(limited.data.nextSelection.rowOffset, 1 + limited.data.items.length);
  const complete = await c.queries.readBlocks({ ...input, maxChars: 16000 });
  assert.equal(complete.data.items.length, 20);
  assert.equal(complete.coverage.complete, true);
});
