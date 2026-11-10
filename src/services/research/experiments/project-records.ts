import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ResearchCommandService } from "../research-command-service.js";
import type { ResearchActor, StoredBlock, ResearchOperation, PayloadMap } from "../../../domain/research/types.js";
import type { RecordProvider, ProjectRecordSource, LiveRecordRun, ProjectRunBinding, RecordSnapshot, RecordStorageTarget } from "../../../domain/research/record-types.js";
import { fail } from "../../../domain/research/access.js";

/** Project sources own accumulated data; blocks hold versioned selections only. */
export class ProjectRecordCatalog {
  constructor(public c: ResearchCommandService) {
    c.store.db.exec(`CREATE TABLE IF NOT EXISTS project_record_sources(project TEXT,id TEXT,owner TEXT,host TEXT,provider TEXT,body TEXT,PRIMARY KEY(project,id));
      CREATE INDEX IF NOT EXISTS project_record_source_host ON project_record_sources(project,owner,host,provider);
      CREATE INDEX IF NOT EXISTS research_blocks_record_type ON research_content_blocks(project_id,json_extract(body,'$.type'),json_extract(body,'$.lifecycle'));
      CREATE INDEX IF NOT EXISTS record_events_run_scope ON record_events(project,block,run,watermark);`);
    if (!c.store.get("settings", "project-run-attachments-v1")) c.store.transaction(() => {
      c.ingestion.sql("INSERT OR IGNORE INTO record_run_attachment_refs SELECT e.project,e.block,e.run,json_extract(a.value,'$.sha256'),min(e.watermark) FROM record_events e JOIN project_record_sources s ON s.project=e.project AND s.id=e.block,json_each(json_extract(e.body,'$.data.attachments')) a WHERE e.project=? GROUP BY e.project,e.block,e.run,json_extract(a.value,'$.sha256')").run(c.projectId);
      c.store.put("settings", "project-run-attachments-v1", { ready: true });
    });
  }
  get(id: string): ProjectRecordSource | null {
    const row = this.c.ingestion.sql("SELECT body FROM project_record_sources WHERE project=? AND id=?").get(this.c.projectId, id);
    return row ? JSON.parse(row.body) : null;
  }
  all(): ProjectRecordSource[] {
    return this.c.ingestion.sql("SELECT body FROM project_record_sources WHERE project=? ORDER BY rowid").all(this.c.projectId).map(row => JSON.parse(row.body));
  }
  save(value: ProjectRecordSource): ProjectRecordSource {
    this.c.ingestion.sql("INSERT INTO project_record_sources VALUES(?,?,?,?,?,?) ON CONFLICT(project,id) DO UPDATE SET body=excluded.body").run(this.c.projectId, value.id, value.userId, value.hostId, value.provider, JSON.stringify(value));
    return value;
  }
  assign(input: { runs: { sourceId: string; runId: string }[]; nodeId?: string; nodeName?: string; title?: string; expectedCollectionRevision?: number }, actor: ResearchActor) {
    this.c.check(actor, "research.applyChange");
    if (actor.isAgent || actor.collectorGrant) fail("FORBIDDEN", "Agent 请通过候选提议运行归属。", 403);
    if (!Array.isArray(input.runs) || !input.runs.length || input.runs.length > 200 || new Set(input.runs.map(run => JSON.stringify(run))).size !== input.runs.length) fail("INPUT_INVALID", "请选择 1–200 条不同的记录。", 422);
    const runs = input.runs.map(binding => {
      const source = this.get(binding.sourceId), run = source && this.run(source.id, binding.runId);
      if (!run) fail("PROJECT_RECORD_NOT_FOUND", "所选训练记录不存在。", 404);
      return { sourceId: source.id + "/" + run.id, label: run.label, status: run.status, assetIds: [], projectSource: { sourceId: source.id, runId: run.id }, provider: source.provider };
    });
    if (new Set(runs.map(run => run.provider)).size !== 1) fail("EXPERIMENT_RECORD_INVALID", "一个记录块请选择同一工具的运行。", 422);
    const operations: ResearchOperation[] = [], owner = { kind: "node" as const, id: input.nodeId ?? "@experiment" };
    if (!input.nodeId) operations.push({ op: "addNode", clientRef: "experiment", kind: "experiment", core: { nodeName: input.nodeName ?? "实验", tags: [] } });
    operations.push({ op: "addBlock", clientRef: "records", owner, title: input.title ?? "训练记录", type: "experimentRecord", representations: [], sourceRefs: [], ...(input.nodeId ? { expectedCollectionRevision: input.expectedCollectionRevision } : {}), payload: { provider: runs[0].provider, runs: runs.map(({ provider: _provider, ...run }) => run) } });
    const result = this.c.changes.direct(operations, actor, "将训练记录归入实验");
    return { nodeId: input.nodeId ?? result.allocation["node:experiment"], blockId: result.allocation["block:records"] };
  }
  configure(input: { provider: RecordProvider; directory: string; hostId: string; hostLabel: string }, actor: ResearchActor) {
    this.c.check(actor, "project.manageSettings");
    if (actor.isAgent || actor.collectorGrant) fail("FORBIDDEN", "采集部署需要项目管理者操作。", 403);
    if (!["wandb", "tensorboard"].includes(input.provider) || typeof input.directory !== "string" || input.directory.length > 4096 || [...input.directory].some(char => char.charCodeAt(0) < 32) || !(path.posix.isAbsolute(input.directory) || path.win32.isAbsolute(input.directory))) fail("COLLECTION_CONFIG_INVALID", "请选择工具和有效的项目记录目录。", 422);
    if (!actor.user) fail("AUTH_REQUIRED", "请先登录。", 401);
    const old = this.all().find(source => source.userId === actor.user.id && source.hostId === input.hostId && source.provider === input.provider && source.directory === input.directory);
    return this.save({ ...old, id: old?.id ?? "record-source:" + randomUUID(), userId: actor.user.id, hostId: input.hostId, hostLabel: input.hostLabel, provider: input.provider, directory: input.directory, enabled: true, updatedAt: new Date().toISOString(), createdAt: old?.createdAt ?? new Date().toISOString() });
  }
  run(sourceId: string, runId: string, watermark = this.c.ingestion.watermark(sourceId)): LiveRecordRun | null {
    const row = this.c.ingestion.sql("SELECT body FROM record_live_runs WHERE project=? AND block=? AND id=? AND first_watermark<=?").get(this.c.projectId, sourceId, runId, watermark);
    return row ? JSON.parse(row.body) : null;
  }
  validateEntry(entry: PayloadMap["experimentRecord"]["runs"][number], provider: RecordProvider): LiveRecordRun {
    const source = entry.projectSource && this.get(entry.projectSource.sourceId);
    const run = source && this.run(source.id, entry.projectSource!.runId);
    if (!source || source.provider !== provider || !run || entry.sourceId !== source.id + "/" + run.id) fail("PROJECT_RECORD_NOT_FOUND", "所选训练记录不属于当前项目或工具。", 422);
    return run;
  }
  validateRules(rules: PayloadMap["experimentRecord"]["followSources"], provider: RecordProvider) {
    for (const rule of rules ?? []) {
      const source = this.get(rule.sourceId), directory = rule.directory.replaceAll("\\", "/");
      if (!source || source.provider !== provider || directory.startsWith("/") || directory.includes(":") || directory.split("/").some(part => !part || part === "." || part === "..") || ["wandb", "runs", "logs", "lightning_logs"].includes(directory)) fail("RECORD_RULE_INVALID", "请选择专属于这个实验的子目录，不能使用公共记录根目录。", 422);
      rule.directory = directory;
    }
  }
  bindings(block: Pick<RecordStorageTarget, "id" | "payload"> | Pick<StoredBlock, "id" | "payload">, snapshot?: Pick<RecordSnapshot, "watermark" | "sourceBindings"> | null): ProjectRunBinding[] {
    if (snapshot?.sourceBindings) return snapshot.sourceBindings;
    const selected = new Map<string, ProjectRunBinding>();
    for (const entry of block.payload?.runs ?? []) if (entry.projectSource) selected.set(JSON.stringify(entry.projectSource), { ...entry.projectSource, watermark: this.c.ingestion.watermark(entry.projectSource.sourceId) });
    for (const rule of block.payload?.followSources ?? []) {
      for (const run of this.c.ingestion.runs(rule.sourceId)) {
        const directory = run.directory?.replaceAll("\\", "/");
        if (directory && (directory === rule.directory || directory.startsWith(rule.directory + "/"))) {
          const binding = { sourceId: rule.sourceId, runId: run.id };
          selected.set(JSON.stringify(binding), { ...binding, watermark: this.c.ingestion.watermark(rule.sourceId) });
        }
      }
    }
    return [...selected.values()];
  }
  runs(block: Pick<RecordStorageTarget, "id" | "payload"> | Pick<StoredBlock, "id" | "payload">, snapshot?: Pick<RecordSnapshot, "watermark" | "sourceBindings"> | null): LiveRecordRun[] {
    return this.bindings(block, snapshot).flatMap(binding => { const run = this.run(binding.sourceId, binding.runId, binding.watermark); return run ? [{ ...run, blockId: block.id, projectSource: { sourceId: binding.sourceId, runId: run.id }, hostLabel: this.get(binding.sourceId)?.hostLabel }] : []; });
  }
  version(block: RecordStorageTarget) {
    const own = this.c.ingestion.sql("SELECT watermark,updated_at FROM record_states WHERE project=? AND block=?").get(this.c.projectId, block.id);
    let watermark = own?.watermark ?? 0, updatedAt = own?.updated_at ?? null;
    for (const run of this.runs(block)) { watermark += run.lastWatermark ?? run.firstWatermark ?? 0; if (run.updatedAt && (!updatedAt || run.updatedAt > updatedAt)) updatedAt = run.updatedAt; }
    return { durableWatermark: watermark, indexedWatermark: watermark, updatedAt };
  }
  scopes(block: Pick<RecordStorageTarget, "id" | "payload"> | Pick<StoredBlock, "id" | "payload">, snapshot?: Pick<RecordSnapshot, "watermark" | "sourceBindings"> | null) {
    return [{ sourceId: block.id, runId: null, watermark: snapshot?.watermark ?? this.c.ingestion.watermark(block.id) }, ...this.bindings(block, snapshot)];
  }
  eventRows(block: RecordStorageTarget, { after = 0, limit = 100, runId, kind, snapshot }: { after?: number; limit?: number; runId?: string; kind?: string; snapshot?: RecordSnapshot | null } = {}) {
    const scopes = JSON.stringify(this.scopes(block, snapshot));
    const clause = `e.project=? AND EXISTS(SELECT 1 FROM json_each(?) s WHERE e.block=json_extract(s.value,'$.sourceId') AND (json_extract(s.value,'$.runId') IS NULL OR e.run=json_extract(s.value,'$.runId')) AND e.watermark<=json_extract(s.value,'$.watermark')) AND (? IS NULL OR e.run=?) AND (? IS NULL OR e.kind=?)`;
    const rows = this.c.ingestion.sql(`SELECT e.rowid AS cursor,e.watermark,e.run,e.block,length(e.body) AS chars,CASE WHEN length(e.body)<=8192 THEN e.body ELSE NULL END AS body,substr(e.body,1,1500) AS preview,json_extract(e.body,'$.kind') AS kind,json_extract(e.body,'$.key') AS key FROM record_events e WHERE ${clause} AND e.rowid>? ORDER BY e.rowid LIMIT ?`).all(this.c.projectId, scopes, runId ?? null, runId ?? null, kind ?? null, kind ?? null, after, limit + 1);
    const watermark = this.c.ingestion.sql(`SELECT coalesce(max(e.rowid),0) AS watermark FROM record_events e WHERE ${clause}`).get(this.c.projectId, scopes, runId ?? null, runId ?? null, kind ?? null, kind ?? null)!.watermark;
    return { rows: rows.slice(0, limit), watermark, nextAfter: rows.length > limit ? rows[limit - 1].cursor : null };
  }
  eventText(block: RecordStorageTarget, cursor: number, offset: number, length: number, snapshot?: RecordSnapshot | null) {
    const row = this.c.ingestion.sql(`SELECT substr(e.body,?,?) AS text,length(e.body) AS total FROM record_events e WHERE e.project=? AND e.rowid=? AND EXISTS(SELECT 1 FROM json_each(?) s WHERE e.block=json_extract(s.value,'$.sourceId') AND (json_extract(s.value,'$.runId') IS NULL OR e.run=json_extract(s.value,'$.runId')) AND e.watermark<=json_extract(s.value,'$.watermark'))`).get(offset + 1, length, this.c.projectId, cursor, JSON.stringify(this.scopes(block, snapshot)));
    if (!row) fail("RECORD_EVENT_NOT_FOUND", "记录不在所选运行范围内。", 404);
    return { blockId: block.id, eventWatermark: cursor, text: row.text, totalChars: row.total, offset, nextOffset: offset + row.text.length < row.total ? offset + row.text.length : null, snapshotId: snapshot?.id };
  }
  attachmentHashes(block: RecordStorageTarget, snapshot?: RecordSnapshot | null) {
    const hashes = new Set<string>();
    for (const scope of this.scopes(block, snapshot)) {
      const rows = scope.runId ? this.c.ingestion.sql("SELECT hash FROM record_run_attachment_refs WHERE project=? AND block=? AND run=? AND first_watermark<=?").all(this.c.projectId, scope.sourceId, scope.runId, scope.watermark) : this.c.ingestion.sql("SELECT hash FROM record_attachment_refs WHERE project=? AND block=? AND first_watermark<=?").all(this.c.projectId, scope.sourceId, scope.watermark);
      for (const row of rows) hashes.add(row.hash);
    }
    return [...hashes];
  }
  attachment(block: RecordStorageTarget, hash: string, snapshot?: RecordSnapshot | null) {
    for (const scope of this.scopes(block, snapshot)) {
      if (scope.runId && !this.c.ingestion.sql("SELECT 1 FROM record_run_attachment_refs WHERE project=? AND block=? AND run=? AND hash=? AND first_watermark<=?").get(this.c.projectId, scope.sourceId, scope.runId, hash, scope.watermark)) continue;
      const blob = this.c.ingestion.sql("SELECT size FROM record_blobs WHERE project=? AND block=? AND hash=?").get(this.c.projectId, scope.sourceId, hash);
      if (blob) return { path: this.c.ingestion.blobPath(scope.sourceId, hash), size: blob.size };
    }
    fail("ATTACHMENT_NOT_FOUND", "附件不在已选运行范围内或尚未接收。", 404);
  }
  directory(actor: ResearchActor, { offset = 0, limit = 50, q = "", provider = "", hostId = "", unassigned = false }: { offset?: number; limit?: number; q?: string; provider?: string; hostId?: string; unassigned?: boolean } = {}) {
    this.c.check(actor, "research.view");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100 || q.length > 240) fail("INPUT_INVALID", "记录分页参数无效。", 422);
    const common = `WITH selected AS (
      SELECT json_extract(e.value,'$.projectSource.sourceId') AS source,json_extract(e.value,'$.projectSource.runId') AS run
      FROM research_content_blocks b,json_each(b.body,'$.payload.runs') e
      WHERE b.project_id=? AND json_extract(b.body,'$.type')='experimentRecord' AND json_extract(b.body,'$.lifecycle')!='archived'
    ), rules AS (
      SELECT json_extract(e.value,'$.sourceId') AS source,json_extract(e.value,'$.directory') AS directory
      FROM research_content_blocks b,json_each(b.body,'$.payload.followSources') e
      WHERE b.project_id=? AND json_extract(b.body,'$.type')='experimentRecord' AND json_extract(b.body,'$.lifecycle')!='archived'
    ), matches AS (
      SELECT s.id AS source_id,s.host,s.provider,s.body AS source_body,r.id AS run_id,r.body AS run_body,
      (EXISTS(SELECT 1 FROM selected t WHERE t.source=s.id AND t.run=r.id) OR EXISTS(SELECT 1 FROM rules t WHERE t.source=s.id AND (json_extract(r.body,'$.directory')=t.directory OR substr(json_extract(r.body,'$.directory'),1,length(t.directory)+1)=t.directory||'/'))) AS assigned
      FROM record_live_runs r JOIN project_record_sources s ON s.project=r.project AND s.id=r.block
      WHERE r.project=? AND (?='' OR s.provider=?) AND (?='' OR s.host=?)
      AND (?='' OR instr(lower(coalesce(json_extract(r.body,'$.label'),'')||' '||coalesce(json_extract(r.body,'$.directory'),'')||' '||coalesce(json_extract(s.body,'$.hostLabel'),'')),lower(?))>0)
    ) `;
    const args = [this.c.projectId,this.c.projectId,this.c.projectId,provider,provider,hostId,hostId,q,q];
    const filter = unassigned ? " WHERE assigned=0" : "";
    const total = this.c.ingestion.sql(common + "SELECT count(*) AS count FROM matches" + filter).get(...args)!.count;
    const rows = this.c.ingestion.sql(common + "SELECT * FROM matches" + filter + " ORDER BY json_extract(run_body,'$.updatedAt') DESC,source_id,run_id LIMIT ? OFFSET ?").all(...args,limit,offset);
    const items = rows.map(row => { const source=JSON.parse(row.source_body) as ProjectRecordSource,run=JSON.parse(row.run_body) as LiveRecordRun; return { sourceId: source.id+"/"+run.id,label:run.label,status:run.status,assetIds:[],projectSource:{sourceId:source.id,runId:run.id},provider:source.provider,hostId:source.hostId,hostLabel:source.hostLabel,directory:run.directory??source.directory,updatedAt:run.updatedAt,assigned:Boolean(row.assigned) }; });
    return { items, total, nextOffset: offset + limit < total ? offset + limit : null, sources: this.all().map(source => ({ id: source.id, provider: source.provider, hostId: source.hostId, hostLabel: source.hostLabel, directory: source.directory, enabled: source.enabled })) };
  }
}
