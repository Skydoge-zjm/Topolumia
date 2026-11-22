import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

async function verifyBytes(root, storageKey, expected) {
  const disk = await realpath(path.resolve(root, storageKey)), relative = path.relative(root, disk);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "File outside the expected root");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(disk)) { hash.update(chunk); bytes += chunk.length; }
  assert.equal("sha256:" + hash.digest("hex"), expected, storageKey);
  return bytes;
}

export async function inspectProject(directory) {
  const workspace = await realpath(directory), data = path.join(workspace, ".topolumia");
  const manifest = JSON.parse(await readFile(path.join(data, "project.json"), "utf8"));
  const db = new DatabaseSync(path.join(data, "research.sqlite"), { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    const stored = table => db.prepare("SELECT body FROM " + table + " WHERE project_id=?").all(manifest.id).map(row => JSON.parse(row.body));
    const nodes = stored("research_nodes"), groups = stored("research_groups"), blocks = stored("research_content_blocks").filter(b => b.lifecycle !== "archived");
    const assets = stored("research_assets"), candidates = stored("research_candidates");
    const state = JSON.parse(db.prepare("SELECT state_json FROM project_snapshots WHERE project_id=?").get(manifest.id).state_json);
    const nodeIds = new Set(nodes.map(n => n.id)), groupMap = new Map(groups.map(g => [g.id, g]));
    const known = ref => ref.kind === "node" ? nodeIds.has(ref.id) : groupMap.has(ref.id);
    for (const edge of state.topology.edges) assert.ok(known(edge.from) && known(edge.to), "Dangling edge " + edge.id);
    let depth = 0;
    for (const group of groups) {
      assert.ok(group.members.every(m => nodeIds.has(m.nodeId)));
      const chain = new Set([group.id]);
      let current = group;
      while (current.parentId) {
        assert.ok(!chain.has(current.parentId), "Cycle in group hierarchy");
        current = groupMap.get(current.parentId);
        assert.ok(current, "Missing parent");
        chain.add(current.id);
      }
      depth = Math.max(depth, chain.size);
    }
    const assetIds = new Set(assets.map(a => a.id)), assetRoot = await realpath(path.join(data, "research-assets"));
    for (const asset of assets) {
      assert.equal(await verifyBytes(assetRoot, asset.storageKey, asset.checksum), asset.sizeBytes, asset.originalName);
    }
    for (const file of state.snapshot.files.files) await verifyBytes(workspace, file.relativePath, file.version);
    for (const block of blocks) {
      assert.ok(known(block.owner));
      for (const r of block.representations) if (r.kind === "asset") assert.ok(assetIds.has(r.assetId));
      if (block.type === "chart") assert.ok(blocks.some(b => b.id === block.payload?.dataBlockId));
    }
    const decisions = blocks.filter(b => b.type === "metric" && ["Preliminary","Amended"].includes(b.title)).map(b => ({
      stage: b.title, values: b.payload.items.map(i => ({ name: i.name, value: i.value })), nodeId: b.owner.id,
    }));
    const sourceVersions = receipts => (receipts ?? []).filter(r => r.object.kind === "source").map(r => ({ ref: r.object.id, version: r.version }));
    return { projectId: manifest.id, name: manifest.name, workspace, nodes: nodes.length, groups: groups.length, groupDepth: depth,
      edges: state.topology.edges.length, blockCount: blocks.length, blockTypes: [...new Set(blocks.map(b => b.type))].sort(),
      nodeKinds: [...new Set(nodes.map(n => n.kind))].sort(), runCount: blocks.filter(b => b.type === "experimentRecord").reduce((n,b) => n + b.payload.runs.length,0),
      verifiedAssetBytes: assets.reduce((s, a) => s + a.sizeBytes, 0), verifiedAssets: assets.length,
      indexedSources: state.snapshot.files.files.map(f => ({ ref: f.ref, version: f.version })), decisions,
      candidates: candidates.map(c => ({ id: c.id, status: c.status, revision: c.revision, history: c.revisions?.length ?? 0,
        currentSources: sourceVersions(c.evidenceReads), historicalSources: (c.revisions ?? []).flatMap(v => sourceVersions(v.evidenceReads)) })) };
  } finally { db.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node inspect-project.mjs PROJECT_DIRECTORY");
  console.log(JSON.stringify(await inspectProject(process.argv[2]), null, 2));
}
