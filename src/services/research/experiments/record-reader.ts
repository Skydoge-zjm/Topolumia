import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import * as z from "zod/v4";
import { recordNumberSchema } from "../../../domain/research/record-ingestion.js";
import type { StoredAsset, ResearchActor } from "../../../domain/research/types.js";
import type { IndexedRecordRun, RecordRichEvent, RecordIndex, RecordProvider, RecordReaderContext, RecordImporterOptions } from "../../../domain/research/record-types.js";
export const recordRichEventSchema = z.object({ seq: z.number().int().nonnegative().optional(), kind: z.string(), key: z.string().optional(), sourceRunId: z.string().optional(), data: z.record(z.string(), z.json()).optional() }).passthrough();
import path from "node:path";
import { randomUUID } from "node:crypto";
import { bundledRoot } from "../../../config.js";
import { fail } from "../../../domain/research/access.js";
import { versionHash } from "../../../lib/hash.js";
import type {
  ImportedExperimentRun,
  ExperimentSeries,
} from "../../../domain/research/experiment-records.js";

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
function status(value: unknown): ImportedExperimentRun["status"] {
  const name = String(value ?? "unknown").toLowerCase();
  return ["finished", "completed", "success", "succeeded"].includes(name)
    ? "succeeded"
    : ["failed", "error", "crashed"].includes(name)
      ? "failed"
      : ["killed", "cancelled", "canceled"].includes(name)
        ? "cancelled"
        : ["running", "queued"].includes(name)
          ? (name as "running" | "queued")
          : "unknown";
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Reads exported history without changing metric names or sorting away step resets. */
export function readHistoryJson(input: unknown, fallbackId: string, fallbackLabel: string): IndexedRecordRun[] {
  const data = object(input);
  const runs: unknown[] = Array.isArray(data.runs) ? data.runs : [Array.isArray(input) ? { history: input } : data];
  return runs.map((value, index) => {
    const run = object(value), series = new Map<string, ExperimentSeries>();
    const events: RecordRichEvent[] = Array.isArray(run.events) ? run.events.map(item => recordRichEventSchema.parse(item)) : [];
    const add = (key: string, x: unknown, y: unknown, xKey: string, timestamp?: unknown) => {
      if (key.startsWith("_") || !finite(x) || !finite(y)) return;
      const identity = JSON.stringify([key, xKey]);
      const line = series.get(identity) ?? { key, xKey, points: [] };
      line.points.push({ x, y, ...(finite(timestamp) ? { timestamp } : {}) });
      events.push({ kind: "scalar", key, xKey, x, value: y, ...(finite(timestamp) ? { timestamp } : {}) });
      series.set(identity, line);
    };
    const history = run.history ?? run.metricHistory ?? run.scalars ?? run.series ?? [];
    if (Array.isArray(history)) {
      for (const [rowIndex, value] of history.entries()) {
        const row = object(value);
        if (row.key && Array.isArray(row.points)) {
          for (const [pointIndex, value] of row.points.entries()) {
            const point = object(value);
            add(String(row.key), point.x ?? point.step ?? pointIndex, point.y ?? point.value, String(row.xKey ?? (finite(point.x ?? point.step) ? "step" : "recordIndex")), point.timestamp);
          }
        } else {
          const x = row._step ?? row.step ?? row.epoch ?? row.x;
          const xKey = finite(row._step ?? row.step) ? "step" : finite(row.epoch) ? "epoch" : finite(row.x) ? "x" : "recordIndex";
          for (const [key, value] of Object.entries(row)) if (!["step", "epoch", "x", "timestamp", "time"].includes(key)) add(key, finite(x) ? x : rowIndex, value, xKey, row._timestamp ?? row.timestamp);
        }
      }
    } else {
      for (const [key, values] of Object.entries(object(history))) if (Array.isArray(values)) {
        for (const [pointIndex, value] of values.entries()) {
          const point = object(value), x = point.step ?? point.x;
          add(key, finite(x) ? x : pointIndex, finite(value) ? value : point.value ?? point.y, finite(x) ? "step" : "recordIndex", point.timestamp);
        }
      }
    }
    return {
      sourceId: String(run.sourceId ?? run.id ?? run.run_id ?? object(run.run).id ?? fallbackId + (runs.length > 1 ? ":" + index : "")),
      label: String(run.label ?? run.name ?? object(run.run).name ?? (runs.length === 1 ? fallbackLabel : fallbackLabel + " " + (index + 1))),
      status: status(run.status ?? run.state),
      ...(typeof (run.status ?? run.state) === "string" ? { originalStatus: String(run.status ?? run.state) } : {}),
      series: [...series.values()], events,
      metrics: Object.fromEntries(Object.entries(object(run.metrics ?? run.summary)).filter((entry): entry is [string, number] => finite(entry[1]))),
    };
  });
}

const pointSchema = z.object({ x: z.number(), y: z.number(), timestamp: z.number().nullish(), originalX: recordNumberSchema.optional(), originalY: recordNumberSchema.optional(), nonFinite: z.boolean().optional() }).passthrough();
const parsedRunSchema = z.object({ sourceId: z.string(), label: z.string(), status: z.enum(["queued","running","succeeded","failed","cancelled","unknown"]), originalStatus: z.string().optional(), series: z.array(z.object({ key: z.string(), xKey: z.string(), unit: z.string().optional(), points: z.array(pointSchema) })), events: z.array(recordRichEventSchema).optional(), metrics: z.record(z.string(), z.number()).optional(), nativeSemantics: z.object({ warnings: z.array(z.object({ key: z.string().optional(), missingDependencies: z.array(z.string()).optional() })).optional() }).passthrough().optional() }).passthrough();
const parsedRunsSchema = z.object({ runs: z.array(parsedRunSchema) });
const indexSchema = parsedRunsSchema.extend({ schemaVersion: z.string(), provider: z.enum(["wandb","tensorboard","mlflow"]), assetId: z.string(), checksum: z.string(), contentVersion: z.string() });
export function parseRecordIndex(value: unknown): RecordIndex { return indexSchema.parse(value); }

export class ExperimentRecordReader {
  constructor(c: RecordReaderContext, options: RecordImporterOptions = {}) {
    this.c = c;
    this.options = options;
  }
  c: RecordReaderContext;
  options: RecordImporterOptions;
  children = new Set<ChildProcess>();
  indexes = new Map<string, { value: RecordIndex; bytes: number }>();
  indexBytes = 0;
  remember(asset: StoredAsset, provider: RecordProvider, value: RecordIndex, bytes: number) {
    if (bytes > 64 * 1024 * 1024) return;
    const key = provider + ":" + asset.id + ":" + asset.checksum;
    const previous = this.indexes.get(key);
    if (previous) this.indexBytes -= previous.bytes;
    this.indexes.delete(key);
    this.indexes.set(key, { value, bytes });
    this.indexBytes += bytes;
    while (this.indexBytes > 64 * 1024 * 1024) {
      const first = this.indexes.keys().next().value!;
      this.indexBytes -= this.indexes.get(first)!.bytes;
      this.indexes.delete(first);
    }
  }
  indexPath(asset: StoredAsset, provider: RecordProvider): string {
    return path.join(
      this.c.assets.root,
      "derived",
      asset.id.slice(6),
      "experiment-record-v2",
      provider + ".json",
    );
  }
  eventsPath(asset: StoredAsset, provider: RecordProvider): string {
    return this.indexPath(asset, provider) + ".events.json";
  }
  index(assetId: string, provider: RecordProvider, actor: ResearchActor): RecordIndex {
    const asset = this.c.assets.assert(assetId, actor),
      file = this.indexPath(asset, provider);
    if (!existsSync(this.c.assets.file(asset)))
      fail("ASSET_UNAVAILABLE", "实验记录原文件不可用。", 404);
    if (!existsSync(file))
      fail(
        "EXPERIMENT_RECORD_NOT_INDEXED",
        "先读取并检查实验记录文件，再保存实验记录内容块。",
        422,
      );
    const key = provider + ":" + asset.id + ":" + asset.checksum,
      cached = this.indexes.get(key);
    if (cached) {
      this.indexes.delete(key);
      this.indexes.set(key, cached);
      return cached.value;
    }
    const text = readFileSync(file, "utf8"),
      index = parseRecordIndex(JSON.parse(text));
    if (index.checksum !== asset.checksum || index.provider !== provider)
      fail("EXPERIMENT_RECORD_CHANGED", "实验记录索引与原文件不一致。", 409);
    this.remember(asset, provider, index, Buffer.byteLength(text));
    return index;
  }
  async process(asset: StoredAsset, provider: RecordProvider): Promise<RecordIndex> {
    const source = this.c.assets.file(asset),
      name = asset.originalName;
    let runs: IndexedRecordRun[];
    if (/\.jsonl?$/i.test(name)) {
      const text = await readFile(source, "utf8");
      let input;
      try {
        input = /\.jsonl$/i.test(name)
          ? text
              .split(/\r?\n/)
              .filter((line) => line.trim())
              .map((line) => JSON.parse(line))
          : JSON.parse(text);
      } catch {
        fail(
          "EXPERIMENT_RECORD_INVALID",
          "实验记录不是有效的 JSON / JSONL。",
          422,
        );
      }
      if (
        !Array.isArray(input) &&
        (!input ||
          typeof input !== "object" ||
          ![
            "runs",
            "history",
            "metricHistory",
            "scalars",
            "series",
            "metrics",
            "summary",
          ].some((key) => Object.hasOwn(input, key)))
      )
        fail(
          "EXPERIMENT_RECORD_INVALID",
          "JSON 中没有运行记录或指标历史；配置文件可保存为普通内容块。",
          422,
        );
      runs = readHistoryJson(input, asset.id, name);
    } else {
      if (
        (provider === "wandb" && !/\.wandb$/i.test(name)) ||
        (provider === "tensorboard" && !/tfevents/i.test(name)) ||
        !["wandb", "tensorboard"].includes(provider)
      )
        fail(
          "EXPERIMENT_RECORD_FORMAT",
          "请选择原生 .wandb、TensorBoard event 或导出的 JSON/JSONL 记录。",
          422,
        );
      const parsed = await this.native(provider, source, name);
      runs = parsed.runs;
      if (provider === "tensorboard")
        for (const run of runs) run.sourceId = asset.id;
    }
    if (!Array.isArray(runs) || !runs.length)
      fail(
        "EXPERIMENT_RECORD_EMPTY",
        "文件中没有可读取的运行记录；原始文件仍已保存。",
        422,
      );
    for (const run of runs) {
      if (
        typeof run.sourceId !== "string" ||
        !run.sourceId ||
        run.sourceId.length > 500 ||
        typeof run.label !== "string" ||
        run.label.length > 240 ||
        !Array.isArray(run.series)
      )
        fail(
          "EXPERIMENT_RECORD_INVALID",
          "实验记录的 run 身份或曲线不合法。",
          422,
        );
      for (const line of run.series)
        if (
          typeof line.key !== "string" ||
          !Array.isArray(line.points) ||
          line.points.some((point) => !finite(point.x) || !finite(point.y))
        )
          fail("EXPERIMENT_RECORD_INVALID", "实验记录包含无效数值。", 422);
    }
    const value = {
      schemaVersion: "experiment-record-index.v2",
      provider,
      assetId: asset.id,
      checksum: asset.checksum,
      contentVersion: versionHash({
        checksum: asset.checksum,
        provider,
        parser: 2,
      }),
      runs,
    };
    const file = this.indexPath(asset, provider);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = file + "." + randomUUID(),
      text = JSON.stringify(value);
    await writeFile(temporary, text);
    await rename(temporary, file);
    this.remember(asset, provider, value, Buffer.byteLength(text));
    return value;
  }
  native(provider: RecordProvider, file: string, label: string): Promise<{ runs: IndexedRecordRun[] }> {
    const configured = this.options.pythonCommand;
    const command =
      (typeof configured === "function" ? configured() : configured) ||
      "python";
    const script = path.join(
      bundledRoot,
      "scripts/runtime/experiment-record-parser.py",
    );
    return new Promise<{ runs: IndexedRecordRun[] }>((resolve, reject) => {
      const child = spawn(
        command,
        [script, "--provider", provider, "--file", file, "--label", label],
        {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            WANDB_MODE: "offline",
            WANDB_SILENT: "true",
            PYTHONUTF8: "1",
            PYTHONIOENCODING: "utf-8",
          },
        },
      );
      this.children.add(child);
      let stdout = "",
        stderr = "",
        failure: string | undefined;
      const outputChunks: Buffer[] = [];
      let outputBytes = 0;
      const timer = setTimeout(() => {
        failure = "实验记录读取超时。";
        child.kill();
      }, 20_000);
      child.stdout.on("data", (chunk) => {
        outputChunks.push(chunk);
        outputBytes += chunk.length;
        if (outputBytes > 128 * 1024 * 1024) {
          failure = "实验记录过大，请缩小导入范围。";
          child.kill();
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-3000);
      });
      child.once("error", () => {
        failure =
          "无法启动实验记录读取器的 Python，请检查 experimentRecords.pythonCommand。";
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (failure || code !== 0) {
          try {
            fail(
              "EXPERIMENT_RECORD_READER_UNAVAILABLE",
              failure ?? stderr.trim().slice(-800) ?? "实验记录读取失败。",
              422,
            );
          } catch (error) {
            reject(error);
          }
          return;
        }
        try {
          stdout = Buffer.concat(outputChunks, outputBytes).toString("utf8");
          resolve({ runs: parsedRunsSchema.parse(JSON.parse(stdout)).runs });
        } catch {
          try {
            fail(
              "EXPERIMENT_RECORD_INVALID",
              "原生记录读取器返回了无效数据。",
              422,
            );
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  }
  async close() {
    for (const child of this.children) child.kill();
    this.indexes.clear();
    this.indexBytes = 0;
  }
}
