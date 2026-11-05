import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors.js";
import { sqliteTransaction } from "../../lib/sqlite-transaction.js";
export class NotebookStore {
  constructor(db, projectId, onChange = null) {
    Object.assign(this, { db, projectId });
    this.onChange = onChange;
    db.exec(`CREATE TABLE IF NOT EXISTS research_documents(project_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(project_id,kind,id));
      CREATE TABLE IF NOT EXISTS research_document_versions(project_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(project_id,kind,id,revision));`);
  }
  list(kind) { return this.db.prepare("SELECT payload FROM research_documents WHERE project_id=? AND kind=? ORDER BY rowid DESC").all(this.projectId, kind).map(row => JSON.parse(row.payload)); }
  get(kind, id) {
    const row = this.db.prepare("SELECT payload FROM research_documents WHERE project_id=? AND kind=? AND id=?").get(this.projectId, kind, id);
    if (!row) throw new AppError("RESEARCH_OBJECT_NOT_FOUND", "研究对象不存在。", { status: 404 });
    return JSON.parse(row.payload);
  }
  save(kind, input, actor, { id = randomUUID(), expectedRevision = null, context = {} } = {}) {
    const now = new Date().toISOString();
    const previous = expectedRevision === null ? null : this.get(kind, id);
    if (previous && previous.revision !== expectedRevision) throw new AppError("RESEARCH_REVISION_CONFLICT", "内容已被修改，请重新载入后编辑。", { status: 409 });
    const doc = { ...input, id, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now,
      updatedAt: now, author: previous?.author ?? { id: actor.user.id, name: actor.user.displayName ?? actor.user.username }, updatedBy: actor.user.id };
    return sqliteTransaction(this.db, () => {
      if (previous) {
        const changed = this.db.prepare("UPDATE research_documents SET revision=?,payload=? WHERE project_id=? AND kind=? AND id=? AND revision=?").run(doc.revision, JSON.stringify(doc), this.projectId, kind, id, expectedRevision);
        if (!changed.changes) throw new AppError("RESEARCH_REVISION_CONFLICT", "内容版本冲突。", { status: 409 });
      } else this.db.prepare("INSERT INTO research_documents(project_id,kind,id,revision,payload) VALUES(?,?,?,?,?)").run(this.projectId, kind, id, doc.revision, JSON.stringify(doc));
      this.db.prepare("INSERT INTO research_document_versions(project_id,kind,id,revision,payload) VALUES(?,?,?,?,?)").run(this.projectId, kind, id, doc.revision, JSON.stringify(doc));
      this.onChange?.({ kind, before: previous, after: doc, actor, context });
      return doc;
    });
  }
  versions(kind, id) { this.get(kind, id); return this.db.prepare("SELECT payload FROM research_document_versions WHERE project_id=? AND kind=? AND id=? ORDER BY revision DESC").all(this.projectId, kind, id).map(row => JSON.parse(row.payload)); }
  version(kind, id, revision) {
    this.get(kind, id);
    const row = this.db.prepare("SELECT payload FROM research_document_versions WHERE project_id=? AND kind=? AND id=? AND revision=?").get(this.projectId, kind, id, revision);
    if (!row) throw new AppError("RESEARCH_REVISION_NOT_FOUND", "记录修订不存在。", { status: 404 });
    return JSON.parse(row.payload);
  }
  remove(kind, id, expectedRevision, actor = null) {
    const before = this.get(kind, id);
    return sqliteTransaction(this.db, () => {
      const result = this.db.prepare("DELETE FROM research_documents WHERE project_id=? AND kind=? AND id=? AND revision=?").run(this.projectId, kind, id, expectedRevision);
      if (!result.changes) throw new AppError("RESEARCH_REVISION_CONFLICT", "内容版本冲突。", { status: 409 });
      this.onChange?.({ kind, before, after: null, actor });
      return { deleted: true, id };
    });
  }
}
