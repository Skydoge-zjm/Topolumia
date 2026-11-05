import { access, readFile, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { AppError } from "../../lib/errors.js";
import {
  asObject,
  hashLocator,
  metricSummary,
  normalizeMetricHistory,
  normalizeRun,
  normalizeSeries,
  parseExperimentRef,
} from "../../domain/experiments/experiment-domain.js";
import { capabilityProfileWithDetails } from "../../domain/experiments/experiment-provider.js";

function scalarHistory(raw) {
  const value = asObject(raw);
  return normalizeMetricHistory(value.scalars ?? value.history ?? value.metricHistory ?? value.series);
}

export function mapTensorboardRun(raw, source = "tensorboard-fixture") {
  const value = asObject(raw);
  const logdir = String(value.logdir ?? value.path ?? value.locator ?? value.id ?? "local-run");
  const externalId = String(value.id ?? hashLocator(logdir).slice(0, 16));
  const metricHistory = scalarHistory(value);
  const metrics = Object.fromEntries(Object.entries(metricHistory).filter(([, points]) => points.length).map(([key, points]) => [key, points.at(-1).y]));
  return normalizeRun({
    ref: `tensorboard:run:${externalId}`,
    provider: "tensorboard",
    source,
    kind: "run",
    externalId,
    label: value.name ?? value.runName ?? path.basename(logdir) ?? externalId,
    locator: `tensorboard://${logdir}`,
    logdir,
    group: value.group ?? "ungrouped",
    status: value.status ?? "OBSERVED",
    startedAt: value.startedAt ?? null,
    endedAt: value.endedAt ?? null,
    observedAt: value.observedAt ?? new Date().toISOString(),
    params: asObject(value.params ?? value.hparams),
    tags: asObject(value.tags),
    metrics,
    metricHistory,
    metricSummary: metricSummary(metricHistory, metrics),
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
    media: Array.isArray(value.images) ? value.images : [],
    capabilities: {
      structuredRun: { status: "unavailable", reason: "TensorBoard event logs do not guarantee experiment/run metadata" },
      history: { status: "supported", xKey: "step" },
      metricHistory: { status: "supported", xKey: "step" },
      artifacts: { status: "unavailable", reason: "event media is not a general artifact store" },
      inputs: { status: "unavailable", reason: "TensorBoard does not expose input lineage" },
      inputLineage: { status: "unavailable", reason: "TensorBoard does not expose input lineage" },
      media: { status: "supported", formats: ["image/*"] },
      scalars: { status: "supported" },
      images: { status: "supported" },
    },
  }, {
    provider: "tensorboard",
    mode: source === "tensorboard-fixture" ? "fixture" : "local",
    capabilityProfile: { structuredRun: false, history: true, metricHistory: true, artifacts: false, inputs: false, inputLineage: false, media: true, scalars: true, images: true },
  });
}

async function readJsonLines(filePath) {
  const text = await readFile(filePath, "utf8");
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* ignore non-JSON event records */ }
  }
  return rows;
}

function isEventFile(name) {
  return /(?:^|\.)events\.out\.tfevents\./i.test(name);
}

async function findRunDirectories(root, maxDepth = 4) {
  const result = [];
  async function visit(dir, depth) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    if (files.some(isEventFile)) result.push({ dir, files: files.filter(isEventFile) });
    if (depth >= maxDepth) return;
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => visit(path.join(dir, entry.name), depth + 1)));
  }
  await visit(root, 0);
  return result;
}

async function findJsonRunDirectories(root, maxDepth = 4) {
  const result = [];
  async function visit(dir, depth) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && /(?:events|scalars).*\.jsonl?$/i.test(entry.name)).map((entry) => entry.name);
    if (files.length) result.push({ dir, files });
    if (depth >= maxDepth) return;
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => visit(path.join(dir, entry.name), depth + 1)));
  }
  await visit(root, 0);
  return result;
}

async function hasProtobufEvents(root, maxDepth = 4) {
  async function visit(dir, depth) {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && isEventFile(entry.name))) return true;
    if (depth >= maxDepth) return false;
    for (const entry of entries) {
      if (entry.isDirectory() && await visit(path.join(dir, entry.name), depth + 1)) return true;
    }
    return false;
  }
  return visit(root, 0);
}

async function hasJsonEventFiles(root, maxDepth = 4) {
  async function visit(dir, depth) {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && /(?:events|scalars).*\.jsonl?$/i.test(entry.name))) return true;
    if (depth >= maxDepth) return false;
    for (const entry of entries) {
      if (entry.isDirectory() && await visit(path.join(dir, entry.name), depth + 1)) return true;
    }
    return false;
  }
  return visit(root, 0);
}

function runProcess(command, args, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `parser exited with code ${code}`));
    });
  });
}

export class TensorboardAdapter {
  constructor(config) {
    this.config = config;
    this.id = "tensorboard-local";
    this.lastSnapshot = null;
  }

  get parserScript() {
    const configured = String(this.config.tensorboard.parserScript ?? "").trim();
    return configured || null;
  }

  async parseEventDirectory(dir) {
    if (!this.parserScript) {
      throw new AppError("TENSORBOARD_EVENT_PARSER_UNAVAILABLE", "发现 TensorBoard protobuf event file，但尚未配置 EventAccumulator sidecar。", {
        status: 503,
        detail: { logdir: dir, expected: "tensorboard.parserScript" },
      });
    }
    const text = await runProcess(this.config.tensorboard.pythonCommand ?? "python", [this.parserScript, "--logdir", dir, "--format", "json"], {
      timeoutMs: Number(this.config.tensorboard.parserTimeoutMs ?? 10_000),
    });
    let payload;
    try { payload = JSON.parse(text); }
    catch { throw new AppError("TENSORBOARD_EVENT_PARSE_FAILED", "TensorBoard EventAccumulator sidecar 返回了无效 JSON。", { status: 503, detail: { logdir: dir } }); }
    return payload;
  }

  async fixtureSnapshot(reason = null) {
    const fixture = JSON.parse(await readFile(this.config.tensorboard.fixtureFile, "utf8"));
    const snapshot = { source: this.id, provider: "tensorboard", mode: "fixture", degradedReason: reason, observedAt: new Date().toISOString(), runs: (fixture.runs ?? []).map((run) => mapTensorboardRun(run, "tensorboard-fixture")) };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  async localSnapshot() {
    const root = this.config.tensorboard.logdir;
    const entries = [];
    try {
      const jsonRunDirs = await findJsonRunDirectories(root, Number(this.config.tensorboard.maxDepth ?? 4));
      for (const runDir of jsonRunDirs) {
        const rows = (await Promise.all(runDir.files.map((file) => readJsonLines(path.join(runDir.dir, file))))).flat();
        const scalars = {};
        for (const row of rows) {
          const key = row.tag ?? row.key;
          const y = Number(row.value ?? row.y);
          if (!key || !Number.isFinite(y)) continue;
          scalars[key] ??= [];
          scalars[key].push({ step: row.step ?? row.x ?? scalars[key].length, value: y, timestamp: row.wall_time ?? row.timestamp ?? null });
        }
        const externalId = hashLocator(runDir.dir).slice(0, 16);
        entries.push(mapTensorboardRun({ id: externalId, name: path.basename(runDir.dir), logdir: runDir.dir, scalars }, this.id));
      }
      const protobufRuns = await findRunDirectories(root, Number(this.config.tensorboard.maxDepth ?? 4));
      for (const runDir of protobufRuns) {
        const externalId = hashLocator(runDir.dir).slice(0, 16);
        if (entries.some((entry) => entry.externalId === externalId || entry.logdir === runDir.dir)) continue;
        const parsed = await this.parseEventDirectory(runDir.dir);
        entries.push(mapTensorboardRun({
          ...parsed,
          id: externalId,
          name: parsed.name ?? path.basename(runDir.dir),
          logdir: runDir.dir,
          eventFiles: runDir.files,
        }, this.id));
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("TENSORBOARD_LOGDIR_UNREADABLE", "无法读取 TensorBoard logdir。", { status: 503, detail: { reason: error.message } });
    }
    const snapshot = { source: this.id, provider: "tensorboard", mode: "local", degradedReason: null, observedAt: new Date().toISOString(), runs: entries };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  async health() {
    const checkedAt = new Date().toISOString();
    if (!this.config.tensorboard.logdir) return { status: "ready", detail: "fixture event dataset ready; logdir not configured", checkedAt };
    try {
      await stat(this.config.tensorboard.logdir);
      if (this.parserScript) {
        try { await access(this.parserScript); } catch { return { status: "degraded", detail: `event parser unavailable · ${this.parserScript}`, checkedAt }; }
      }
      const maxDepth = Number(this.config.tensorboard.maxDepth ?? 4);
      const [protobuf, jsonEvents] = await Promise.all([
        hasProtobufEvents(this.config.tensorboard.logdir, maxDepth),
        hasJsonEventFiles(this.config.tensorboard.logdir, maxDepth),
      ]);
      if (protobuf) {
        try {
          await runProcess(this.config.tensorboard.pythonCommand ?? "python", [this.parserScript, "--probe"], {
            timeoutMs: Number(this.config.tensorboard.parserTimeoutMs ?? 10_000),
          });
        } catch (error) {
          return { status: "degraded", detail: `protobuf event parser unavailable: ${error.message}`, checkedAt };
        }
      }
      if (!protobuf && !jsonEvents) return { status: "degraded", detail: "configured logdir contains no supported event files; fixture fallback available", checkedAt };
      return { status: "ready", detail: `local logdir · ${this.config.tensorboard.logdir}`, checkedAt };
    }
    catch { return { status: "degraded", detail: "configured logdir is unavailable; fixture fallback available", checkedAt }; }
  }

  async descriptor() {
    const health = await this.health();
    const capability = capabilityProfileWithDetails({ structuredRun: false, history: true, metricHistory: true, artifacts: false, inputs: false, inputLineage: false, media: true, scalars: true, images: true }, {
      structuredRun: { status: "unavailable", reason: "TensorBoard event logs do not guarantee experiment/run metadata" },
      artifacts: { status: "unavailable", reason: "event media is not a general artifact store" },
      inputs: { status: "unavailable", reason: "TensorBoard does not expose input lineage" },
      inputLineage: { status: "unavailable", reason: "TensorBoard does not expose input lineage" },
      history: { status: "supported", xKey: "step" },
      metricHistory: { status: "supported", xKey: "step" },
    });
    return { id: this.id, kind: "source", provider: "tensorboard", contract: "experiment-provider.v1", label: "TensorBoard", mode: this.config.tensorboard.logdir && health.status === "ready" ? "local" : "fixture", capabilities: ["health", "event-log", "scalar-history", "image-events", "agent-context"], capabilityProfile: capability.capabilityProfile, capabilityDetails: capability.capabilities, health };
  }

  async listExperiments({ limit = 100 } = {}) {
    const snapshot = this.lastSnapshot ?? await this.snapshot();
    const root = this.config.tensorboard.logdir;
    const items = root ? [{ id: hashLocator(root), name: path.basename(root), locator: `tensorboard://${root}`, provider: "tensorboard", kind: "event-log", structuredRun: false }] : [];
    return {
      items: items.slice(0, Math.min(300, Number(limit) || 100)),
      nextCursor: null,
      sourceStatus: snapshot.degradedReason ? "degraded" : "ready",
      mode: snapshot.mode,
      observedAt: snapshot.observedAt,
    };
  }

  async snapshot() {
    if (this.config.tensorboard.logdir) {
      try { return await this.localSnapshot(); } catch (error) { return this.fixtureSnapshot(error.message); }
    }
    return this.fixtureSnapshot();
  }

  async listRuns({ limit = 100 } = {}) {
    const snapshot = this.lastSnapshot ?? await this.snapshot();
    return { items: (snapshot.runs ?? []).slice(0, Math.min(300, Number(limit) || 100)), nextCursor: null, sourceStatus: snapshot.degradedReason ? "degraded" : "ready", mode: snapshot.mode, observedAt: snapshot.observedAt };
  }

  async getRun(ref) {
    const parsed = parseExperimentRef(ref);
    if (parsed.provider !== "tensorboard") throw new AppError("EXPERIMENT_PROVIDER_MISMATCH", "该引用不属于 TensorBoard。", { status: 422 });
    const snapshot = this.lastSnapshot ?? await this.snapshot();
    const run = snapshot.runs?.find((item) => item.ref === ref || item.externalId === parsed.externalId);
    if (!run) throw new AppError("EXPERIMENT_REF_NOT_FOUND", "没有找到对应的实验 run。", { status: 404, detail: { ref } });
    return { schemaVersion: "experiment-detail.v1", run, source: { provider: "tensorboard", mode: snapshot.mode, degradedReason: snapshot.degradedReason ?? null, observedAt: snapshot.observedAt } };
  }

  async getSeries(ref, { metricKeys = [], maxPoints = 240 } = {}) {
    const detail = await this.getRun(ref);
    const history = detail.run.metricHistory ?? {};
    const wanted = metricKeys.length ? metricKeys : Object.keys(history);
    return { schemaVersion: "experiment-series.v1", ref: detail.run.ref, provider: "tensorboard", sourceStatus: detail.source.degradedReason ? "degraded" : "ready", observedAt: detail.source.observedAt, series: normalizeSeries(history, { metricKeys: wanted, maxPoints }) };
  }

  async listArtifacts(ref) {
    const detail = await this.getRun(ref);
    return { items: detail.run.artifacts ?? [], sourceStatus: detail.source.degradedReason ? "degraded" : "ready" };
  }
}
