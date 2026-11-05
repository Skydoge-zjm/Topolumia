import { readFile } from "node:fs/promises";
import { AppError } from "../../lib/errors.js";
import {
  asKeyValueObject,
  metricSummary,
  normalizeMetricHistory,
  normalizeRun,
  normalizeSeries,
  parseExperimentRef,
  stableRunRef,
} from "../../domain/experiments/experiment-domain.js";
import { capabilityProfileWithDetails } from "../../domain/experiments/experiment-provider.js";

function keyValueArrayToObject(value) {
  return asKeyValueObject(value);
}

function metricArrayToObject(value) {
  const history = normalizeMetricHistory(value);
  return Object.fromEntries(Object.entries(history)
    .filter(([, points]) => points.length)
    .map(([key, points]) => [key, points.at(-1).y]));
}

function toIso(milliseconds) {
  if (milliseconds === undefined || milliseconds === null) return null;
  const date = new Date(Number(milliseconds));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dataArtifacts(run) {
  return run.data?.artifacts ?? [];
}

function artifactKind(filePath) {
  const extension = String(filePath ?? "").split(".").at(-1)?.toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "svg"].includes(extension)) return extension === "svg" ? "chart" : "image";
  if (["json", "csv", "tsv", "parquet"].includes(extension)) return "data";
  if (["pt", "pth", "ckpt", "safetensors"].includes(extension)) return "checkpoint";
  return "file";
}

function mapMlflowArtifact(item, runId, artifactUri = null) {
  const value = item && typeof item === "object" ? item : { path: String(item) };
  const filePath = value.path ?? value.name ?? "artifact";
  return {
    ...value,
    ref: value.ref ?? `mlflow:artifact:${runId}/${filePath}`,
    path: filePath,
    kind: value.kind ?? artifactKind(filePath),
    size: value.size ?? value.file_size ?? null,
    downloadable: value.downloadable ?? !value.is_dir,
    uri: value.uri ?? (artifactUri ? `${String(artifactUri).replace(/\/$/, "")}/${filePath}` : null),
  };
}

function metricHistoryFromRun(run) {
  const data = run.data ?? {};
  return normalizeMetricHistory(data.metric_history ?? data.metricHistory ?? data.history ?? {});
}

export function mapMlflowRun(run, source = "mlflow-local", mode = null) {
  const info = run.info ?? {};
  const params = keyValueArrayToObject(run.data?.params);
  const tags = keyValueArrayToObject(run.data?.tags);
  const metricHistory = metricHistoryFromRun(run);
  const metrics = { ...metricArrayToObject(run.data?.metrics), ...metricArrayToObject(metricHistory) };
  const runId = info.run_id ?? info.run_uuid ?? run.run_id ?? run.id;
  const group = params.group ?? tags["research.group"] ?? "ungrouped";
  const endedAt = toIso(info.end_time);
  const startedAt = toIso(info.start_time);
  const mapped = {
    ref: stableRunRef("mlflow", runId),
    source,
    provider: "mlflow",
    kind: "run",
    externalId: runId,
    version: `${String(info.status ?? "unknown").toLowerCase()}@${endedAt ?? startedAt ?? "unknown"}`,
    label: info.run_name ?? tags["mlflow.runName"] ?? `${group} · ${runId}`,
    locator: `mlflow://experiment/${info.experiment_id}/run/${runId}`,
    observedAt: endedAt ?? startedAt,
    experimentId: info.experiment_id,
    experiment: run.experiment ?? null,
    status: info.status ?? "UNKNOWN",
    startedAt,
    endedAt,
    artifactUri: info.artifact_uri ?? null,
    group,
    metrics,
    metricHistory,
    metricSummary: metricSummary(metricHistory, metrics),
    params,
    tags,
    artifacts: (Array.isArray(run.artifacts) ? run.artifacts : (Array.isArray(dataArtifacts(run)) ? dataArtifacts(run) : []))
      .map((item) => mapMlflowArtifact(item, runId, info.artifact_uri)),
    inputs: Array.isArray(run.inputs) ? run.inputs : [],
    errorMessage: info.status === "FAILED" ? (tags["mlflow.runError"] ?? run.error_message ?? null) : null,
    capabilities: {
      structuredRun: { status: "supported" },
      history: { status: "supported", xKey: "step" },
      metricHistory: { status: "supported", xKey: "step" },
      artifacts: { status: "supported" },
      inputs: { status: "unavailable", reason: "MLflow input lineage depends on tracking server version and run metadata" },
      inputLineage: { status: "unavailable", reason: "MLflow input lineage depends on tracking server version and run metadata" },
      media: { status: "supported", formats: ["image/*"] },
    },
  };
  return normalizeRun(mapped, {
    provider: "mlflow",
    mode: mode ?? (source.includes("live") ? "live" : "fixture"),
    capabilityProfile: {
      structuredRun: true,
      history: true,
      metricHistory: true,
      artifacts: true,
      inputs: false,
      inputLineage: false,
      media: true,
    },
    observedAt: mapped.observedAt ?? new Date().toISOString(),
  });
}

export class MlflowAdapter {
  constructor(config) {
    this.config = config;
    this.id = "mlflow-local";
    this.lastLiveError = null;
    this.lastSnapshot = null;
  }

  get baseUrl() {
    return String(this.config.mlflow.baseUrl || "").replace(/\/+$/, "");
  }

  headers() {
    const headers = { accept: "application/json", "content-type": "application/json" };
    const token = process.env[this.config.mlflow.tokenEnv];
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  }

  async request(pathname, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.mlflow.timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        ...options,
        headers: { ...this.headers(), ...(options.headers ?? {}) },
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new Error(`MLflow returned non-JSON response (${response.status})`);
        }
      }
      if (!response.ok) {
        throw new AppError("MLFLOW_HTTP_ERROR", `MLflow 请求失败：HTTP ${response.status}`, {
          status: 503,
          detail: { providerStatus: response.status, providerMessage: payload.message ?? null },
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("MLFLOW_UNREACHABLE", "无法连接 MLflow tracking server。", {
        status: 503,
        detail: { reason: error.name === "AbortError" ? "request timed out" : error.message },
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    const checkedAt = new Date().toISOString();
    if (!this.baseUrl) return { status: "ready", detail: "fixture dataset ready; live endpoint not configured", checkedAt };
    try {
      await this.request("/api/2.0/mlflow/experiments/search?max_results=1");
      this.lastLiveError = null;
      return { status: "ready", detail: `live · ${this.baseUrl}`, checkedAt };
    } catch (error) {
      this.lastLiveError = error;
      return { status: "degraded", detail: `${error.message}; fixture fallback available`, checkedAt };
    }
  }

  async descriptor() {
    const health = await this.health();
    const capability = capabilityProfileWithDetails({ structuredRun: true, history: true, metricHistory: true, artifacts: true, inputs: false, inputLineage: false, media: true }, {
      inputs: { status: "unavailable", reason: "input lineage depends on MLflow server version and run metadata" },
      inputLineage: { status: "unavailable", reason: "input lineage depends on MLflow server version and run metadata" },
    });
    return {
      id: this.id,
      kind: "source",
      provider: "mlflow",
      contract: "experiment-provider.v1",
      label: "MLflow",
      mode: this.baseUrl && health.status === "ready" ? "live" : "fixture",
      capabilities: ["health", "snapshot", "experiment-search", "run-search", "run-detail", "metric-history", "artifacts", "agent-context"],
      capabilityProfile: capability.capabilityProfile,
      capabilityDetails: capability.capabilities,
      health,
    };
  }

  async listExperiments({ limit = 100 } = {}) {
    if (this.baseUrl) {
      try {
        const response = await this.request(`/api/2.0/mlflow/experiments/search?max_results=${Math.min(300, Number(limit) || 100)}`);
        return { items: response.experiments ?? [], nextCursor: response.next_page_token ?? null, sourceStatus: "ready", mode: "live", observedAt: new Date().toISOString() };
      } catch {
        // Fall back to the last normalized snapshot, preserving degradation in the envelope.
      }
    }
    const snapshot = this.lastSnapshot ?? await this.snapshot();
    return {
      items: snapshot.experiment ? [snapshot.experiment] : [],
      nextCursor: null,
      sourceStatus: snapshot.degradedReason ? "degraded" : "ready",
      mode: snapshot.mode,
      observedAt: snapshot.observedAt,
    };
  }

  async fixtureSnapshot(reason = null) {
    const fixture = JSON.parse(await readFile(this.config.mlflow.fixtureFile, "utf8"));
    const observedAt = new Date().toISOString();
    const snapshot = {
      source: this.id,
      provider: "mlflow",
      observedAt,
      mode: "fixture",
      degradedReason: reason,
      experiment: fixture.experiment,
      runs: fixture.runs.map((run) => mapMlflowRun({ ...run, experiment: fixture.experiment }, this.id, "fixture")),
    };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  async liveSnapshot() {
    const search = await this.request("/api/2.0/mlflow/experiments/search?max_results=100");
    const experiments = search.experiments ?? [];
    const experiment = this.config.mlflow.experimentId
      ? experiments.find((item) => item.experiment_id === this.config.mlflow.experimentId)
      : experiments.find((item) => item.name === this.config.mlflow.experimentName) ?? experiments[0];
    if (!experiment) {
      throw new AppError("MLFLOW_EXPERIMENT_NOT_FOUND", "MLflow 中没有可用 experiment。", {
        status: 404,
        detail: { requested: this.config.mlflow.experimentId || this.config.mlflow.experimentName },
      });
    }

    const runs = [];
    let pageToken = null;
    do {
      const response = await this.request("/api/2.0/mlflow/runs/search", {
        method: "POST",
        body: JSON.stringify({
          experiment_ids: [experiment.experiment_id],
          max_results: this.config.mlflow.pageSize,
          ...(pageToken ? { page_token: pageToken } : {}),
        }),
      });
      runs.push(...(response.runs ?? []));
      pageToken = response.next_page_token || null;
    } while (pageToken && runs.length < this.config.mlflow.maxRuns);

    const snapshot = {
      source: this.id,
      provider: "mlflow",
      observedAt: new Date().toISOString(),
      mode: "live",
      degradedReason: null,
      experiment,
      runs: runs.slice(0, this.config.mlflow.maxRuns).map((run) => mapMlflowRun({ ...run, experiment }, this.id, "live")),
    };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  async snapshot() {
    if (!this.baseUrl) return this.fixtureSnapshot();
    try {
      return await this.liveSnapshot();
    } catch (error) {
      this.lastLiveError = error;
      return this.fixtureSnapshot(error.message);
    }
  }

  async listRuns({ limit = 100, group = null, status = null } = {}) {
    const snapshot = this.lastSnapshot ?? await this.snapshot();
    let runs = snapshot.runs ?? [];
    if (group) runs = runs.filter((run) => run.group === group || run.params?.group === group);
    if (status) runs = runs.filter((run) => String(run.status).toLowerCase() === String(status).toLowerCase());
    return { items: runs.slice(0, Math.min(300, Number(limit) || 100)), nextCursor: null, sourceStatus: snapshot.mode === "live" ? "ready" : (snapshot.degradedReason ? "degraded" : "ready"), mode: snapshot.mode, observedAt: snapshot.observedAt };
  }

  async getRun(refOrId) {
    const parsed = String(refOrId).includes(":run:") ? parseExperimentRef(refOrId) : { externalId: String(refOrId), provider: "mlflow" };
    if (parsed.provider !== "mlflow") throw new AppError("EXPERIMENT_PROVIDER_MISMATCH", "该引用不属于 MLflow。", { status: 422 });
    const snapshot = this.lastSnapshot ?? await this.snapshot();
    let run = snapshot.runs?.find((item) => item.ref === stableRunRef("mlflow", parsed.externalId) || item.externalId === parsed.externalId) ?? null;
    if (!run && this.baseUrl) {
      const response = await this.request(`/api/2.0/mlflow/runs/get?run_id=${encodeURIComponent(parsed.externalId)}`);
      run = mapMlflowRun(response.run ?? response, this.id, "live");
    }
    if (!run) throw new AppError("EXPERIMENT_REF_NOT_FOUND", "没有找到对应的实验 run。", { status: 404, detail: { ref: refOrId } });
    return { schemaVersion: "experiment-detail.v1", run, source: { provider: "mlflow", mode: snapshot.mode, degradedReason: snapshot.degradedReason ?? null, observedAt: snapshot.observedAt } };
  }

  async getSeries(refOrId, { metricKeys = [], maxPoints = 240 } = {}) {
    const detail = await this.getRun(refOrId);
    const run = detail.run;
    let history = run.metricHistory ?? {};
    const wanted = metricKeys.length ? metricKeys : Object.keys(history).length ? Object.keys(history) : Object.keys(run.metrics ?? {});
    if (this.baseUrl && wanted.some((key) => !(history[key]?.length))) {
      const fetched = { ...history };
      for (const key of wanted.slice(0, 8)) {
        try {
          const points = [];
          let pageToken = null;
          do {
            const query = new URLSearchParams({
              run_id: run.externalId,
              metric_key: key,
              max_results: String(Math.min(10_000, Math.max(240, Number(maxPoints) * 4))),
            });
            if (pageToken) query.set("page_token", pageToken);
            const response = await this.request(`/api/2.0/mlflow/metrics/get-history?${query}`);
            points.push(...(response.metrics ?? []));
            pageToken = response.next_page_token || null;
          } while (pageToken && points.length < 10_000);
          fetched[key] = points
            .map((item) => ({ x: item.step ?? 0, y: Number(item.value), timestamp: item.timestamp ?? null }))
            .filter((item) => Number.isFinite(item.y));
        } catch {
          // Missing provider history remains an unavailable series.
        }
      }
      history = fetched;
    }
    return {
      schemaVersion: "experiment-series.v1",
      ref: run.ref,
      provider: "mlflow",
      sourceStatus: detail.source.mode === "live" ? "ready" : (detail.source.degradedReason ? "degraded" : "ready"),
      observedAt: detail.source.observedAt,
      series: normalizeSeries(history, { metricKeys: wanted, maxPoints }),
    };
  }

  async listArtifacts(refOrId, { path = "" } = {}) {
    const detail = await this.getRun(refOrId);
    const run = detail.run;
    if (this.baseUrl) {
      try {
        const query = new URLSearchParams({ run_id: run.externalId, path });
        const response = await this.request(`/api/2.0/mlflow/artifacts/list?${query}`);
        return { items: (response.files ?? []).map((item) => mapMlflowArtifact(item, run.externalId, run.artifactUri)), sourceStatus: "ready" };
      } catch {
        // Fall through to metadata observed in the snapshot.
      }
    }
    return { items: run.artifacts ?? [], sourceStatus: detail.source.degradedReason ? "degraded" : "ready" };
  }
}
