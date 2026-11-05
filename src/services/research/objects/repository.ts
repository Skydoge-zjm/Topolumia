import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { sqliteTransaction } from "../../../lib/sqlite-transaction.js";
const tables = { nodes: "research_nodes", groups: "research_groups", blocks: "research_content_blocks", versions: "research_content_block_versions", assets: "research_assets", candidates: "research_candidates", receipts: "research_read_receipts", jobs: "research_asset_jobs", uploads: "research_asset_uploads", settings: "research_interface_settings" };
export class ResearchRepository {
  constructor(db, projectId) {
    this.db = db ?? new DatabaseSync(":memory:"); this.projectId = projectId;
    for (const table of Object.values(tables)) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table}(project_id TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,id))`);
    this.db.exec("CREATE INDEX IF NOT EXISTS research_candidates_session ON research_candidates(project_id,json_extract(body,'$.provenance.sessionId')); CREATE INDEX IF NOT EXISTS research_receipts_session ON research_read_receipts(project_id,json_extract(body,'$.researchSessionId'));");
    if (!this.get("settings", "cursor")) this.put("settings", "cursor", { secret: randomBytes(32).toString("hex") });
  }
  get(type, id) { const row = this.db.prepare(`SELECT body FROM ${tables[type]} WHERE project_id=? AND id=?`).get(this.projectId, id); return row ? JSON.parse(row.body) : null; }
  all(type) { return this.db.prepare(`SELECT body FROM ${tables[type]} WHERE project_id=? ORDER BY id`).all(this.projectId).map(row => JSON.parse(row.body)); }
  forSession(type, sessionId, limit = 10000) {
    const field = type === "candidates" ? "$.provenance.sessionId" : type === "receipts" ? "$.researchSessionId" : null;
    if (!field) throw new Error("Unsupported session query");
    return this.db.prepare(`SELECT body FROM ${tables[type]} WHERE project_id=? AND json_extract(body,'${field}')=? ORDER BY json_extract(body,'$.createdAt'),id LIMIT ?`).all(this.projectId, sessionId, limit).map(row => JSON.parse(row.body));
  }
  otherPendingCount(sessionId) { return this.db.prepare("SELECT count(*) AS count FROM research_candidates WHERE project_id=? AND COALESCE(json_extract(body,'$.provenance.sessionId'),'')!=? AND json_extract(body,'$.status') IN ('pending','deferred')").get(this.projectId, sessionId).count; }
  put(type, id, value) { this.db.prepare(`INSERT INTO ${tables[type]}(project_id,id,body) VALUES(?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET body=excluded.body`).run(this.projectId, id, JSON.stringify(value)); return value; }
  remove(type, id) { this.db.prepare(`DELETE FROM ${tables[type]} WHERE project_id=? AND id=?`).run(this.projectId, id); }
  transaction(fn) { return sqliteTransaction(this.db, fn); }
}
