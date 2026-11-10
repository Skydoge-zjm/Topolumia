import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors.js";
import { sqliteTransaction } from "../../lib/sqlite-transaction.js";
import type { DatabaseSync } from "node:sqlite";
import type { NotebookDocuments, NotebookMetadata, ResearchActor } from "../../domain/research/types.js";
import { principal } from "../../domain/research/access.js";
export type NotebookKind = keyof NotebookDocuments;
export type NotebookChange = {kind:NotebookKind;before:NotebookDocuments[NotebookKind]|null;after:NotebookDocuments[NotebookKind]|null;actor:ResearchActor|null;context?:{reason?:string;causedBy?:string|null}};
export type NotebookSaveOptions = {id?:string;expectedRevision?:number|null;context?:NotebookChange["context"]};
export class NotebookStore {
  constructor(public db:DatabaseSync, public projectId:string, public onChange:((change:NotebookChange)=>void)|null = null) {
    db.exec(`CREATE TABLE IF NOT EXISTS research_documents(project_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(project_id,kind,id));
      CREATE TABLE IF NOT EXISTS research_document_versions(project_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(project_id,kind,id,revision));`);
  }
  list<K extends NotebookKind>(kind:K):NotebookDocuments[K][] { return this.db.prepare("SELECT payload FROM research_documents WHERE project_id=? AND kind=? ORDER BY rowid DESC").all(this.projectId, kind).map(row => JSON.parse(String(row.payload)) as NotebookDocuments[K]); }
  get<K extends NotebookKind>(kind:K, id:string):NotebookDocuments[K] {
    const row = this.db.prepare("SELECT payload FROM research_documents WHERE project_id=? AND kind=? AND id=?").get(this.projectId, kind, id);
    if (!row) throw new AppError("RESEARCH_OBJECT_NOT_FOUND", "研究对象不存在。", { status: 404 });
    return JSON.parse(String(row.payload)) as NotebookDocuments[K];
  }
  save<K extends NotebookKind>(kind:K, input:Omit<NotebookDocuments[K],keyof NotebookMetadata>, actor:ResearchActor, { id = randomUUID(), expectedRevision = null, context = {} }:NotebookSaveOptions = {}):NotebookDocuments[K] {
    const now = new Date().toISOString();
    const previous = expectedRevision === null ? null : this.get(kind, id);
    if (previous && previous.revision !== expectedRevision) throw new AppError("RESEARCH_REVISION_CONFLICT", "内容已被修改，请重新载入后编辑。", { status: 409 });
    const user=actor.user??{id:principal(actor),displayName:actor.name};
    const doc = { ...input, id, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now,
      updatedAt: now, author: previous?.author ?? { id: user.id, name: user.displayName ?? user.username }, updatedBy: user.id } as NotebookDocuments[K];
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
  versions<K extends NotebookKind>(kind:K, id:string):NotebookDocuments[K][] { this.get(kind, id); return this.db.prepare("SELECT payload FROM research_document_versions WHERE project_id=? AND kind=? AND id=? ORDER BY revision DESC").all(this.projectId, kind, id).map(row => JSON.parse(String(row.payload)) as NotebookDocuments[K]); }
  version<K extends NotebookKind>(kind:K, id:string, revision:number):NotebookDocuments[K] {
    this.get(kind, id);
    const row = this.db.prepare("SELECT payload FROM research_document_versions WHERE project_id=? AND kind=? AND id=? AND revision=?").get(this.projectId, kind, id, revision);
    if (!row) throw new AppError("RESEARCH_REVISION_NOT_FOUND", "记录修订不存在。", { status: 404 });
    return JSON.parse(String(row.payload)) as NotebookDocuments[K];
  }
  remove(kind:NotebookKind, id:string, expectedRevision:number, actor:ResearchActor|null = null) {
    const before = this.get(kind, id);
    return sqliteTransaction(this.db, () => {
      const result = this.db.prepare("DELETE FROM research_documents WHERE project_id=? AND kind=? AND id=? AND revision=?").run(this.projectId, kind, id, expectedRevision);
      if (!result.changes) throw new AppError("RESEARCH_REVISION_CONFLICT", "内容版本冲突。", { status: 409 });
      this.onChange?.({ kind, before, after: null, actor });
      return { deleted: true, id };
    });
  }
}
