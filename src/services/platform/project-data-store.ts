import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { AppError } from "../../lib/errors.js";
import { sqliteTransaction } from "../../lib/sqlite-transaction.js";
import type { ResearchStateView } from "../research/research-state.js";

export const projectDataPaths = (root: string) => {
  const directory = path.join(root, ".topolumia");
  return {
    directory,
    manifest: path.join(directory, "project.json"),
    database: path.join(directory, "research.sqlite"),
    settings: path.join(directory, "settings.json"),
    history: path.join(directory, "agent-sessions", "history.sqlite"),
    assets: path.join(directory, "research-assets"),
  };
};

/** Scientific transactions are local to one portable project, independent of account storage. */
export class ProjectDataStore {
  db: DatabaseSync;
  closed = false;
  constructor(
    public filePath: string,
    public projectId: string,
    { create = false } = {},
  ) {
    this.db = new DatabaseSync(filePath, { open: false });
    try {
      if (!create) {
        const check = new DatabaseSync(filePath, { readOnly: true });
        try {
          const identity = check
            .prepare("SELECT id FROM project_identity")
            .get();
          if (identity?.id !== projectId)
            throw new Error("Project identity differs");
        } finally {
          check.close();
        }
      }
      this.db.open();
      if (
        create &&
        this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_identity'",
          )
          .get()
      ) {
        const identities = this.db
          .prepare("SELECT id FROM project_identity")
          .all();
        if (identities.length !== 1 || identities[0].id !== projectId)
          throw new Error("Project identity differs");
      }
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
      );
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS project_identity(id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS project_snapshots(project_id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0,state_json TEXT NOT NULL,state_hash TEXT,updated_at TEXT NOT NULL);`);
      this.db
        .prepare("INSERT OR IGNORE INTO project_identity(id) VALUES(?)")
        .run(projectId);
    } catch (cause) {
      try {
        this.db.close();
      } catch {
        /* Initialization may fail before opening. */
      }
      throw new AppError(
        "PROJECT_DATA_UNAVAILABLE",
        "项目科研数据库不可用，请确认目录包含完整的 .topolumia 项目数据。",
        { status: 409, cause },
      );
    }
  }
  loadState(): ResearchStateView | null {
    const row = this.db
      .prepare("SELECT state_json FROM project_snapshots WHERE project_id=?")
      .get(this.projectId);
    return row ? JSON.parse(String(row.state_json)) : null;
  }
  saveState(view: ResearchStateView) {
    const payload = JSON.stringify(view);
    this.db
      .prepare(
        `INSERT INTO project_snapshots(project_id,version,state_json,state_hash,updated_at) VALUES(?,1,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET version=version+1,state_json=excluded.state_json,state_hash=excluded.state_hash,updated_at=excluded.updated_at`,
      )
      .run(
        this.projectId,
        payload,
        createHash("sha256").update(payload).digest("hex"),
        new Date().toISOString(),
      );
  }
  revokeCollectors() {
    sqliteTransaction(this.db, () => {
      if (
        this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_grants'",
          )
          .get()
      )
        this.db
          .prepare(
            "UPDATE record_grants SET body=json_set(body,'$.revoked',json('true')) WHERE project=?",
          )
          .run(this.projectId);
      if (
        this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_record_sources'",
          )
          .get()
      )
        this.db
          .prepare(
            "UPDATE project_record_sources SET body=json_set(body,'$.enabled',json('false')) WHERE project=?",
          )
          .run(this.projectId);
    });
  }
  close() {
    if (this.closed) return;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
    this.closed = true;
  }
}
