import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { sha256 } from "../../../lib/hash.js";
import { sqliteTransaction } from "../../../lib/sqlite-transaction.js";
import { storedResearchNodeKind } from "../../../domain/research/node-kinds.js";
const tables = { collections: "research_record_collections", nodes: "research_nodes", groups: "research_groups", blocks: "research_content_blocks", versions: "research_content_block_versions", assets: "research_assets", candidates: "research_candidates", receipts: "research_read_receipts", jobs: "research_asset_jobs", uploads: "research_asset_uploads", settings: "research_interface_settings" };
function readStored(type, body) {
  const value = JSON.parse(body);
  if (type === "nodes") value.kind = storedResearchNodeKind(value.kind) ?? value.kind;
  if (type === "candidates") for (const operation of value.operations ?? []) if (operation.op === "addNode") operation.kind = storedResearchNodeKind(operation.kind) ?? operation.kind;
  if (type === "candidates") for (const node of value.finalSnapshot?.nodes ?? []) node.kind = storedResearchNodeKind(node.kind) ?? node.kind;
  return value;
}
export class ResearchRepository {
  constructor(db, projectId) {
    this.db = db ?? new DatabaseSync(":memory:"); this.projectId = projectId;
    for (const table of Object.values(tables)) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table}(project_id TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,id))`);
    this.db.exec("CREATE INDEX IF NOT EXISTS research_candidates_session ON research_candidates(project_id,json_extract(body,'$.provenance.sessionId')); CREATE INDEX IF NOT EXISTS research_receipts_session ON research_read_receipts(project_id,json_extract(body,'$.researchSessionId'));");
    this.db.exec("CREATE INDEX IF NOT EXISTS research_blocks_owner ON research_content_blocks(project_id,json_extract(body,'$.owner.kind'),json_extract(body,'$.owner.id'));");
    if (!this.get("settings", "cursor")) this.put("settings", "cursor", { secret: randomBytes(32).toString("hex") });
    this.adoptRecordCollections();
  }
  /** A single transactional handover retains the original node/blocks verbatim.
   * Live reads and all future writes use only independent block collections.
   */
  adoptRecordCollections() {
    const legacy = this.db.prepare("SELECT id,body FROM research_nodes WHERE project_id=? AND json_type(body,'$.runs')='array'").all(this.projectId);
    if (!legacy.length) return;
    this.transaction(() => {
      for (const row of legacy) {
        const node = JSON.parse(row.body), owner = { kind: "node", id: node.id };
        const blocks = this.blocksForOwner(owner);
        this.put("settings", "preserved-node-records:" + node.id, { node, blocks });
        let records = blocks.filter(block => block.type === "experimentRecord");
        if (!records.length && (node.runs?.length || node.materialLinks?.length)) {
          const block = { id: "block:" + sha256(node.id + ":preserved-records").slice(0, 32), owner, title: "实验记录", type: "experimentRecord", order: blocks.length, revision: 1, lifecycle: "active", review: "unreviewed", payload: { provider: "wandb", runs: [] }, representations: [], sourceRefs: [] };
          records = [block]; blocks.push(block);
        }
        const assigned = new Set();
        for (const block of records) {
          if (this.get("collections", block.id)) continue;
          const ids = new Set((block.payload.runs ?? []).map(entry => entry.runId));
          const runs = (node.runs ?? []).filter(run => ids.has(run.id));
          runs.forEach(run => assigned.add(run.id));
          block.recordCollection = { id: block.id, blockId: block.id, revision: node.experimentRevision ?? 1, runs, materialLinks: (node.materialLinks ?? []).filter(link => ids.has(link.runId)) };
        }
        if (records[0]?.recordCollection) {
          const unattached = (node.runs ?? []).filter(run => !assigned.has(run.id));
          records[0].recordCollection.runs.push(...unattached);
          records[0].recordCollection.materialLinks.push(...(node.materialLinks ?? []).filter(link => unattached.some(run => run.id === link.runId)));
        }
        for (const block of records) { this.put("blocks", block.id, block); this.put("versions", block.id + ":" + block.revision, block); }
        delete node.runs; delete node.materialLinks; delete node.experimentRevision;
        this.put("nodes", node.id, node);
      }
    });
  }
  hydrate(type, body) { const value = readStored(type, body); if (type === "blocks" && value.type === "experimentRecord") value.recordCollection = this.get("collections", value.id); return value; }
  get(type, id) { const row = this.db.prepare(`SELECT body FROM ${tables[type]} WHERE project_id=? AND id=?`).get(this.projectId, id); return row ? this.hydrate(type, row.body) : null; }
  all(type) { return this.db.prepare(`SELECT body FROM ${tables[type]} WHERE project_id=? ORDER BY id`).all(this.projectId).map(row => this.hydrate(type, row.body)); }
  blocksForOwner(owner) { return this.db.prepare("SELECT body FROM research_content_blocks WHERE project_id=? AND json_extract(body,'$.owner.kind')=? AND json_extract(body,'$.owner.id')=? ORDER BY id").all(this.projectId,owner.kind,owner.id).map(row=>this.hydrate("blocks",row.body)); }
  forSession(type, sessionId, limit = 10000) {
    const field = type === "candidates" ? "$.provenance.sessionId" : type === "receipts" ? "$.researchSessionId" : null;
    if (!field) throw new Error("Unsupported session query");
    return this.db.prepare(`SELECT body FROM ${tables[type]} WHERE project_id=? AND json_extract(body,'${field}')=? ORDER BY json_extract(body,'$.createdAt'),id LIMIT ?`).all(this.projectId, sessionId, limit).map(row => readStored(type, row.body));
  }
  otherPendingCount(sessionId) { return this.db.prepare("SELECT count(*) AS count FROM research_candidates WHERE project_id=? AND COALESCE(json_extract(body,'$.provenance.sessionId'),'')!=? AND json_extract(body,'$.status') IN ('pending','deferred')").get(this.projectId, sessionId).count; }
  put(type, id, value) { if (type === "blocks" && value.recordCollection) { this.put("collections", id, value.recordCollection); const { recordCollection: _collection, ...block } = value; this.write(type, id, block); } else this.write(type, id, value); return value; }
  write(type, id, value) { this.db.prepare(`INSERT INTO ${tables[type]}(project_id,id,body) VALUES(?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET body=excluded.body`).run(this.projectId, id, JSON.stringify(value)); }
  remove(type, id) { this.db.prepare(`DELETE FROM ${tables[type]} WHERE project_id=? AND id=?`).run(this.projectId, id); }
  transaction(fn) { return sqliteTransaction(this.db, fn); }
}
