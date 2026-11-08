import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { fail } from "../../../domain/research/access.js";
import {
  recordBatchSchema,
  recordNumber,
  recordIngestionCapabilities,
} from "../../../domain/research/record-ingestion.js";
import { versionHash, sha256 } from "../../../lib/hash.js";

/** SQLite's FULL transaction is the durable ledger and query index in one commit.
 * No second append log / database commit window, and no node revisions per batch.
 */
export class RecordIngestionService {
  c;
  db;
  statements = new Map<string, any>();
  constructor(c) {
    this.c = c;
    this.db = c.store.db;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS record_events(project TEXT,block TEXT,identity TEXT,digest TEXT,watermark INTEGER,run TEXT,kind TEXT,body TEXT,PRIMARY KEY(project,block,identity));
      CREATE UNIQUE INDEX IF NOT EXISTS record_events_watermark ON record_events(project,block,watermark);
      CREATE TABLE IF NOT EXISTS record_points(project TEXT,block TEXT,run TEXT,metric TEXT,axis TEXT,ordinal INTEGER,watermark INTEGER,x REAL,y REAL,body TEXT,PRIMARY KEY(project,block,run,metric,axis,ordinal));
      CREATE INDEX IF NOT EXISTS record_points_watermark ON record_points(project,block,run,metric,axis,watermark);
      CREATE TABLE IF NOT EXISTS record_metrics(project TEXT,block TEXT,run TEXT,metric TEXT,axis TEXT,count INTEGER,first_watermark INTEGER,PRIMARY KEY(project,block,run,metric,axis));
      CREATE TABLE IF NOT EXISTS record_sample_chunks(project TEXT,block TEXT,run TEXT,metric TEXT,axis TEXT,chunk INTEGER,end_ordinal INTEGER,watermark INTEGER,body TEXT,PRIMARY KEY(project,block,run,metric,axis,chunk));
      CREATE TABLE IF NOT EXISTS record_live_runs(project TEXT,block TEXT,id TEXT,source_key TEXT,body TEXT,first_watermark INTEGER,PRIMARY KEY(project,block,id),UNIQUE(project,block,source_key));
      CREATE TABLE IF NOT EXISTS record_states(project TEXT,block TEXT,watermark INTEGER,updated_at TEXT,PRIMARY KEY(project,block));
      CREATE TABLE IF NOT EXISTS record_streams(project TEXT,block TEXT,id TEXT,body TEXT,PRIMARY KEY(project,block,id));
      CREATE TABLE IF NOT EXISTS record_grants(project TEXT,id TEXT,digest TEXT UNIQUE,body TEXT,PRIMARY KEY(project,id));
      CREATE TABLE IF NOT EXISTS record_snapshots(project TEXT,block TEXT,id TEXT,body TEXT,PRIMARY KEY(project,id));
      CREATE TABLE IF NOT EXISTS record_blobs(project TEXT,block TEXT,hash TEXT,size INTEGER,PRIMARY KEY(project,block,hash));
      CREATE TABLE IF NOT EXISTS record_attachment_refs(project TEXT,block TEXT,hash TEXT,first_watermark INTEGER,PRIMARY KEY(project,block,hash));
      CREATE TABLE IF NOT EXISTS record_run_attachment_refs(project TEXT,block TEXT,run TEXT,hash TEXT,first_watermark INTEGER,PRIMARY KEY(project,block,run,hash));`);
  }
  sql(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  args(blockId) {
    return [this.c.projectId, blockId];
  }
  block(blockId, actor, write = false) {
    const source = this.c.projectRecords?.get(blockId);
    this.c.check(actor, write ? source ? "project.manageSettings" : "research.applyChange" : "research.view");
    const block = source ? { id: source.id, type: "experimentRecord", owner: { kind: "project", id: this.c.projectId }, payload: { provider: source.provider, runs: [] }, lifecycle: "active" } : this.c.store.get("blocks", blockId);
    if (
      !block ||
      block.type !== "experimentRecord" ||
      (write && block.lifecycle === "archived") ||
      (!source && block.owner.kind !== "node")
    )
      fail("CONTENT_BLOCK_NOT_FOUND", "实验记录块不可用。", 404);
    const node = source ? null : write
      ? this.c.objects.get(block.owner)
      : this.c.store.get("nodes", block.owner.id);
    if (!source && node?.kind !== "experiment")
      fail("NODE_NOT_EXPERIMENT", "记录块需要属于实验节点。", 422);
    if (actor.collectorGrant) {
      if (actor.refreshCollectorAuthority)
        this.c.check(actor.refreshCollectorAuthority(), source ? "project.manageSettings" : "research.applyChange");
      const row = this.sql(
        "SELECT body FROM record_grants WHERE project=? AND id=?",
      ).get(this.c.projectId, actor.collectorGrant.id);
      const grant = row && JSON.parse(row.body);
      if (!grant || grant.revoked || Date.parse(grant.expiresAt) <= Date.now())
        fail("COLLECTOR_CREDENTIAL_INVALID", "采集凭据已过期或撤销。", 401);
      if (source && !source.enabled) fail("COLLECTION_PAUSED", "该来源已暂停采集。", 403);
    }
    if (actor.collectorGrant && actor.collectorGrant.blockId !== blockId)
      fail("INGESTION_SCOPE_MISMATCH", "采集凭据仅可写入绑定记录块。", 403);
    return block;
  }
  grant(
    blockId,
    actor,
    ttl = 30 * 86400,
    metadata: { label?: string; provider?: string; sourcePath?: string } = {},
  ) {
    this.block(blockId, actor, true);
    if (actor.isAgent || actor.collectorGrant)
      fail("FORBIDDEN", "采集授权需要研究者操作。", 403);
    const token = "topolumia_rec_" + randomBytes(32).toString("base64url"),
      id = randomUUID();
    const grant = {
      id,
      blockId,
      projectId: this.c.projectId,
      userId: actor.user.id,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      revoked: false,
      ...metadata,
    };
    this.sql("INSERT INTO record_grants VALUES(?,?,?,?)").run(
      this.c.projectId,
      id,
      sha256(token),
      JSON.stringify(grant),
    );
    return { ...grant, token, capabilities: recordIngestionCapabilities };
  }
  authenticate(token, resolveUser) {
    const row = this.sql(
      "SELECT body FROM record_grants WHERE project=? AND digest=?",
    ).get(this.c.projectId, sha256(token));
    const grant = row && JSON.parse(row.body);
    if (!grant || grant.revoked || Date.parse(grant.expiresAt) <= Date.now())
      fail("COLLECTOR_CREDENTIAL_INVALID", "采集凭据已过期或撤销。", 401);
    const actor = resolveUser(grant.userId, this.c.projectId);
    if (!actor) fail("FORBIDDEN", "采集授权的用户已不可用。", 403);
    this.block(grant.blockId, actor, true);
    return {
      ...actor,
      collectorGrant: grant,
      refreshCollectorAuthority: () =>
        resolveUser(grant.userId, this.c.projectId),
    };
  }
  changeGrant(blockId, id, action, actor) {
    this.block(blockId, actor, true);
    if (actor.isAgent || actor.collectorGrant)
      fail("FORBIDDEN", "采集授权需要研究者操作。", 403);
    const row = this.sql(
        "SELECT body FROM record_grants WHERE project=? AND id=?",
      ).get(this.c.projectId, id),
      value = row && JSON.parse(row.body);
    if (!value || value.blockId !== blockId)
      fail("GRANT_NOT_FOUND", "采集连接不存在。", 404);
    if (action === "revoke") value.revoked = true;
    else {
      if (value.revoked)
        fail("GRANT_REVOKED", "已撤销凭据不可恢复，请创建新连接。", 409);
      value.expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    }
    this.sql("UPDATE record_grants SET body=? WHERE project=? AND id=?").run(
      JSON.stringify(value),
      this.c.projectId,
      id,
    );
    return value;
  }
  watermark(blockId) {
    return (
      this.sql(
        "SELECT watermark FROM record_states WHERE project=? AND block=?",
      ).get(...this.args(blockId))?.watermark ?? 0
    );
  }
  runId(blockId, provider, streamId, sourceRunId) {
    return (
      "run:" +
      sha256(JSON.stringify([blockId, provider, streamId, sourceRunId])).slice(
        0,
        32,
      )
    );
  }
  receive(blockId, input, actor) {
    this.block(blockId, actor, true);
    const parsed = recordBatchSchema.safeParse(input);
    if (!parsed.success)
      fail(
        "INGESTION_INVALID",
        "接收批次不符合 v1 合同。",
        422,
        parsed.error.issues.slice(0, 6),
      );
    const batch = parsed.data;
    const source = this.c.projectRecords.get(blockId);
    if (source && source.provider !== batch.provider) fail("INGESTION_SOURCE_CONFLICT", "记录工具与采集来源不一致。", 422);
    if (
      Buffer.byteLength(JSON.stringify(batch)) >
      recordIngestionCapabilities.maxBatchBytes
    )
      fail("BODY_TOO_LARGE", "接收批次过大。", 413);
    const unique = new Set(batch.events.map((event) => event.seq));
    if (unique.size !== batch.events.length)
      fail("INGESTION_SEQUENCE_DUPLICATE", "批次包含重复序号。", 422);
    return this.c.store.transaction(() => {
      let watermark = this.watermark(blockId),
        accepted = 0,
        duplicate = 0;
      const now = new Date().toISOString(),
        summaries = new Map<string, any>();
      const streamId = sha256(
        JSON.stringify([batch.streamId, batch.writerId, batch.generation]),
      );
      const previousRow = this.sql(
        "SELECT body FROM record_streams WHERE project=? AND block=? AND id=?",
      ).get(...this.args(blockId), streamId);
      const previous = previousRow ? JSON.parse(previousRow.body) : null;
      if (previous && previous.provider !== batch.provider)
        fail("INGESTION_SOURCE_CONFLICT", "同一写入流不能变更记录工具。", 409);
      let lastSequence = previous?.lastSequence ?? -1;
      for (const event of [...batch.events].sort((a, b) => a.seq - b.seq)) {
        const identity = sha256(
          JSON.stringify([
            batch.streamId,
            batch.writerId,
            batch.generation,
            event.seq,
          ]),
        );
        const digest = versionHash({ provider: batch.provider, event });
        const old = this.sql(
          "SELECT digest FROM record_events WHERE project=? AND block=? AND identity=?",
        ).get(...this.args(blockId), identity);
        if (old) {
          if (old.digest !== digest)
            fail(
              "INGESTION_IDENTITY_CONFLICT",
              "同一事件身份携带了不同内容。",
              409,
            );
          duplicate++;
          continue;
        }
        if (event.seq !== lastSequence + 1)
          fail(
            "INGESTION_SEQUENCE_GAP",
            "请先发送此前未确认的完整事件。",
            409,
            { expected: lastSequence + 1, received: event.seq },
          );
        lastSequence = event.seq;
        const id = this.runId(
          blockId,
          batch.provider,
          batch.streamId,
          event.sourceRunId,
        );
        watermark++;
        this.sql("INSERT INTO record_events VALUES(?,?,?,?,?,?,?,?)").run(
          ...this.args(blockId),
          identity,
          digest,
          watermark,
          id,
          event.kind,
          JSON.stringify({
            ...event,
            origin: {
              provider: batch.provider,
              streamId: batch.streamId,
              writerId: batch.writerId,
              generation: batch.generation,
              sourceInfo: batch.sourceInfo,
            },
          }),
        );
        this.projectEvent(blockId, batch, event, watermark, summaries);
        accepted++;
      }
      this.flushSummaries(summaries);
      if (accepted)
        this.sql(
          "INSERT INTO record_states VALUES(?,?,?,?) ON CONFLICT(project,block) DO UPDATE SET watermark=excluded.watermark,updated_at=excluded.updated_at",
        ).run(...this.args(blockId), watermark, now);
      const stream = {
        id: streamId,
        provider: batch.provider,
        streamId: batch.streamId,
        writerId: batch.writerId,
        generation: batch.generation,
        sourceInfo: batch.sourceInfo,
        lastSequence,
        updatedAt: now,
        grantId: actor.collectorGrant?.id,
      };
      this.sql(
        "INSERT INTO record_streams VALUES(?,?,?,?) ON CONFLICT(project,block,id) DO UPDATE SET body=excluded.body",
      ).run(...this.args(blockId), stream.id, JSON.stringify(stream));
      return {
        accepted,
        duplicate,
        durableWatermark: watermark,
        indexedWatermark: watermark,
        confirmedSequences: batch.events.map((event) => event.seq),
        attachmentsComplete: this.pendingAttachments(blockId) === 0,
      };
    });
  }
  projectEvent(
    blockId,
    batch,
    event,
    watermark,
    summaries = new Map<string, any>(),
  ) {
    const id = this.runId(
        blockId,
        batch.provider,
        batch.streamId,
        event.sourceRunId,
      ),
      sourceKey = JSON.stringify([
        batch.provider,
        batch.streamId,
        event.sourceRunId,
      ]);
    const stored = this.sql(
      "SELECT body FROM record_live_runs WHERE project=? AND block=? AND id=?",
    ).get(...this.args(blockId), id);
    const run = stored
      ? JSON.parse(stored.body)
      : {
          id,
          label: event.sourceRunId,
          status: "unknown",
          sources: [],
          blockId,
          firstWatermark: watermark,
        };
    if (
      !run.sources.some(
        (source) =>
          source.streamId === batch.streamId &&
          source.writerId === batch.writerId &&
          source.generation === batch.generation,
      )
    )
      run.sources.push({
        provider: batch.provider,
        sourceId: event.sourceRunId,
        streamId: batch.streamId,
        writerId: batch.writerId,
        generation: batch.generation,
      });
    if (event.kind === "run") {
      run.label = event.label;
      run.status = event.status;
    }
    const directory = String(batch.streamId).replaceAll("\\", "/").split("/").slice(0, batch.provider === "wandb" ? -1 : undefined).join("/") || ".";
    if (directory !== "." || !run.directory) run.directory = directory;
    run.lastWatermark = watermark;
    run.updatedAt = new Date().toISOString();
    if (
      event.kind === "lifecycle" &&
      [
        "queued",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "unknown",
      ].includes(String(event.data.status))
    )
      run.status = event.data.status;
    if (!stored || stored.body !== JSON.stringify(run))
      this.sql(
        "INSERT INTO record_live_runs VALUES(?,?,?,?,?,?) ON CONFLICT(project,block,id) DO UPDATE SET body=excluded.body",
      ).run(
        ...this.args(blockId),
        id,
        sourceKey,
        JSON.stringify(run),
        run.firstWatermark,
      );
    if (event.kind === "scalar") {
      const metricArgs = [...this.args(blockId), id, event.key, event.xKey];
      const count =
        this.sql(
          "SELECT count FROM record_metrics WHERE project=? AND block=? AND run=? AND metric=? AND axis=?",
        ).get(...metricArgs)?.count ?? 0;
      this.sql("INSERT INTO record_points VALUES(?,?,?,?,?,?,?,?,?,?)").run(
        ...metricArgs,
        count,
        watermark,
        recordNumber(event.x),
        recordNumber(event.value),
        JSON.stringify({
          x: event.x,
          y: event.value,
          ...(event.timestamp !== undefined
            ? { timestamp: event.timestamp }
            : {}),
        }),
      );
      this.sql(
        "INSERT INTO record_metrics VALUES(?,?,?,?,?,?,?) ON CONFLICT(project,block,run,metric,axis) DO UPDATE SET count=excluded.count",
      ).run(...metricArgs, count + 1, watermark);
      const chunk = Math.floor(count / 128);
      const summaryKey = JSON.stringify([...metricArgs, chunk]);
      let pending = summaries.get(summaryKey);
      const row = pending
        ? null
        : this.sql(
            "SELECT body FROM record_sample_chunks WHERE project=? AND block=? AND run=? AND metric=? AND axis=? AND chunk=?",
          ).get(...metricArgs, chunk);
      const point = {
        ordinal: count,
        x: event.x,
        y: event.value,
        ...(event.timestamp !== undefined
          ? { timestamp: event.timestamp }
          : {}),
      };
      const summary =
        pending?.summary ??
        (row
          ? JSON.parse(row.body)
          : { first: point, last: point, min: point, max: point });
      pending ??= { args: [...metricArgs, chunk], summary };
      pending.endOrdinal = count;
      pending.watermark = watermark;
      summaries.set(summaryKey, pending);
      summary.last = point;
      const y = recordNumber(event.value),
        low = recordNumber(summary.min.y),
        high = recordNumber(summary.max.y);
      if (y !== null && (low === null || y < low)) summary.min = point;
      if (y !== null && (high === null || y > high)) summary.max = point;
    }
    if ("data" in event && Array.isArray(event.data.attachments))
      for (const attachment of event.data.attachments) {
        const hash =
          typeof attachment === "object" && attachment && "sha256" in attachment
            ? attachment.sha256
            : null;
        if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
          fail("ATTACHMENT_INVALID", "附件必须有 SHA-256 标识。", 422);
        this.sql(
          "INSERT OR IGNORE INTO record_attachment_refs VALUES(?,?,?,?)",
        ).run(...this.args(blockId), hash, watermark);
        this.sql("INSERT OR IGNORE INTO record_run_attachment_refs VALUES(?,?,?,?,?)").run(...this.args(blockId), id, hash, watermark);
      }
  }
  flushSummaries(summaries) {
    for (const { args, endOrdinal, watermark, summary } of summaries.values())
      this.sql(
        "INSERT INTO record_sample_chunks VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project,block,run,metric,axis,chunk) DO UPDATE SET end_ordinal=excluded.end_ordinal,watermark=excluded.watermark,body=excluded.body",
      ).run(...args, endOrdinal, watermark, JSON.stringify(summary));
  }
  rebuild(blockId, actor) {
    this.block(blockId, actor);
    this.c.check(actor, "research.applyChange");
    return this.c.store.transaction(() => {
      for (const table of [
        "record_points",
        "record_sample_chunks",
        "record_metrics",
        "record_live_runs",
        "record_attachment_refs",
        "record_run_attachment_refs",
      ])
        this.sql(`DELETE FROM ${table} WHERE project=? AND block=?`).run(
          ...this.args(blockId),
        );
      let count = 0;
      const summaries = new Map<string, any>();
      for (const row of this.sql(
        "SELECT watermark,body FROM record_events WHERE project=? AND block=? ORDER BY watermark",
      ).iterate(...this.args(blockId))) {
        const { origin, ...event } = JSON.parse(row.body);
        if (!origin)
          fail("RECORD_ORIGIN_MISSING", "原始记录缺少重放来源。", 409);
        this.projectEvent(blockId, origin, event, row.watermark, summaries);
        if (summaries.size > 256) {
          this.flushSummaries(summaries);
          summaries.clear();
        }
        count++;
      }
      this.flushSummaries(summaries);
      return { replayed: count, watermark: this.watermark(blockId) };
    });
  }
  runs(blockId, watermark = this.watermark(blockId)) {
    // Snapshots retain this directory, independent of subsequent lifecycle updates.
    return this.sql(
      "SELECT id,body FROM record_live_runs WHERE project=? AND block=? AND first_watermark<=? ORDER BY first_watermark",
    )
      .all(...this.args(blockId), watermark)
      .map((row) => ({ ...JSON.parse(row.body), blockId }));
  }
  metrics(blockId, runId, watermark = this.watermark(blockId)) {
    return this.sql(
      "SELECT metric,axis,count FROM record_metrics WHERE project=? AND block=? AND run=? AND first_watermark<=? ORDER BY metric,axis",
    )
      .all(...this.args(blockId), runId, watermark)
      .map((row) => {
        const count =
          watermark === this.watermark(blockId)
            ? row.count
            : this.sql(
                "SELECT ordinal+1 AS count FROM record_points WHERE project=? AND block=? AND run=? AND metric=? AND axis=? AND watermark<=? ORDER BY watermark DESC LIMIT 1",
              ).get(
                ...this.args(blockId),
                runId,
                row.metric,
                row.axis,
                watermark,
              ).count;
        return {
          key: row.metric,
          xKey: row.axis,
          pointCount: count,
          segments: [{ live: true, blockId, runId, watermark }],
          sources: [
            {
              blockId,
              runId,
              watermark,
              provider: "collector",
              contentVersion: "record:" + watermark,
            },
          ],
        };
      });
  }
  points(blockId, runId, key, axis, selection, watermark) {
    const args = [...this.args(blockId), runId, key, axis],
      clause = "project=? AND block=? AND run=? AND metric=? AND axis=?";
    const count =
      watermark === this.watermark(blockId)
        ? (this.sql(
            "SELECT count FROM record_metrics WHERE project=? AND block=? AND run=? AND metric=? AND axis=?",
          ).get(...args)?.count ?? 0)
        : (this.sql(
            `SELECT ordinal+1 AS count FROM record_points WHERE ${clause} AND watermark<=? ORDER BY watermark DESC LIMIT 1`,
          ).get(...args, watermark)?.count ?? 0);
    if (selection.maxPoints && count > selection.maxPoints) {
      if (selection.maxPoints < 4)
        return {
          points: this.sql(
            `SELECT body FROM record_points WHERE ${clause} AND ordinal IN (0,?) ORDER BY ordinal`,
          )
            .all(...args, count - 1)
            .map((row) => JSON.parse(row.body)),
          pointCount: count,
        };
      const buckets = Math.max(1, Math.floor(selection.maxPoints / 4));
      const grouped = new Map<number, any>();
      const append = (point) => {
        const bucket = Math.floor((point.ordinal * buckets) / count);
        const summary = grouped.get(bucket) ?? {
          first: point,
          last: point,
          min: point,
          max: point,
        };
        if (point.ordinal < summary.first.ordinal) summary.first = point;
        if (point.ordinal > summary.last.ordinal) summary.last = point;
        const y = recordNumber(point.y),
          low = recordNumber(summary.min.y),
          high = recordNumber(summary.max.y);
        if (y !== null && (low === null || y < low)) summary.min = point;
        if (y !== null && (high === null || y > high)) summary.max = point;
        grouped.set(bucket, summary);
      };
      // Query O(history/128) tiny incremental summaries; only a snapshot's partial
      // final chunk requires reading original points. Exact pages stay indexed.
      const lastChunk = Math.floor((count - 1) / 128);
      for (const row of this.sql(
        "SELECT chunk,end_ordinal,body FROM record_sample_chunks WHERE project=? AND block=? AND run=? AND metric=? AND axis=? AND chunk<=? ORDER BY chunk",
      ).iterate(...args, lastChunk)) {
        if (row.end_ordinal >= count) {
          for (const raw of this.sql(
            `SELECT ordinal,body FROM record_points WHERE ${clause} AND ordinal>=? AND ordinal<? AND watermark<=? ORDER BY ordinal`,
          ).iterate(...args, row.chunk * 128, count, watermark))
            append({ ordinal: raw.ordinal, ...JSON.parse(raw.body) });
        } else {
          const summary = JSON.parse(row.body);
          for (const point of [
            summary.first,
            summary.min,
            summary.max,
            summary.last,
          ])
            append(point);
        }
      }
      const chosen = new Map<number, any>();
      for (const summary of grouped.values())
        for (const point of [
          summary.first,
          summary.min,
          summary.max,
          summary.last,
        ])
          chosen.set(point.ordinal, point);
      return {
        points: [...chosen.values()]
          .sort((a, b) => a.ordinal - b.ordinal)
          .map(({ ordinal: _ordinal, ...point }) => point),
        pointCount: count,
      };
    }
    const offset = selection.offset ?? 0,
      limit = selection.limit ?? Math.min(2000, count);
    return {
      points: this.sql(
        `SELECT body FROM record_points WHERE ${clause} AND ordinal>=? AND ordinal<? AND watermark<=? ORDER BY ordinal`,
      )
        .all(...args, offset, offset + limit, watermark)
        .map((row) => JSON.parse(row.body)),
      pointCount: count,
    };
  }
  pendingAttachments(blockId) {
    return this.sql(
      "SELECT count(*) AS count FROM record_attachment_refs r WHERE project=? AND block=? AND NOT EXISTS(SELECT 1 FROM record_blobs b WHERE b.project=r.project AND b.block=r.block AND b.hash=r.hash)",
    ).get(...this.args(blockId)).count;
  }
  version(blockId, actor) {
    const block = this.block(blockId, actor);
    if (this.c.projectRecords.bindings(block).length) return { blockId, ...this.c.projectRecords.version(block) };
    const state = this.sql(
      "SELECT watermark,updated_at FROM record_states WHERE project=? AND block=?",
    ).get(...this.args(blockId));
    return {
      blockId,
      durableWatermark: state?.watermark ?? 0,
      indexedWatermark: state?.watermark ?? 0,
      updatedAt: state?.updated_at ?? null,
    };
  }
  status(blockId, actor) {
    const block = this.block(blockId, actor);
    const state = this.sql(
      "SELECT watermark,updated_at FROM record_states WHERE project=? AND block=?",
    ).get(...this.args(blockId));
    return {
      blockId,
      durableWatermark: state?.watermark ?? 0,
      indexedWatermark: state?.watermark ?? 0,
      updatedAt: state?.updated_at ?? null,
      pendingAttachments: this.pendingAttachments(blockId),
      runCount: this.c.records.collectionRunCount(block),
      streams: this.sql(
        "SELECT body FROM record_streams WHERE project=? AND block=? LIMIT 1000",
      )
        .all(...this.args(blockId))
        .map((row) => JSON.parse(row.body)),
      grants: this.sql(
        "SELECT body FROM record_grants WHERE project=? AND json_extract(body,'$.blockId')=? ORDER BY rowid DESC LIMIT 100",
      )
        .all(...this.args(blockId))
        .map((row) => JSON.parse(row.body)),
      snapshots: this.sql(
        "SELECT json_extract(body,'$.id') AS id,json_extract(body,'$.watermark') AS watermark,json_extract(body,'$.createdAt') AS createdAt FROM record_snapshots WHERE project=? AND block=? ORDER BY rowid DESC LIMIT 50",
      )
        .all(...this.args(blockId))
        .map((row) => {
          return {
            id: row.id,
            watermark: row.watermark,
            createdAt: row.createdAt,
          };
        }),
      capabilities: recordIngestionCapabilities,
    };
  }
  snapshot(blockId, actor) {
    const block = this.block(blockId, actor),
      watermark = this.watermark(blockId);
    const value = {
      id: "snapshot:" + randomUUID(),
      projectId: this.c.projectId,
      blockId,
      nodeId: block.owner.id,
      node: this.c.store.get("nodes", block.owner.id),
      block,
      watermark,
      blockRevision: block.revision,
      recordCollection: block.recordCollection,
      runs: this.runs(blockId, watermark),
      sourceBindings: this.c.projectRecords.bindings(block),
      staticPayload: block.payload,
      normalizationVersion: "record.v1",
      createdAt: new Date().toISOString(),
      attachments: this.sql(
        "SELECT hash FROM record_attachment_refs WHERE project=? AND block=? AND first_watermark<=? ORDER BY hash",
      )
        .all(...this.args(blockId), watermark)
        .map((row) => row.hash),
    };
    value.runs.push(...this.c.projectRecords.runs(block, value));
    value.attachments = this.c.projectRecords.attachmentHashes(block, value);
    this.sql("INSERT INTO record_snapshots VALUES(?,?,?,?)").run(
      ...this.args(blockId),
      value.id,
      JSON.stringify(value),
    );
    return value;
  }
  getSnapshot(id, actor) {
    const row = this.sql(
      "SELECT body FROM record_snapshots WHERE project=? AND id=?",
    ).get(this.c.projectId, id);
    if (!row) fail("SNAPSHOT_NOT_FOUND", "分析快照不存在。", 404);
    const snapshot = JSON.parse(row.body);
    this.c.check(actor, "research.view");
    const current = this.c.store.get("blocks", snapshot.blockId);
    if (
      !current ||
      current.owner.kind !== "node" ||
      current.owner.id !== snapshot.nodeId
    )
      fail("INGESTION_SCOPE_MISMATCH", "快照归属不可用。", 403);
    return snapshot;
  }
  eventText(
    blockId,
    watermark,
    actor,
    offset = 0,
    length = 4000,
    snapshotId = undefined,
  ) {
    const snapshot = snapshotId ? this.getSnapshot(snapshotId, actor) : null;
    if (!snapshot) this.block(blockId, actor);
    if (
      snapshot &&
      (snapshot.blockId !== blockId || (!snapshot.sourceBindings?.length && watermark > snapshot.watermark))
    )
      fail("INGESTION_SCOPE_MISMATCH", "事件不在快照范围内。", 403);
    if (
      !Number.isSafeInteger(watermark) ||
      watermark < 1 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > 12000
    )
      fail("INPUT_INVALID", "请选择合法的事件文本范围。", 422);
    const selectedBlock = snapshot?.block ?? this.block(blockId, actor);
    if (this.c.projectRecords.bindings(selectedBlock, snapshot).length) return this.c.projectRecords.eventText(selectedBlock, watermark, offset, length, snapshot);
    const row = this.sql(
      "SELECT substr(body,?,?) AS text,length(body) AS total FROM record_events WHERE project=? AND block=? AND watermark=?",
    ).get(offset + 1, length, ...this.args(blockId), watermark);
    if (!row) fail("RECORD_EVENT_NOT_FOUND", "记录不存在。", 404);
    return {
      blockId,
      eventWatermark: watermark,
      text: row.text,
      totalChars: row.total,
      offset,
      nextOffset:
        offset + row.text.length < row.total ? offset + row.text.length : null,
      snapshotId,
    };
  }
  events(
    blockId,
    actor,
    {
      after = 0,
      limit = 100,
      snapshotId = undefined,
      runId = undefined,
      kind = undefined,
    }: any = {},
  ) {
    if (!snapshotId) this.block(blockId, actor);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      fail("INPUT_INVALID", "请选择合法事件范围。", 422);
    const snapshot = snapshotId ? this.getSnapshot(snapshotId, actor) : null;
    if (snapshot && snapshot.blockId !== blockId)
      fail("INGESTION_SCOPE_MISMATCH", "快照不属于记录块。", 403);
    const watermark = snapshot?.watermark ?? this.watermark(blockId);
    const selectedBlock = snapshot?.block ?? this.block(blockId, actor);
    if (this.c.projectRecords.bindings(selectedBlock, snapshot).length) {
      const result = this.c.projectRecords.eventRows(selectedBlock, { after, limit, runId, kind, snapshot });
      return { items: result.rows.map(row => ({ watermark: row.cursor, runId: row.run, event: row.body ? JSON.parse(row.body) : { kind: row.kind, key: row.key, data: { preview: row.preview, truncated: true } }, totalChars: row.chars, readHint: { tool: "read_experiment", mode: "events", nodeId: selectedBlock.owner.id, blockId, snapshotId, eventWatermark: row.cursor } })), watermark: result.watermark, nextAfter: result.nextAfter, snapshotId };
    }
    const rows = this.sql(
      "SELECT watermark,run,CASE WHEN length(body)<=8192 THEN body ELSE NULL END AS body,substr(body,1,1500) AS preview,length(body) AS chars,json_extract(body,'$.kind') AS kind,json_extract(body,'$.key') AS key,json_extract(body,'$.sourceRunId') AS sourceRunId FROM record_events WHERE project=? AND block=? AND watermark>? AND watermark<=? AND (? IS NULL OR run=?) AND (? IS NULL OR kind=?) ORDER BY watermark LIMIT ?",
    ).all(
      ...this.args(blockId),
      after,
      watermark,
      runId ?? null,
      runId ?? null,
      kind ?? null,
      kind ?? null,
      limit,
    );
    return {
      items: rows.map((row) => {
        const event = row.body
          ? JSON.parse(row.body)
          : {
              kind: row.kind,
              key: row.key,
              sourceRunId: row.sourceRunId,
              data: { preview: row.preview, truncated: true },
            };
        return {
          watermark: row.watermark,
          runId: row.run,
          event,
          totalChars: row.chars,
          readHint: {
            tool: "read_experiment",
            mode: "events",
            nodeId:
              snapshot?.nodeId ?? this.c.store.get("blocks", blockId).owner.id,
            blockId,
            snapshotId,
            eventWatermark: row.watermark,
          },
          attachments: (event.data?.attachments ?? []).map((attachment) => ({
            ...attachment,
            downloadHint: {
              tool: "transfer_asset",
              direction: "download",
              variant: "original",
              target: {
                kind: "recordAttachment",
                blockId,
                sha256: attachment.sha256,
              },
            },
          })),
        };
      }),
      watermark,
      nextAfter: rows.length === limit ? rows.at(-1).watermark : null,
      snapshotId,
    };
  }
  blobPath(blockId, hash) {
    if (!/^[a-f0-9]{64}$/.test(hash))
      fail("ATTACHMENT_INVALID", "无效的附件标识。", 422);
    return path.join(this.c.assets.root, "record-blobs", sha256(blockId), hash);
  }
  async uploadAttachment(blockId, hash, stream, actor) {
    this.block(blockId, actor, true);
    const file = this.blobPath(blockId, hash);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = file + "." + randomUUID() + ".tmp",
      handle = await open(temporary, "wx"),
      digest = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > recordIngestionCapabilities.maxAttachmentBytes)
          fail("BODY_TOO_LARGE", "附件超过 64 MiB。", 413);
        digest.update(chunk);
        await handle.write(chunk);
      }
      if (digest.digest("hex") !== hash)
        fail("ATTACHMENT_CHECKSUM_MISMATCH", "附件校验失败。", 422);
      await handle.sync();
      await handle.close();
      this.block(blockId, actor, true);
      try {
        await stat(file);
        await unlink(temporary);
      } catch {
        await rename(temporary, file);
      }
      this.sql("INSERT OR IGNORE INTO record_blobs VALUES(?,?,?,?)").run(
        ...this.args(blockId),
        hash,
        bytes,
      );
      return { sha256: hash, size: bytes };
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}
