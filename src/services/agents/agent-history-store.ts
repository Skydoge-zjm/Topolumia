import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqliteTransaction } from "../../lib/sqlite-transaction.js";
import { sessionCheckpoint } from "./session-checkpoint.js";

const clone = (value) =>
  value === undefined ? undefined : structuredClone(value);
const collections = ["turns", "events", "conversationEvents"];
export class AgentHistoryStore {
  readonly filePath: string;
  maxEventsPerSession: number;
  private records = new Map<string, ReturnType<typeof sessionCheckpoint>>();
  private references = new Map<
    string,
    Map<string, { value: unknown; position: number }>
  >();
  private saved = new Map<string, Map<string, string>>();
  private db: DatabaseSync | null = null;
  readonly metrics = { rowsWritten: 0, bytesWritten: 0 };
  constructor(filePath, { maxEventsPerSession = 1000 } = {}) {
    this.filePath = filePath;
    this.maxEventsPerSession = maxEventsPerSession;
  }
  database() {
    if (this.db) return this.db;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const db = new DatabaseSync(this.filePath);
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_objects(session_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,position INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(session_id,kind,id));`);
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  async load() {
    const db = this.database();
    this.records.clear();
    this.saved.clear();
    for (const row of db.prepare("SELECT id,body FROM sessions").all()) {
      const record = JSON.parse(String(row.body)),
        signatures = new Map<string, string>();
      signatures.set("metadata", String(row.body));
      const refs = new Map();
      const snapshots = db
        .prepare(
          "SELECT kind,id,position,body FROM session_objects WHERE session_id=? ORDER BY position",
        )
        .all(row.id);
      for (const item of snapshots) {
        const key = `${item.kind}:${item.id}`;
        signatures.set(key, String(item.body));
        refs.set(key, { value: undefined, position: Number(item.position) });
      }
      this.records.set(record.id, record);
      this.saved.set(record.id, signatures);
      this.references.set(record.id, refs);
    }
    return this.list();
  }
  private materialize(id: string) {
    const metadata = this.records.get(id);
    if (!metadata) return null;
    const record = clone(metadata);
    for (const kind of collections) record[kind] = [];
    for (const [key, json] of this.saved.get(id) ?? []) {
      if (key === "metadata") continue;
      const kind = key.slice(0, key.indexOf(":")),
        value = JSON.parse(json);
      if (kind === "nativeSnapshot") record.nativeSnapshot = value;
      else record[kind].push(value);
    }
    return record;
  }
  list() {
    return [...this.records.values()]
      .sort((a, b) =>
        String(b.updatedAt ?? b.createdAt).localeCompare(
          String(a.updatedAt ?? a.createdAt),
        ),
      )
      .map((record) => this.materialize(record.id));
  }
  ids() {
    return [...this.records.keys()];
  }
  get(id: string) {
    return this.materialize(id);
  }
  updateLimits({
    maxEventsPerSession = this.maxEventsPerSession,
  } = {}) {
    this.maxEventsPerSession = Math.max(1, Number(maxEventsPerSession) || 1);
  }
  async upsert(session) {
    const db = this.database(),
      record = sessionCheckpoint(session);
    record.traceDroppedEvents += Math.max(
      0,
      record.events.length - this.maxEventsPerSession,
    );
    record.events = record.events.slice(-this.maxEventsPerSession);
    const previous = this.saved.get(record.id) ?? new Map(),
      next = new Map();
    const metadata = { ...record };
    for (const field of [...collections, "nativeSnapshot"])
      delete metadata[field];
    const body = JSON.stringify(metadata);
    next.set("metadata", body);
    const refs = this.references.get(record.id) ?? new Map(),
      nextRefs = new Map();
    const cursor = this.records.get(record.id)?.lastCursor ?? 0;
    const touchedTurns = new Set(
      record.conversationEvents
        .filter((event) => (event.updatedCursor ?? event.cursor) > cursor)
        .map((event) => event.turnId),
    );
    touchedTurns.add(record.turns.at(-1)?.id);
    const write = db.prepare(
      "INSERT INTO session_objects(session_id,kind,id,position,body) VALUES(?,?,?,?,?) ON CONFLICT(session_id,kind,id) DO UPDATE SET position=excluded.position,body=excluded.body",
    );
    sqliteTransaction(db, () => {
      if (previous.get("metadata") !== body) {
        db.prepare(
          "INSERT INTO sessions(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
        ).run(record.id, body);
        this.metrics.rowsWritten++;
        this.metrics.bytesWritten += Buffer.byteLength(body);
      }
      for (const kind of [...collections, "nativeSnapshot"]) {
        const values =
          kind === "nativeSnapshot"
            ? record.nativeSnapshot
              ? [record.nativeSnapshot]
              : []
            : record[kind];
        values.forEach((value, position) => {
          const id = String(value.id ?? position),
            key = `${kind}:${id}`;
          const unchanged =
            refs.get(key)?.value === value &&
            !(kind === "turns" && touchedTurns.has(id));
          const json = unchanged ? previous.get(key) : JSON.stringify(value);
          next.set(key, json);
          nextRefs.set(key, { value, position });
          if (
            previous.get(key) !== json ||
            refs.get(key)?.position !== position
          ) {
            write.run(record.id, kind, id, position, json);
            this.metrics.rowsWritten++;
            this.metrics.bytesWritten += Buffer.byteLength(json);
          }
        });
      }
      for (const key of previous.keys())
        if (key !== "metadata" && !next.has(key)) {
          const colon = key.indexOf(":");
          db.prepare(
            "DELETE FROM session_objects WHERE session_id=? AND kind=? AND id=?",
          ).run(record.id, key.slice(0, colon), key.slice(colon + 1));
        }
    });
    this.records.set(record.id, metadata);
    this.saved.set(record.id, next);
    this.references.set(record.id, nextRefs);
    return record;
  }
  async remove(id) {
    const db = this.database();
    sqliteTransaction(db, () => {
      db.prepare("DELETE FROM session_objects WHERE session_id=?").run(id);
      db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    });
    this.records.delete(id);
    this.saved.delete(id);
    this.references.delete(id);
  }
  close() {
    this.db?.close();
    this.db = null;
  }
}
