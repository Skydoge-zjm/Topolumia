import { readFile } from "node:fs/promises";
import { AppError } from "../../lib/errors.js";
import {
  asObject,
  metricSummary,
  normalizeMetricHistory,
  normalizeRun,
  normalizeSeries,
  parseExperimentRef,
} from "../../domain/experiments/experiment-domain.js";
import { capabilityProfileWithDetails } from "../../domain/experiments/experiment-provider.js";

const WANDB_HEALTH_QUERY = `query WorkbenchHealth { viewer { id } }`;
const WANDB_RUNS_QUERY = `
  query WorkbenchRuns($entity: String!, $project: String!, $first: Int!, $after: String) {
    project(name: $project, entityName: $entity) {
      id
      name
      runs(first: $first, after: $after, order: "-createdAt") {
        edges {
          cursor
          node {
            id
            name
            displayName
            state
            group
            createdAt
            heartbeatAt
            config
            summaryMetrics
            tags { name }
          }
        }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
`;
const WANDB_RUN_QUERY = `
  query WorkbenchRun($entity: String!, $project: String!, $run: String!) {
    project(name: $project, entityName: $entity) {
      run(name: $run) {
        id
        name
        displayName
        state
        group
        createdAt
        heartbeatAt
        config
        summaryMetrics
        tags { name }
      }
    }
  }
`;
const WANDB_HISTORY_QUERY = `
  query WorkbenchRunHistory($entity: String!, $project: String!, $run: String!, $specs: [JSONString!]!) {
    project(name: $project, entityName: $entity) {
      run(name: $run) { sampledHistory(specs: $specs) }
    }
  }
`;
const WANDB_ARTIFACTS_QUERY = `
  query WorkbenchRunArtifacts($entity: String!, $project: String!, $run: String!, $first: Int!) {
    project(name: $project, entityName: $entity) {
      run(name: $run) {
        outputArtifacts(first: $first) {
          edges { node { id name description digest state type { name } } }
        }
        inputArtifacts(first: $first) {
          edges { node { id name description digest state type { name } } }
        }
      }
    }
  }
`;

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function unwrapConfig(value) {
  return Object.fromEntries(Object.entries(parseJsonObject(value)).map(([key, item]) => {
    if (item && typeof item === "object" && !Array.isArray(item) && Object.hasOwn(item, "value")) return [key, item.value];
    return [key, item];
  }));
}

function numericSummary(value) {
  return Object.fromEntries(Object.entries(parseJsonObject(value)).flatMap(([key, raw]) => {
    const number = Number(raw);
    return Number.isFinite(number) ? [[key, number]] : [];
  }));
}

function graphqlTags(value) {
  if (!Array.isArray(value)) return value;
  return value.map((tag) => typeof tag === "string" ? tag : tag?.name).filter(Boolean);
}

function mapGraphqlRun(node, { entity, project }) {
  const value = asObject(node);
  return mapWandbRun({
    id: value.name ?? value.id,
    displayName: value.displayName ?? value.name,
    entity,
    project,
    state: value.state,
    group: value.group,
    createdAt: value.createdAt,
    updatedAt: value.heartbeatAt ?? value.createdAt,
    config: unwrapConfig(value.config),
    summary: parseJsonObject(value.summaryMetrics),
    tags: graphqlTags(value.tags),
  }, "wandb-live");
}

function refParts(ref, defaults = {}) {
  const parsed = parseExperimentRef(ref);
  if (parsed.provider !== "wandb") throw new AppError("EXPERIMENT_PROVIDER_MISMATCH", "该引用不属于 W&B。", { status: 422 });
  const [entity = defaults.entity, project = defaults.project, ...runParts] = parsed.externalId.split("/");
  const run = runParts.join("/");
  if (!entity || !project || !run) throw new AppError("EXPERIMENT_REF_INVALID", "W&B run 引用必须包含 entity、project 和 run ID。", { status: 422, detail: { ref } });
  return { entity, project, run };
}

function flattenSampledHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => Array.isArray(item) ? item : [item]).filter((item) => item && typeof item === "object");
}

function mapArtifactConnection(connection, direction) {
  return (connection?.edges ?? []).flatMap((edge) => {
    const node = edge?.node;
    if (!node) return [];
    return [{
      ref: `wandb:artifact:${node.id ?? node.name}`,
      externalId: node.id ?? null,
      path: node.name ?? null,
      name: node.name ?? null,
      kind: node.type?.name ?? "artifact",
      digest: node.digest ?? null,
      description: node.description ?? null,
      state: node.state ?? null,
      direction,
      downloadable: true,
    }];
  });
}

function mapWandbArtifact(item, { entity, project, run }) {
  const value = item && typeof item === "object" ? item : { path: String(item) };
  const artifactPath = value.path ?? value.name ?? "artifact";
  return {
    ...value,
    ref: value.ref ?? `wandb:artifact:${entity}/${project}/${run}/${artifactPath}`,
    path: artifactPath,
    kind: value.kind ?? "artifact",
    downloadable: value.downloadable ?? true,
  };
}

export function mapWandbRun(raw, source = "wandb-fixture") {
  const value = asObject(raw);
  const entity = value.entity ?? "local";
  const project = value.project ?? "research";
  const externalId = String(value.id ?? value.runId ?? value.name ?? "unknown");
  const metricHistory = normalizeMetricHistory(value.history ?? value.metricHistory ?? value.series);
  const metrics = { ...Object.fromEntries(Object.entries(metricHistory).filter(([, points]) => points.length).map(([key, points]) => [key, points.at(-1).y])), ...numericSummary(value.summary) };
  const mapped = {
    ref: `wandb:run:${entity}/${project}/${externalId}`,
    provider: "wandb",
    source,
    kind: "run",
    externalId,
    entity,
    project,
    group: value.group ?? value.config?.group ?? "ungrouped",
    label: value.displayName ?? value.name ?? externalId,
    locator: `wandb://${entity}/${project}/${externalId}`,
    status: String(value.state ?? value.status ?? "unknown").toUpperCase(),
    startedAt: toIso(value.createdAt ?? value.startTime),
    endedAt: toIso(value.finishedAt ?? value.endTime),
    observedAt: toIso(value.updatedAt ?? value.finishedAt ?? value.createdAt) ?? new Date().toISOString(),
    params: asObject(value.config),
    tags: Array.isArray(value.tags) ? Object.fromEntries(value.tags.map((tag) => [String(tag), true])) : asObject(value.tags),
    metrics,
    metricHistory,
    metricSummary: metricSummary(metricHistory, metrics),
    artifacts: (Array.isArray(value.artifacts) ? value.artifacts : []).map((item) => mapWandbArtifact(item, { entity, project, run: externalId })),
    inputs: Array.isArray(value.inputs) ? value.inputs : [],
    media: Array.isArray(value.media) ? value.media : [],
    capabilities: {
      structuredRun: { status: "supported" },
      history: { status: "supported", xKey: "step" },
      metricHistory: { status: "supported", xKey: "step" },
      artifacts: { status: "supported" },
      inputs: { status: "supported" },
      inputLineage: { status: "supported" },
      media: { status: "supported", formats: ["image/*", "video/*", "audio/*"] },
      reports: { status: "unavailable", reason: "reports are outside the unified run result contract" },
    },
  };
  return normalizeRun(mapped, {
    provider: "wandb",
    mode: source === "wandb-fixture" ? "fixture" : "live",
    capabilityProfile: { structuredRun: true, history: true, metricHistory: true, artifacts: true, inputs: true, inputLineage: true, media: true, reports: false },
    observedAt: mapped.observedAt,
  });
}

export class WandbAdapter {
  constructor(config) {
    this.config = config;
    this.id = "wandb-local";
    this.lastSnapshot = null;
    this.lastLiveError = null;
  }

  get baseUrl() { return String(this.config.wandb?.baseUrl ?? "").replace(/\/+$/, ""); }

  get graphqlUrl() {
    if (!this.baseUrl) return "";
    return /\/graphql$/i.test(this.baseUrl) ? this.baseUrl : `${this.baseUrl}${this.config.wandb?.graphqlPath ?? "/graphql"}`;
  }

  headers() {
    const headers = { accept: "application/json", "content-type": "application/json" };
    const token = process.env[this.config.wandb?.tokenEnv ?? "WANDB_API_KEY"];
    if (token) {
      const scheme = String(this.config.wandb?.authScheme ?? "basic").toLowerCase();
      headers.authorization = scheme === "bearer"
        ? `Bearer ${token}`
        : `Basic ${Buffer.from(`api:${token}`, "utf8").toString("base64")}`;
    }
    return headers;
  }

  async requestGraphql(query, variables = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(this.config.wandb?.timeoutMs ?? 4_000));
    timer.unref?.();
    try {
      const response = await fetch(this.graphqlUrl, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try { payload = text ? JSON.parse(text) : {}; }
      catch { throw new AppError("WANDB_RESPONSE_INVALID", "W&B GraphQL 返回了无效 JSON。", { status: 503, retryable: true, detail: { providerStatus: response.status } }); }
      if (!response.ok) throw new AppError("WANDB_HTTP_ERROR", `W&B 请求失败：HTTP ${response.status}`, { status: 503, retryable: response.status === 429 || response.status >= 500, detail: { providerStatus: response.status } });
      if (Array.isArray(payload.errors) && payload.errors.length) {
        throw new AppError("WANDB_GRAPHQL_ERROR", "W&B GraphQL 查询失败。", {
          status: 503,
          retryable: false,
          detail: { errors: payload.errors.slice(0, 5).map((item) => ({ message: item.message, path: item.path })) },
        });
      }
      return payload.data ?? {};
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("WANDB_UNREACHABLE", "无法连接 W&B GraphQL API。", { status: 503, retryable: true, detail: { reason: error.name === "AbortError" ? "request timed out" : error.message } });
    } finally { clearTimeout(timer); }
  }

  async fixtureSnapshot(reason = null) {
    const fixture = JSON.parse(await readFile(this.config.wandb.fixtureFile, "utf8"));
    const snapshot = { source: this.id, provider: "wandb", mode: "fixture", degradedReason: reason, observedAt: new Date().toISOString(), project: { entity: fixture.entity ?? "local", name: fixture.project }, runs: (fixture.runs ?? []).map((run) => mapWandbRun({ ...run, entity: run.entity ?? fixture.entity, project: run.project ?? fixture.project }, "wandb-fixture")) };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  async liveSnapshot() {
    const entity = this.config.wandb.entity ?? "";
    const project = this.config.wandb.project ?? "";
    const maximum = Math.min(300, Number(this.config.wandb.maxRuns ?? 300));
    const pageSize = Math.min(100, Number(this.config.wandb.pageSize ?? 100));
    const runs = [];
    let after = null;
    do {
      const payload = await this.requestGraphql(WANDB_RUNS_QUERY, { entity, project, first: Math.min(pageSize, maximum - runs.length), after });
      if (!payload.project) throw new AppError("WANDB_PROJECT_NOT_FOUND", "W&B 中没有找到配置的 project。", { status: 404, detail: { entity, project } });
      const connection = payload.project.runs ?? {};
      runs.push(...(connection.edges ?? []).flatMap((edge) => edge?.node ? [mapGraphqlRun(edge.node, { entity, project })] : []));
      after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after && runs.length < maximum);
    const snapshot = { source: this.id, provider: "wandb", mode: "live", degradedReason: null, observedAt: new Date().toISOString(), project: { entity, name: project }, runs: runs.slice(0, maximum) };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  async health() {
    const checkedAt = new Date().toISOString();
    if (!this.baseUrl) return { status: "ready", detail: "fixture dataset ready; W&B API not configured", checkedAt };
    try { await this.requestGraphql(WANDB_HEALTH_QUERY); return { status: "ready", detail: `live · ${this.graphqlUrl}`, checkedAt }; }
    catch (error) { this.lastLiveError = error; return { status: "degraded", detail: `${error.message}; fixture fallback available`, checkedAt }; }
  }

  async descriptor() {
    const health = await this.health();
    const capability = capabilityProfileWithDetails({ structuredRun: true, history: true, metricHistory: true, artifacts: true, inputs: true, inputLineage: true, media: true, reports: false }, {
      reports: { status: "unavailable", reason: "reports are outside the unified run result contract" },
    });
    return { id: this.id, kind: "source", provider: "wandb", contract: "experiment-provider.v1", label: "Weights & Biases", mode: this.baseUrl && health.status === "ready" ? "live" : "fixture", capabilities: ["health", "run-search", "run-detail", "metric-history", "artifacts", "media", "agent-context"], capabilityProfile: capability.capabilityProfile, capabilityDetails: capability.capabilities, health };
  }

  async listExperiments({ limit = 100 } = {}) {
    const snapshot = this.lastSnapshot ?? await this.snapshot();
    // W&B's project is the closest stable experiment boundary. The run-level
    // contract remains authoritative; this method never invents run metadata.
    const project = snapshot.project ?? { entity: this.config.wandb?.entity, name: this.config.wandb?.project };
    return {
      items: project?.name ? [{ id: `${project.entity ?? "local"}/${project.name}`, name: project.name, entity: project.entity ?? null, provider: "wandb", kind: "project" }] : [],
      nextCursor: null,
      sourceStatus: snapshot.degradedReason ? "degraded" : "ready",
      mode: snapshot.mode,
      observedAt: snapshot.observedAt,
      limit,
    };
  }

  async snapshot() {
    if (!this.baseUrl) return this.fixtureSnapshot();
    try { return await this.liveSnapshot(); } catch (error) { this.lastLiveError = error; return this.fixtureSnapshot(error.message); }
  }

  async listRuns({ limit = 100, group = null, status = null } = {}) {
    const snapshot = this.lastSnapshot ?? await this.snapshot();
    let runs = snapshot.runs ?? [];
    if (group) runs = runs.filter((run) => run.group === group);
    if (status) runs = runs.filter((run) => String(run.status).toLowerCase() === String(status).toLowerCase());
    return { items: runs.slice(0, Math.min(300, Number(limit) || 100)), nextCursor: null, sourceStatus: snapshot.degradedReason ? "degraded" : "ready", mode: snapshot.mode, observedAt: snapshot.observedAt };
  }

  async getRun(ref) {
    const parts = refParts(ref, this.config.wandb);
    const snapshot = this.lastSnapshot ?? await this.snapshot();
    let run = snapshot.runs?.find((item) => item.ref === ref || (item.externalId === parts.run && item.entity === parts.entity && item.project === parts.project));
    if (!run && this.baseUrl) {
      const payload = await this.requestGraphql(WANDB_RUN_QUERY, parts);
      if (payload.project?.run) run = mapGraphqlRun(payload.project.run, { entity: parts.entity, project: parts.project });
    }
    if (!run) throw new AppError("EXPERIMENT_REF_NOT_FOUND", "没有找到对应的实验 run。", { status: 404, detail: { ref } });
    return { schemaVersion: "experiment-detail.v1", run, source: { provider: "wandb", mode: snapshot.mode, degradedReason: snapshot.degradedReason ?? null, observedAt: snapshot.observedAt } };
  }

  async getSeries(ref, { metricKeys = [], maxPoints = 240 } = {}) {
    const detail = await this.getRun(ref);
    let history = detail.run.metricHistory ?? {};
    const wanted = metricKeys.length ? metricKeys : Object.keys(history).length ? Object.keys(history) : Object.keys(detail.run.metrics ?? {});
    if (this.baseUrl && wanted.some((key) => !(history[key]?.length))) {
      try {
        const parts = refParts(ref, this.config.wandb);
        const specs = [JSON.stringify({ keys: wanted, samples: Math.min(2_000, Math.max(maxPoints * 4, 240)) })];
        const payload = await this.requestGraphql(WANDB_HISTORY_QUERY, { ...parts, specs });
        const sampled = flattenSampledHistory(payload.project?.run?.sampledHistory);
        if (sampled.length) history = normalizeMetricHistory(sampled);
      } catch { /* preserve known fixture/history */ }
    }
    return { schemaVersion: "experiment-series.v1", ref: detail.run.ref, provider: "wandb", sourceStatus: detail.source.degradedReason ? "degraded" : "ready", observedAt: detail.source.observedAt, series: normalizeSeries(history, { metricKeys: wanted, maxPoints }) };
  }

  async listArtifacts(ref) {
    const detail = await this.getRun(ref);
    let items = detail.run.artifacts ?? [];
    if (this.baseUrl && detail.source.mode === "live") {
      try {
        const parts = refParts(ref, this.config.wandb);
        const payload = await this.requestGraphql(WANDB_ARTIFACTS_QUERY, { ...parts, first: 100 });
        const run = payload.project?.run;
        items = [
          ...mapArtifactConnection(run?.outputArtifacts, "output"),
          ...mapArtifactConnection(run?.inputArtifacts, "input"),
        ];
      } catch { /* retain artifact metadata already observed on the run */ }
    }
    return { items, sourceStatus: detail.source.degradedReason ? "degraded" : "ready" };
  }
}
