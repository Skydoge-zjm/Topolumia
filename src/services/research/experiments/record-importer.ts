import * as z from "zod/v4";
import { recordRichEventSchema, RECORD_INDEX_REVISION } from "./record-reader.js";
import { Worker } from "node:worker_threads";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ResearchCommandService } from "../research-command-service.js";
import type { ResearchActor, StoredAsset, IndexedTable } from "../../../domain/research/types.js";
import type { RecordProvider, RecordManifest, RecordImporterOptions, RecordWorkerInput, RecordLine, RecordPointRange, RecordPoint, RecordExactPoint, RecordRichEvent } from "../../../domain/research/record-types.js";
import { fail } from "../../../domain/research/access.js";
export { readHistoryJson } from "./record-reader.js";

/** Only small directories and requested point ranges cross the worker boundary. */
export class ExperimentRecordImporter {
  constructor(c: ResearchCommandService, options: RecordImporterOptions = {}) {
    this.c = c;
    this.options = options;
  }
  c: ResearchCommandService;
  options: RecordImporterOptions;
  worker: Worker | null = null;
  requests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  nextRequest = 0;
  pending = new Map<string, Promise<RecordManifest>>();
  indexes = new Map<string, { value: RecordManifest; bytes: number }>();
  indexBytes = 0;
  closed = false;
  closing: Promise<void> | null = null;
  remember(key: string, index: RecordManifest) {
    const bytes = Buffer.byteLength(JSON.stringify(index));
    if (bytes > 8 * 1024 * 1024) return;
    const previous = this.indexes.get(key);
    if (previous) this.indexBytes -= previous.bytes;
    this.indexes.delete(key);
    this.indexes.set(key, { value: index, bytes });
    this.indexBytes += bytes;
    while (this.indexBytes > 8 * 1024 * 1024 || this.indexes.size > 256) {
      const first = this.indexes.keys().next().value!;
      this.indexBytes -= this.indexes.get(first)!.bytes;
      this.indexes.delete(first);
    }
  }
  indexPath(asset: StoredAsset, provider: RecordProvider) {
    return path.join(
      this.c.assets.root,
      "derived",
      asset.id.slice(6),
      "experiment-record-v" + RECORD_INDEX_REVISION,
      provider + ".json",
    );
  }
  eventsPath(asset: StoredAsset, provider: RecordProvider) {
    return this.indexPath(asset, provider) + ".events.json";
  }
  async staticEvents(assetId: string, provider: RecordProvider, actor: ResearchActor): Promise<{ sourceId: string; events: RecordRichEvent[] }[]> {
    const asset = this.c.assets.assert(assetId, actor);
    await this.indexed(assetId, provider, actor);
    let file = this.eventsPath(asset, provider);
    if (!existsSync(file)) {
      await this.task({
        action: "ensure",
        provider,
        asset: { ...asset, file: this.c.assets.file(asset) },
      });
      file = this.eventsPath(asset, provider);
    }
    if (!existsSync(file)) return [];
    const text = await readFile(file, "utf8");
    const value = z.object({ checksum: z.string(), provider: z.enum(["wandb", "tensorboard", "mlflow"]), runs: z.array(z.object({ sourceId: z.string(), events: z.array(recordRichEventSchema) })).default([]) }).parse(JSON.parse(text) as unknown);
    if (value.checksum !== asset.checksum || value.provider !== provider)
      fail("EXPERIMENT_RECORD_CHANGED", "实验记录事件索引与原文件不一致。", 409);
    return value.runs ?? [];
  }
  task(input: Extract<RecordWorkerInput, { action: "ensure" }>): Promise<RecordManifest>;
  task(input: Extract<RecordWorkerInput, { action: "select" }>): Promise<{ points: RecordPoint[]; pointCount: number }[]>;
  task(input: Extract<RecordWorkerInput, { action: "table" }>): Promise<IndexedTable>;
  task(input: Extract<RecordWorkerInput, { action: "close" }>): Promise<null>;
  task(input: RecordWorkerInput): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error("Experiment records closed"));
    if (!this.worker) {
      const worker = new Worker(new URL("./record-worker.js", import.meta.url));
      this.worker = worker;
      worker.on("message", ({ id, value, error }: { id: number; value: unknown; error?: { message: string; code?: string; status?: number } }) => {
        const request = this.requests.get(id);
        if (!request) return;
        this.requests.delete(id);
        if (error)
          request.reject(
            Object.assign(new Error(error.message), {
              code: error.code,
              status: error.status,
            }),
          );
        else request.resolve(value);
        if (!this.requests.size) worker.unref();
      });
      const failed = (error: Error) => {
        if (this.worker !== worker) return;
        this.worker = null;
        for (const request of this.requests.values()) request.reject(error);
        this.requests.clear();
      };
      worker.on("error", failed);
      worker.on("exit", () => {
        failed(new Error("Experiment record worker exited"));
      });
      worker.unref();
    }
    const configured = this.options.pythonCommand;
    const pythonCommand =
      (typeof configured === "function" ? configured() : configured) ||
      "python";
    const id = ++this.nextRequest;
    this.worker.ref();
    return new Promise<unknown>((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      try {
        this.worker!.postMessage({
          ...input,
          id,
          root: this.c.assets.root,
          pythonCommand,
        });
      } catch (error) {
        this.requests.delete(id);
        if (!this.requests.size) this.worker!.unref();
        reject(error);
      }
    });
  }
  index(assetId: string, provider: RecordProvider, actor: ResearchActor): RecordManifest {
    const asset = this.c.assets.assert(assetId, actor);
    const file = this.indexPath(asset, provider);
    if (!existsSync(this.c.assets.file(asset)))
      fail("ASSET_UNAVAILABLE", "实验记录原文件不可用。", 404);
    if (!existsSync(file + ".manifest.json"))
      fail(
        "EXPERIMENT_RECORD_NOT_INDEXED",
        "先读取并检查实验记录文件，再保存实验记录内容块。",
        422,
      );
    const key = provider + ":" + asset.id + ":" + asset.checksum;
    const index =
      this.indexes.get(key)?.value ??
      JSON.parse(readFileSync(file + ".manifest.json", "utf8"));
    if (index.checksum !== asset.checksum || index.provider !== provider)
      fail("EXPERIMENT_RECORD_CHANGED", "实验记录索引与原文件不一致。", 409);
    return index;
  }
  async indexed(assetId: string, provider: RecordProvider, actor: ResearchActor): Promise<RecordManifest> {
    const asset = this.c.assets.assert(assetId, actor);
    if (!existsSync(this.c.assets.file(asset)))
      fail("ASSET_UNAVAILABLE", "实验记录原文件不可用。", 404);
    const key = provider + ":" + asset.id + ":" + asset.checksum;
    const cached = this.indexes.get(key);
    if (cached && existsSync(this.indexPath(asset, provider))) {
      this.indexes.delete(key);
      this.indexes.set(key, cached);
      return cached.value;
    }
    if (!this.pending.has(key))
      this.pending.set(
        key,
        this.task({
          action: "ensure",
          provider,
          asset: { ...asset, file: this.c.assets.file(asset) },
        })
          .then((index) => {
            this.remember(key, index);
            return index;
          })
          .finally(() => this.pending.delete(key)),
      );
    return this.pending.get(key)!;
  }
  async inspect(provider: RecordProvider, assetIds: string[], actor: ResearchActor) {
    this.c.check(actor, "research.view");
    const merged = new Map<string, { sourceId: string; label: string; status: string; assetIds: string[]; metrics: { key: string; xKey: string; pointCount: number }[] }>(), diagnostics: { sourceId: string; assetId: string; key?: string; missingDependencies?: string[] }[] = [];
    for (const assetId of [...new Set<string>(assetIds)]) {
      const index = await this.indexed(assetId, provider, actor);
      for (const run of index.runs) {
        for (const warning of run.nativeSemantics?.warnings ?? []) diagnostics.push({ sourceId: run.sourceId, assetId, key: warning.key, missingDependencies: warning.missingDependencies?.slice(0, 2).map(path => String(path).slice(0, 180)) });
        const metrics = run.series.map((line) => ({
          key: line.key,
          xKey: line.xKey,
          pointCount: line.pointCount,
        }));
        const existing = merged.get(run.sourceId);
        if (existing) {
          existing.assetIds.push(assetId);
          for (const metric of metrics) existing.metrics.push(metric);
        } else
          merged.set(run.sourceId, {
            sourceId: run.sourceId,
            label: run.label,
            status: run.status,
            assetIds: [assetId],
            metrics,
          });
      }
      const current = this.c.store.get("assets", assetId);
      if (
        current &&
        (current.recordManifests?.[provider]?.checksum !== index.checksum ||
          current.recordManifests?.[provider]?.parserRevision !== RECORD_INDEX_REVISION)
      )
        this.c.store.put("assets", assetId, {
          ...current,
          recordManifests: {
            ...current.recordManifests,
            [provider]: {
              checksum: index.checksum,
              sourceIds: index.runs.map((run) => run.sourceId),
              parserRevision: RECORD_INDEX_REVISION,
            },
          },
        });
    }
    return { provider, runs: [...merged.values()], diagnostics: diagnostics.slice(0, 5), omittedDiagnosticCount: Math.max(0, diagnostics.length - 5) };
  }
  async selectPoints(lines: RecordLine[], selection: RecordPointRange, actor: ResearchActor): Promise<{ points: (RecordPoint | RecordExactPoint)[]; pointCount: number }[]> {
    // Recheck every requested asset at the caller boundary, including cache hits.
    const assets = new Map<string, StoredAsset & { file: string }>();
    for (const line of lines)
      for (const segment of line.segments)
        if (segment.assetId && !assets.has(segment.assetId)) {
          const asset = this.c.assets.assert(segment.assetId, actor);
          assets.set(asset.id, { ...asset, file: this.c.assets.file(asset) });
        }
    return this.task({
      action: "select",
      queries: lines.map((line) => ({
        key: line.key,
        xKey: line.xKey,
        ...selection,
        segments: line.segments.map((segment) =>
          segment.assetId
            ? { ...segment, asset: assets.get(segment.assetId) }
            : segment,
        ),
      })),
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Queue shutdown behind accepted work and reject new submissions immediately.
    const worker = this.worker;
    const drain = worker ? this.task({ action: "close" }) : Promise.resolve();
    this.closed = true;
    this.closing = (async () => {
      await drain.catch(() => {});
      await worker?.terminate();
      this.indexes.clear();
      this.indexBytes = 0;
    })();
    return this.closing;
  }
}
