import type { AgentRuntimeSession, StoredAgentSession, AgentTurn, AgentEvent } from "../../domain/agents/agent-types.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqliteTransaction } from "../../lib/sqlite-transaction.js";
import { sessionCheckpoint } from "./session-checkpoint.js";

const clone = <T>(value: T): T =>
  structuredClone(value);
const collections = ["turns", "events", "conversationEvents"] as const;
type SessionRecord = ReturnType<typeof sessionCheckpoint>;
type SessionMetadata = Omit<SessionRecord, typeof collections[number] | "nativeSnapshot">;
export class AgentHistoryStore {
  readonly filePath: string;
  maxEventsPerSession: number;
  private records = new Map<string, SessionMetadata>();
  private references = new Map<
    string,
    Map<string, { value: unknown; position: number }>
  >();
  private saved = new Map<string, Map<string, string>>();
  private db: DatabaseSync | null = null;
  readonly metrics = { rowsWritten: 0, bytesWritten: 0 };
  constructor(filePath: string, { maxEventsPerSession = 1000 } = {}) {
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
      const record = JSON.parse(String(row.body)) as SessionMetadata,
        signatures = new Map<string, string>();
      signatures.set("metadata", String(row.body));
      const refs = new Map<string, { value: unknown; position: number }>();
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
    const record: Omit<SessionRecord, "nativeSnapshot"> & { nativeSnapshot?: unknown } = { ...clone(metadata), turns: [], events: [], conversationEvents: [] };
    for (const [key, json] of this.saved.get(id) ?? []) {
      if (key === "metadata") continue;
      const kind = key.slice(0, key.indexOf(":")),
        value: unknown = JSON.parse(json);
      if (kind === "nativeSnapshot") record.nativeSnapshot = value;
      else if (kind === "turns") record.turns.push(value as AgentTurn);
      else if (kind === "events" || kind === "conversationEvents") record[kind].push(value as AgentEvent);
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
      .map((record) => this.materialize(record.id)!);
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
  async upsert(session: AgentRuntimeSession | StoredAgentSession) {
    const db = this.database(),
      record = sessionCheckpoint(session);
    record.traceDroppedEvents += Math.max(
      0,
      record.events.length - this.maxEventsPerSession,
    );
    record.events = record.events.slice(-this.maxEventsPerSession);
    const previous = this.saved.get(record.id) ?? new Map<string, string>(),
      next = new Map<string, string>();
    const metadata: SessionMetadata & Partial<Pick<SessionRecord, typeof collections[number] | "nativeSnapshot">> = { ...record };
    for (const field of [...collections, "nativeSnapshot"] as const) delete metadata[field];
    const body = JSON.stringify(metadata);
    next.set("metadata", body);
    const refs = this.references.get(record.id) ?? new Map<string, { value: unknown; position: number }>(),
      nextRefs = new Map<string, { value: unknown; position: number }>();
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
      for (const kind of [...collections, "nativeSnapshot"] as const) {
        const values =
          kind === "nativeSnapshot"
            ? record.nativeSnapshot
              ? [record.nativeSnapshot]
              : []
            : record[kind];
        values.forEach((value, position) => {
          const id = String(value && typeof value === "object" && "id" in value ? value.id ?? position : position),
            key = `${kind}:${id}`;
          const unchanged =
            refs.get(key)?.value === value &&
            !(kind === "turns" && touchedTurns.has(id));
          const json = (unchanged ? previous.get(key) : JSON.stringify(value)) ?? "null";
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
  async remove(id: string) {
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
