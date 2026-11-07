import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
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

/** Reads exported history without changing metric names or sorting away step resets. */
export function readHistoryJson(
  input: unknown,
  fallbackId: string,
  fallbackLabel: string,
): ImportedExperimentRun[] {
  const data: any = input;
  const runs = Array.isArray(data?.runs)
    ? data.runs
    : [
        {
          history: Array.isArray(data)
            ? data
            : (data?.history ?? data?.metricHistory ?? data?.scalars),
          ...(!Array.isArray(data) ? data : {}),
        },
      ];
  return runs.map((run: any, index: number) => {
    const series = new Map<string, ExperimentSeries>();
    const add = (
      key: string,
      x: unknown,
      y: unknown,
      xKey: string,
      timestamp?: unknown,
    ) => {
      if (key.startsWith("_") || !finite(x) || !finite(y)) return;
      const identity = JSON.stringify([key, xKey]);
      const line = series.get(identity) ?? { key, xKey, points: [] };
      line.points.push({ x, y, ...(finite(timestamp) ? { timestamp } : {}) });
      series.set(identity, line);
    };
    const history =
      run.history ?? run.metricHistory ?? run.scalars ?? run.series ?? [];
    if (Array.isArray(history)) {
      for (const [rowIndex, row] of history.entries()) {
        if (row?.key && Array.isArray(row.points)) {
          for (const [pointIndex, point] of row.points.entries())
            add(
              String(row.key),
              point.x ?? point.step ?? pointIndex,
              point.y ?? point.value,
              row.xKey ??
                (finite(point.x ?? point.step) ? "step" : "recordIndex"),
              point.timestamp,
            );
        } else if (row && typeof row === "object") {
          const x = row._step ?? row.step ?? row.epoch ?? row.x;
          const xKey = finite(row._step ?? row.step)
            ? "step"
            : finite(row.epoch)
              ? "epoch"
              : finite(row.x)
                ? "x"
                : "recordIndex";
          for (const [key, value] of Object.entries(row))
            if (!["step", "epoch", "x", "timestamp", "time"].includes(key))
              add(
                key,
                finite(x) ? x : rowIndex,
                value,
                xKey,
                row._timestamp ?? row.timestamp,
              );
        }
      }
    } else if (history && typeof history === "object") {
      for (const [key, values] of Object.entries(history))
        if (Array.isArray(values))
          for (const [pointIndex, point] of values.entries()) {
            const x = point?.step ?? point?.x;
            add(
              key,
              finite(x) ? x : pointIndex,
              finite(point) ? point : (point?.value ?? point?.y),
              finite(x) ? "step" : "recordIndex",
              point?.timestamp ?? point?.wall_time,
            );
          }
    }
    const sourceId = String(
      run.sourceId ??
        run.id ??
        run.runId ??
        run.run?.id ??
        (runs.length === 1 ? fallbackId : fallbackId + ":" + index),
    );
    return {
      sourceId,
      label: String(
        run.label ??
          run.name ??
          run.run?.name ??
          (runs.length === 1
            ? fallbackLabel
            : fallbackLabel + " " + (index + 1)),
      ),
      status: status(run.status ?? run.state),
      originalStatus: run.status ?? run.state,
      series: [...series.values()],
      metrics: Object.fromEntries(
        Object.entries(run.metrics ?? run.summary ?? {}).filter(([, value]) =>
          finite(value),
        ),
      ),
    };
  });
}

export class ExperimentRecordImporter {
  constructor(c, options: any = {}) {
    this.c = c;
    this.options = options;
  }
  c;
  options;
  children = new Set<any>();
  pending = new Map<string, Promise<any>>();
  indexes = new Map<string, { value: any; bytes: number }>();
  indexBytes = 0;
  remember(asset, provider, value, bytes) {
    if (bytes > 64 * 1024 * 1024) return;
    const key = provider + ":" + asset.id + ":" + asset.checksum;
    const previous = this.indexes.get(key);
    if (previous) this.indexBytes -= previous.bytes;
    this.indexes.delete(key);
    this.indexes.set(key, { value, bytes });
    this.indexBytes += bytes;
    while (this.indexBytes > 64 * 1024 * 1024) {
      const first = this.indexes.keys().next().value;
      this.indexBytes -= this.indexes.get(first)!.bytes;
      this.indexes.delete(first);
    }
  }
  indexPath(asset, provider) {
    return path.join(
      this.c.assets.root,
      "derived",
      asset.id.slice(6),
      "experiment-record-v1",
      provider + ".json",
    );
  }
  index(assetId, provider, actor) {
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
      index = JSON.parse(text);
    if (index.checksum !== asset.checksum || index.provider !== provider)
      fail("EXPERIMENT_RECORD_CHANGED", "实验记录索引与原文件不一致。", 409);
    this.remember(asset, provider, index, Buffer.byteLength(text));
    return index;
  }
  async indexed(assetId, provider, actor) {
    const asset = this.c.assets.assert(assetId, actor);
    if (!existsSync(this.indexPath(asset, provider)))
      await this.inspect(provider, [assetId], actor);
    return this.index(assetId, provider, actor);
  }
  async inspect(provider, assetIds, actor) {
    this.c.check(actor, "research.view");
    const result = [];
    for (const assetId of [...new Set<string>(assetIds)]) {
      const asset = this.c.assets.assert(assetId, actor),
        key = provider + ":" + asset.id;
      let index;
      if (existsSync(this.indexPath(asset, provider)))
        index = this.index(asset.id, provider, actor);
      else {
        if (!this.pending.has(key))
          this.pending.set(
            key,
            this.process(asset, provider).finally(() =>
              this.pending.delete(key),
            ),
          );
        index = await this.pending.get(key);
      }
      for (const run of index.runs)
        result.push({
          sourceId: run.sourceId,
          label: run.label,
          status: run.status,
          assetIds: [asset.id],
          metrics: run.series.map((line) => ({
            key: line.key,
            xKey: line.xKey,
            pointCount: line.points.length,
          })),
        });
      const current = this.c.store.get("assets", asset.id);
      if (
        current &&
        current.recordManifests?.[provider]?.checksum !== asset.checksum
      )
        this.c.store.put("assets", asset.id, {
          ...current,
          recordManifests: {
            ...current.recordManifests,
            [provider]: {
              checksum: asset.checksum,
              sourceIds: index.runs.map((run) => run.sourceId),
            },
          },
        });
    }
    const merged = new Map();
    for (const run of result) {
      const existing = merged.get(run.sourceId);
      if (existing) {
        existing.assetIds.push(...run.assetIds);
        existing.metrics.push(...run.metrics);
      } else merged.set(run.sourceId, structuredClone(run));
    }
    return { provider, runs: [...merged.values()] };
  }
  async process(asset, provider) {
    const source = this.c.assets.file(asset),
      name = asset.originalName;
    let runs;
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
      schemaVersion: "experiment-record-index.v1",
      provider,
      assetId: asset.id,
      checksum: asset.checksum,
      contentVersion: versionHash({
        checksum: asset.checksum,
        provider,
        parser: 1,
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
  native(provider, file, label) {
    const configured = this.options.pythonCommand;
    const command =
      (typeof configured === "function" ? configured() : configured) ||
      "python";
    const script = path.join(
      bundledRoot,
      "scripts/runtime/experiment-record-parser.py",
    );
    return new Promise<any>((resolve, reject) => {
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
        failure;
      const timer = setTimeout(() => {
        failure = "实验记录读取超时。";
        child.kill();
      }, 20_000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (Buffer.byteLength(stdout) > 128 * 1024 * 1024) {
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
          resolve(JSON.parse(stdout));
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
    await Promise.allSettled(this.pending.values());
    this.indexes.clear();
    this.indexBytes = 0;
  }
}
