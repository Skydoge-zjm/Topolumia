import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { sqliteTransaction } from "../../../lib/sqlite-transaction.js";
import { storedResearchNodeKind } from "../../../domain/research/node-kinds.js";
const tables = { nodes: "research_nodes", groups: "research_groups", blocks: "research_content_blocks", versions: "research_content_block_versions", assets: "research_assets", candidates: "research_candidates", receipts: "research_read_receipts", jobs: "research_asset_jobs", uploads: "research_asset_uploads", settings: "research_interface_settings" };
function readStored(type, body) {
  const value = JSON.parse(body);
  if (type === "nodes") value.kind = storedResearchNodeKind(value.kind) ?? value.kind;
  if (type === "nodes" && value.kind === "experiment") { value.runs ??= []; value.materialLinks ??= []; value.experimentRevision ??= 1; }
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
  }
  get(type, id) { const row = this.db.prepare(`SELECT body FROM ${tables[type]} WHERE project_id=? AND id=?`).get(this.projectId, id); return row ? readStored(type, row.body) : null; }
  all(type) { return this.db.prepare(`SELECT body FROM ${tables[type]} WHERE project_id=? ORDER BY id`).all(this.projectId).map(row => readStored(type, row.body)); }
  blocksForOwner(owner) { return this.db.prepare("SELECT body FROM research_content_blocks WHERE project_id=? AND json_extract(body,'$.owner.kind')=? AND json_extract(body,'$.owner.id')=? ORDER BY id").all(this.projectId,owner.kind,owner.id).map(row=>readStored("blocks",row.body)); }
  forSession(type, sessionId, limit = 10000) {
    const field = type === "candidates" ? "$.provenance.sessionId" : type === "receipts" ? "$.researchSessionId" : null;
    if (!field) throw new Error("Unsupported session query");
    return this.db.prepare(`SELECT body FROM ${tables[type]} WHERE project_id=? AND json_extract(body,'${field}')=? ORDER BY json_extract(body,'$.createdAt'),id LIMIT ?`).all(this.projectId, sessionId, limit).map(row => readStored(type, row.body));
  }
  otherPendingCount(sessionId) { return this.db.prepare("SELECT count(*) AS count FROM research_candidates WHERE project_id=? AND COALESCE(json_extract(body,'$.provenance.sessionId'),'')!=? AND json_extract(body,'$.status') IN ('pending','deferred')").get(this.projectId, sessionId).count; }
  put(type, id, value) { this.db.prepare(`INSERT INTO ${tables[type]}(project_id,id,body) VALUES(?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET body=excluded.body`).run(this.projectId, id, JSON.stringify(value)); return value; }
  remove(type, id) { this.db.prepare(`DELETE FROM ${tables[type]} WHERE project_id=? AND id=?`).run(this.projectId, id); }
  transaction(fn) { return sqliteTransaction(this.db, fn); }
}
