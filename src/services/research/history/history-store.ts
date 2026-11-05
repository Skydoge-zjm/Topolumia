import { randomUUID } from "node:crypto";
import { AppError } from "../../../lib/errors.js";
import { historyKinds, historyCategories, historyOutcomes } from "../../../domain/research/research-history.js";

export class ResearchHistoryStore {
  constructor(db, projectId) {
    Object.assign(this, { db, projectId });
    db.exec(`CREATE TABLE IF NOT EXISTS research_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,project_id TEXT NOT NULL,
      event_key TEXT NOT NULL,kind TEXT NOT NULL,category TEXT NOT NULL,outcome TEXT NOT NULL,occurred_at TEXT NOT NULL,
      actor_type TEXT NOT NULL,initiator_type TEXT,proposal_id TEXT,subject_ids TEXT NOT NULL,subject_types TEXT NOT NULL,
      search_text TEXT NOT NULL,brief TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(project_id,event_key));
      CREATE INDEX IF NOT EXISTS research_history_project_sequence ON research_history(project_id,sequence);
      CREATE INDEX IF NOT EXISTS research_history_proposal ON research_history(project_id,proposal_id);`);
  }
  append(event, eventKey = randomUUID()) {
    if (!historyKinds[event.kind]) throw new Error(`Unknown research history kind: ${event.kind}`);
    const payload = { schemaVersion: "research-history-event.v1", ...event, id: randomUUID(), occurredAt: new Date().toISOString() };
    payload.category = historyKinds[event.kind].category;
    payload.changeCount = event.changes.length;
    const brief = { ...payload, changes: event.changes.map(({ action, subject }) => ({ action, subject: { ...subject,
      summary: typeof subject?.summary === "string" ? subject.summary.slice(0, 220) : subject?.summary ? Object.fromEntries(Object.entries(subject.summary).map(([locale, value]) => [locale, String(value).slice(0, 220)])) : "" } })) };
    delete brief.beforeStateVersion; delete brief.afterStateVersion;
    const result = this.db.prepare(`INSERT OR IGNORE INTO research_history(id,project_id,event_key,kind,category,outcome,occurred_at,actor_type,initiator_type,proposal_id,subject_ids,subject_types,search_text,brief,payload)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(payload.id, this.projectId, eventKey, payload.kind, payload.category, payload.outcome, payload.occurredAt,
      payload.actor.type, payload.initiatedBy?.type ?? null, payload.proposal?.id ?? null,
      JSON.stringify(event.changes.map(change => change.subject?.id).filter(Boolean)), JSON.stringify([...new Set(event.changes.map(change => change.subject?.type))]),
      JSON.stringify(brief).toLocaleLowerCase(), JSON.stringify(brief), JSON.stringify(payload));
    if (!result.changes) return this.db.prepare("SELECT id FROM research_history WHERE project_id=? AND event_key=?").get(this.projectId, eventKey).id;
    return payload.id;
  }
  list({ query = "", category = "", actor = "", outcome = "", objectId = "", proposalId = "", offset = 0, limit = 40 } = {}) {
    if (typeof query !== "string" || query.length > 300 || category && !historyCategories[category] || actor && !["human", "agent", "system"].includes(actor) || outcome && !historyOutcomes[outcome] ||
      typeof objectId !== "string" || objectId.length > 240 || typeof proposalId !== "string" || proposalId.length > 240 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError("RESEARCH_HISTORY_QUERY_INVALID", "科研历程筛选条件无效。", { status: 422 });
    const conditions = ["project_id=?"], args = [this.projectId];
    if (query) { conditions.push("instr(search_text,?)>0"); args.push(query.toLocaleLowerCase()); }
    if (category) {
      const objectType = { nodes: "node", relations: "relation", groups: "group", records: "record", series: "series" }[category];
      conditions.push(objectType ? "(category=? OR EXISTS(SELECT 1 FROM json_each(research_history.subject_types) WHERE value=?))" : "category=?");
      args.push(category); if (objectType) args.push(objectType);
    }
    if (actor) { conditions.push("(actor_type=? OR initiator_type=?)"); args.push(actor, actor); }
    if (outcome) { conditions.push("outcome=?"); args.push(outcome); }
    if (objectId) { conditions.push("EXISTS(SELECT 1 FROM json_each(research_history.subject_ids) WHERE value=?)"); args.push(objectId); }
    if (proposalId) { conditions.push("proposal_id=?"); args.push(proposalId); }
    const where = conditions.join(" AND ");
    const total = this.db.prepare(`SELECT count(*) AS count FROM research_history WHERE ${where}`).get(...args).count;
    const rows = this.db.prepare(`SELECT brief FROM research_history WHERE ${where} ORDER BY sequence DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return { schemaVersion: "research-history.v1", items: rows.map(row => JSON.parse(row.brief)), total, nextOffset: offset + limit < total ? offset + limit : null };
  }
  get(id) {
    const row = this.db.prepare("SELECT payload FROM research_history WHERE project_id=? AND id=?").get(this.projectId, id);
    if (!row) throw new AppError("RESEARCH_HISTORY_NOT_FOUND", "此科研事件不存在。", { status: 404 });
    const event = JSON.parse(row.payload);
    return { ...event, related: event.proposal ? this.list({ proposalId: event.proposal.id, limit: 100 }).items : [] };
  }
}
