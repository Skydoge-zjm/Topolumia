import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { AppError } from "../../lib/errors.js";
import { isPathInside } from "../../adapters/sources/filesystem-adapter.js";

export const USER_SETTINGS_SCHEMA_VERSION = "workbench-user-settings.v1";

const MODEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:/@+~-]{0,159}$/u;
const SAFE_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._:/@+~\-]{0,159}$/u;
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];
const APPROVAL_POLICIES = ["never", "on-request"];

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isObject(override)) return clone(base);
  const result = isObject(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(override)) {
    result[key] = isObject(value) ? deepMerge(result[key], value) : clone(value);
  }
  return result;
}

function number(value, fallback, min, max, field, integer = true) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < min || parsed > max) {
    throw new AppError("USER_SETTINGS_INVALID", `${field} 必须是 ${min} 到 ${max} 之间的${integer ? "整数" : "数字"}。`, { status: 422, detail: { field, value, min, max } });
  }
  return parsed;
}

function text(value, fallback, field, { max = 240, pattern = null, allowEmpty = false } = {}) {
  const result = String(value ?? fallback ?? "").trim();
  if (!allowEmpty && !result) throw new AppError("USER_SETTINGS_INVALID", `${field} 不能为空。`, { status: 422, detail: { field } });
  if (result.length > max || (pattern && result && !pattern.test(result))) {
    throw new AppError("USER_SETTINGS_INVALID", `${field} 格式或长度无效。`, { status: 422, detail: { field, max } });
  }
  return result;
}

function bool(value, fallback) {
  if (value === undefined) return Boolean(fallback);
  if (typeof value !== "boolean") throw new AppError("USER_SETTINGS_INVALID", "布尔设置值无效。", { status: 422 });
  return value;
}

function enumValue(value, fallback, allowed, field) {
  const result = value ?? fallback;
  if (!allowed.includes(result)) throw new AppError("USER_SETTINGS_INVALID", `${field} 不在允许范围内。`, { status: 422, detail: { field, allowed } });
  return result;
}

function endpoint(value, fallback, field) {
  const result = text(value, fallback, field, { max: 500, allowEmpty: true });
  if (!result) return "";
  let parsed;
  try { parsed = new URL(result); } catch {
    throw new AppError("USER_SETTINGS_INVALID", `${field} 必须是 http(s) URL。`, { status: 422, detail: { field } });
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AppError("USER_SETTINGS_INVALID", `${field} 只能包含不带凭据和查询参数的 http(s) URL。`, { status: 422, detail: { field } });
  }
  return parsed.toString().replace(/\/$/, "");
}

function relativePath(value, fallback, config, field, { allowEmpty = false } = {}) {
  const result = text(value, fallback, field, { max: 500, allowEmpty });
  if (!result) return "";
  const resolved = path.resolve(config.project.root, result);
  if (!isPathInside(config.project.root, resolved)) {
    throw new AppError("USER_SETTINGS_PATH_OUTSIDE_PROJECT", `${field} 必须位于项目根目录内。`, { status: 422, detail: { field } });
  }
  return path.relative(config.project.root, resolved).split(path.sep).join("/") || ".";
}

function relativeRoots(values, fallback, config) {
  if (values === undefined) values = fallback;
  if (!Array.isArray(values) || values.length < 1 || values.length > 20) {
    throw new AppError("USER_SETTINGS_INVALID", "filesystem roots 必须包含 1 到 20 个目录。", { status: 422 });
  }
  return [...new Set(values.map((value, index) => relativePath(value, null, config, `sources.filesystem.roots[${index}]`)))];
}

function profileDefaults(config) {
  const profiles = config.agentSessions?.profiles ?? [];
  const profileModels = {};
  for (const profile of profiles) if (profile.model) profileModels[profile.id] = profile.model;
  const preferred = profiles.find((profile) => profile.id === "codex-acp") ?? profiles.find((profile) => profile.provider === "codex") ?? profiles.find((profile) => profile.source !== "bundled") ?? profiles[0];
  return { profileIds: profiles.map((profile) => profile.id), profileModels, defaultProfileId: preferred?.id ?? "" };
}

export function defaultUserSettings(config) {
  const profile = profileDefaults(config);
  const relativeRoot = (root) => path.relative(config.project.root, root).split(path.sep).join("/") || ".";
  return {
    schemaVersion: USER_SETTINGS_SCHEMA_VERSION,
    workspaceRevision: config.project.workspace?.revision ?? 0,
    interface: {
      locale: "zh",
      topologyLayout: "elk",
      topologyView: "global",
    },
    project: {
      name: config.project.name,
    },
    agent: {
      defaultProfileId: profile.defaultProfileId,
      profileModels: profile.profileModels,
      reasoningEffort: "low",
      approvalPolicy: config.agentSessions?.profiles?.find((item) => item.provider === "codex")?.approvalPolicy ?? "on-request",
      sandbox: config.agentSessions?.profiles?.find((item) => item.provider === "codex")?.sandbox ?? "workspace-write",
      maxSessions: config.agentSessions?.maxSessions ?? 50,
      maxEventsPerSession: config.agentSessions?.maxEventsPerSession ?? 1_000,
    },
    curator: {
      enabled: config.curator?.enabled ?? true,
      model: config.curator?.model ?? "gpt-6-luna",
      reasoningEffort: "low",
      timeoutSeconds: Math.round((config.curator?.timeoutMs ?? 300_000) / 1_000),
      maxOutputMb: Math.max(1, Math.round((config.curator?.maxOutputBytes ?? 4_194_304) / 1_048_576)),
      maxEvents: config.curator?.maxEvents ?? 120,
      maxNodes: config.curator?.maxNodes ?? 180,
      maxSources: config.curator?.maxSources ?? 100,
      maxExcerptChars: config.curator?.maxExcerptChars ?? 14_000,
      automation: {
        enabled: config.curator?.automation?.enabled ?? false,
        triggerOnSessionCheckpoint: config.curator?.automation?.triggerOnSessionCheckpoint ?? true,
        triggerOnSourceDelta: config.curator?.automation?.triggerOnSourceDelta ?? true,
        triggerOnExperimentDelta: config.curator?.automation?.triggerOnExperimentDelta ?? true,
        triggerOnIdle: config.curator?.automation?.triggerOnIdle ?? true,
        triggerOnContinuityBreak: config.curator?.automation?.triggerOnContinuityBreak ?? true,
        triggerOnTopologyChanged: config.curator?.automation?.triggerOnTopologyChanged ?? false,
        idleSeconds: config.curator?.automation?.idleSeconds ?? 900,
        minPendingEvents: config.curator?.automation?.minPendingEvents ?? 3,
        cooldownSeconds: config.curator?.automation?.cooldownSeconds ?? 300,
        backgroundMode: config.curator?.automation?.backgroundMode === "background" ? "background" : "suggested",
      },
    },
    sourceRefresh: {
      enabled: config.sourceRefresh?.enabled ?? true,
      intervalSeconds: Math.round((config.sourceRefresh?.intervalMs ?? 60_000) / 1_000),
      freshForSeconds: Math.round((config.sourceRefresh?.freshForMs ?? 15_000) / 1_000),
      foregroundThresholdSeconds: Math.round((config.sourceRefresh?.foregroundThresholdMs ?? 30_000) / 1_000),
    },
    git: {
      timeoutSeconds: Math.round((config.git?.timeoutMs ?? 5_000) / 1_000),
      maxOutputMb: Math.max(1, Math.round((config.git?.maxOutputBytes ?? 1_048_576) / 1_048_576)),
    },
    sources: {
      filesystem: {
        roots: (config.filesystem?.roots ?? []).map(relativeRoot),
        allowedExtensions: config.filesystem?.allowedExtensions ?? [".md", ".txt", ".yaml", ".yml", ".json", ".py"],
        maxFiles: config.filesystem?.maxFiles ?? 80,
        maxDepth: config.filesystem?.maxDepth ?? 4,
        maxTextBytes: config.filesystem?.maxTextBytes ?? 65_536,
        excerptChars: config.filesystem?.excerptChars ?? 1_800,
      },
      mlflow: {
        baseUrl: config.mlflow?.baseUrl ?? "",
        tokenEnv: config.mlflow?.tokenEnv ?? "MLFLOW_TRACKING_TOKEN",
        experimentId: config.mlflow?.experimentId ?? "",
        experimentName: config.mlflow?.experimentName ?? "",
        timeoutSeconds: Math.round((config.mlflow?.timeoutMs ?? 4_000) / 1_000),
        pageSize: config.mlflow?.pageSize ?? 100,
        maxRuns: config.mlflow?.maxRuns ?? 300,
      },
      wandb: {
        baseUrl: config.wandb?.baseUrl ?? "",
        tokenEnv: config.wandb?.tokenEnv ?? "WANDB_API_KEY",
        entity: config.wandb?.entity ?? "",
        project: config.wandb?.project ?? "",
        timeoutSeconds: Math.round((config.wandb?.timeoutMs ?? 4_000) / 1_000),
        pageSize: config.wandb?.pageSize ?? 100,
        maxRuns: config.wandb?.maxRuns ?? 300,
      },
      tensorboard: {
        pythonCommand: config.tensorboard?.pythonCommand ?? "python",
        logdir: config.tensorboard?.logdir ? relativePath(config.tensorboard.logdir, "", config, "sources.tensorboard.logdir", { allowEmpty: true }) : "",
        parserTimeoutSeconds: Math.round((config.tensorboard?.parserTimeoutMs ?? 10_000) / 1_000),
        maxDepth: config.tensorboard?.maxDepth ?? 4,
        maxRuns: config.tensorboard?.maxRuns ?? 300,
      },
    },
    researchEnvironment: { kind: "default", prefix: "", pythonCommand: "python", ...config.researchEnvironment },
    researchLocation: config.project.workspace?.kind === "ssh" ? "ssh" : "local",
    remoteEnvironment: null,
    tools: Object.fromEntries(Object.entries({ conda: "conda", uv: "uv", nvidia: "nvidia-smi", cuda: "nvcc" }).map(([id, command]) => [id, { command: config.toolCommands?.[id] ?? command }])),
    execution: {
      dockerEnabled: config.docker?.executionEnabled ?? false,
      dockerHealthTimeoutSeconds: Math.round((config.docker?.healthTimeoutMs ?? 5_000) / 1_000),
      dockerRunTimeoutSeconds: Math.round((config.docker?.runTimeoutMs ?? 20_000) / 1_000),
    },
    experimentGateway: {
      listTtlSeconds: Math.round((config.experimentGateway?.listTtlMs ?? 15_000) / 1_000),
      detailTtlSeconds: Math.round((config.experimentGateway?.detailTtlMs ?? 30_000) / 1_000),
      seriesTtlSeconds: Math.round((config.experimentGateway?.seriesTtlMs ?? 30_000) / 1_000),
      contextTtlSeconds: Math.round((config.experimentGateway?.contextTtlMs ?? 30_000) / 1_000),
      descriptorTtlSeconds: Math.round((config.experimentGateway?.descriptorTtlMs ?? 30_000) / 1_000),
      maxListRuns: config.experimentGateway?.maxListRuns ?? 300,
      maxCacheEntries: config.experimentGateway?.maxCacheEntries ?? 256,
      maxIngestionRuns: config.experimentGateway?.maxIngestionRuns ?? 32,
      maxIngestionEventsPerRun: config.experimentGateway?.maxIngestionEventsPerRun ?? 300_000,
      maxIngestionBatchEvents: config.experimentGateway?.maxIngestionBatchEvents ?? 300_000,
    },
    simulation: {
      totalSteps: 50_000,
      logEvery: 100,
      batchSteps: 500,
      seed: 42,
      group: "G1",
      runId: "sr3-g1-seed42",
      conditioning: "degradation_encoder",
      noiseSchedule: "baseline",
      dataset: "DIV2K-valid-x4",
    },
  };
}

export function normalizeUserSettings(input, config, base = defaultUserSettings(config)) {
  const merged = deepMerge(base, input ?? {});
  const workspaceRevision = config.project.workspace?.revision ?? 0;
  if ((merged.workspaceRevision ?? 0) !== workspaceRevision) {
    merged.researchLocation = config.project.workspace?.kind === "ssh" ? "ssh" : "local";
    merged.remoteEnvironment = null;
    merged.researchEnvironment = { kind: "default", prefix: "", pythonCommand: "python", ...config.researchEnvironment };
    merged.sources ??= {}; merged.sources.filesystem ??= {}; merged.sources.filesystem.roots = ["."];
  }
  const profiles = profileDefaults(config);
  const result = defaultUserSettings(config);
  result.interface = {
    locale: enumValue(merged.interface?.locale, result.interface.locale, ["zh", "en"], "interface.locale"),
    topologyLayout: enumValue(merged.interface?.topologyLayout, result.interface.topologyLayout, ["elk", "force", "base"], "interface.topologyLayout"),
    topologyView: enumValue(merged.interface?.topologyView, result.interface.topologyView, ["global", "question", "experiments"], "interface.topologyView"),
  };
  result.project.name = text(merged.project?.name, result.project.name, "project.name", { max: 120, pattern: SAFE_NAME_PATTERN });
  result.agent = {
    defaultProfileId: enumValue(merged.agent?.defaultProfileId, profiles.defaultProfileId, profiles.profileIds, "agent.defaultProfileId"),
    profileModels: {},
    reasoningEffort: enumValue(merged.agent?.reasoningEffort, result.agent.reasoningEffort, EFFORTS, "agent.reasoningEffort"),
    approvalPolicy: enumValue(merged.agent?.approvalPolicy, result.agent.approvalPolicy, APPROVAL_POLICIES, "agent.approvalPolicy"),
    sandbox: enumValue(merged.agent?.sandbox, result.agent.sandbox, SANDBOXES, "agent.sandbox"),
    maxSessions: number(merged.agent?.maxSessions, result.agent.maxSessions, 1, 200, "agent.maxSessions"),
    maxEventsPerSession: number(merged.agent?.maxEventsPerSession, result.agent.maxEventsPerSession, 100, 20_000, "agent.maxEventsPerSession"),
  };
  for (const profileId of profiles.profileIds) {
    const current = result.agent.profileModels[profileId] ?? config.agentSessions.profiles.find((profile) => profile.id === profileId)?.model ?? "";
    const provided = merged.agent?.profileModels?.[profileId];
    result.agent.profileModels[profileId] = provided === undefined && !current ? "" : text(provided, current, `agent.profileModels.${profileId}`, { max: 160, pattern: MODEL_PATTERN, allowEmpty: true });
  }
  result.curator = {
    enabled: bool(merged.curator?.enabled, result.curator.enabled),
    model: text(merged.curator?.model, result.curator.model, "curator.model", { max: 160, pattern: MODEL_PATTERN }),
    reasoningEffort: enumValue(merged.curator?.reasoningEffort, result.curator.reasoningEffort, EFFORTS, "curator.reasoningEffort"),
    timeoutSeconds: number(merged.curator?.timeoutSeconds, result.curator.timeoutSeconds, 30, 3_600, "curator.timeoutSeconds"),
    maxOutputMb: number(merged.curator?.maxOutputMb, result.curator.maxOutputMb, 1, 64, "curator.maxOutputMb"),
    maxEvents: number(merged.curator?.maxEvents, result.curator.maxEvents, 10, 1_000, "curator.maxEvents"),
    maxNodes: number(merged.curator?.maxNodes, result.curator.maxNodes, 10, 1_000, "curator.maxNodes"),
    maxSources: number(merged.curator?.maxSources, result.curator.maxSources, 1, 500, "curator.maxSources"),
    maxExcerptChars: number(merged.curator?.maxExcerptChars, result.curator.maxExcerptChars, 500, 100_000, "curator.maxExcerptChars"),
    automation: {
      enabled: bool(merged.curator?.automation?.enabled, result.curator.automation.enabled),
      triggerOnSessionCheckpoint: bool(merged.curator?.automation?.triggerOnSessionCheckpoint, result.curator.automation.triggerOnSessionCheckpoint),
      triggerOnSourceDelta: bool(merged.curator?.automation?.triggerOnSourceDelta, result.curator.automation.triggerOnSourceDelta),
      triggerOnExperimentDelta: bool(merged.curator?.automation?.triggerOnExperimentDelta, result.curator.automation.triggerOnExperimentDelta),
      triggerOnIdle: bool(merged.curator?.automation?.triggerOnIdle, result.curator.automation.triggerOnIdle),
      triggerOnContinuityBreak: bool(merged.curator?.automation?.triggerOnContinuityBreak, result.curator.automation.triggerOnContinuityBreak),
      triggerOnTopologyChanged: bool(merged.curator?.automation?.triggerOnTopologyChanged, result.curator.automation.triggerOnTopologyChanged),
      idleSeconds: number(merged.curator?.automation?.idleSeconds, result.curator.automation.idleSeconds, 30, 86_400, "curator.automation.idleSeconds"),
      minPendingEvents: number(merged.curator?.automation?.minPendingEvents, result.curator.automation.minPendingEvents, 1, 240, "curator.automation.minPendingEvents"),
      cooldownSeconds: number(merged.curator?.automation?.cooldownSeconds, result.curator.automation.cooldownSeconds, 0, 86_400, "curator.automation.cooldownSeconds"),
      backgroundMode: enumValue(merged.curator?.automation?.backgroundMode, result.curator.automation.backgroundMode, ["suggested", "background"], "curator.automation.backgroundMode"),
    },
  };
  result.sourceRefresh = {
    enabled: bool(merged.sourceRefresh?.enabled, result.sourceRefresh.enabled),
    intervalSeconds: number(merged.sourceRefresh?.intervalSeconds, result.sourceRefresh.intervalSeconds, 30, 86_400, "sourceRefresh.intervalSeconds"),
    freshForSeconds: number(merged.sourceRefresh?.freshForSeconds, result.sourceRefresh.freshForSeconds, 0, 3_600, "sourceRefresh.freshForSeconds"),
    foregroundThresholdSeconds: number(merged.sourceRefresh?.foregroundThresholdSeconds, result.sourceRefresh.foregroundThresholdSeconds, 0, 3_600, "sourceRefresh.foregroundThresholdSeconds"),
  };
  result.git = {
    timeoutSeconds: number(merged.git?.timeoutSeconds, result.git.timeoutSeconds, 1, 120, "git.timeoutSeconds"),
    maxOutputMb: number(merged.git?.maxOutputMb, result.git.maxOutputMb, 1, 64, "git.maxOutputMb"),
  };
  const fs = merged.sources?.filesystem ?? {};
  result.sources.filesystem = {
    roots: relativeRoots(fs.roots, result.sources.filesystem.roots, config),
    allowedExtensions: Array.isArray(fs.allowedExtensions) ? [...new Set(fs.allowedExtensions.map((value, index) => text(value, null, `sources.filesystem.allowedExtensions[${index}]`, { max: 12, pattern: /^\.[a-z0-9]{1,10}$/i })))] : result.sources.filesystem.allowedExtensions,
    maxFiles: number(fs.maxFiles, result.sources.filesystem.maxFiles, 1, 2_000, "sources.filesystem.maxFiles"),
    maxDepth: number(fs.maxDepth, result.sources.filesystem.maxDepth, 1, 20, "sources.filesystem.maxDepth"),
    maxTextBytes: number(fs.maxTextBytes, result.sources.filesystem.maxTextBytes, 1_024, 10_485_760, "sources.filesystem.maxTextBytes"),
    excerptChars: number(fs.excerptChars, result.sources.filesystem.excerptChars, 100, 50_000, "sources.filesystem.excerptChars"),
  };
  result.sources.mlflow = {
    baseUrl: endpoint(merged.sources?.mlflow?.baseUrl, result.sources.mlflow.baseUrl, "sources.mlflow.baseUrl"),
    tokenEnv: text(merged.sources?.mlflow?.tokenEnv, result.sources.mlflow.tokenEnv, "sources.mlflow.tokenEnv", { max: 120, pattern: /^[A-Za-z_][A-Za-z0-9_]*$/ }),
    experimentId: text(merged.sources?.mlflow?.experimentId, result.sources.mlflow.experimentId, "sources.mlflow.experimentId", { max: 120, pattern: /^[A-Za-z0-9_.:-]*$/, allowEmpty: true }),
    experimentName: text(merged.sources?.mlflow?.experimentName, result.sources.mlflow.experimentName, "sources.mlflow.experimentName", { max: 160, pattern: SAFE_NAME_PATTERN }),
    timeoutSeconds: number(merged.sources?.mlflow?.timeoutSeconds, result.sources.mlflow.timeoutSeconds, 1, 120, "sources.mlflow.timeoutSeconds"),
    pageSize: number(merged.sources?.mlflow?.pageSize, result.sources.mlflow.pageSize, 1, 500, "sources.mlflow.pageSize"),
    maxRuns: number(merged.sources?.mlflow?.maxRuns, result.sources.mlflow.maxRuns, 1, 2_000, "sources.mlflow.maxRuns"),
  };
  result.sources.wandb = {
    baseUrl: endpoint(merged.sources?.wandb?.baseUrl, result.sources.wandb.baseUrl, "sources.wandb.baseUrl"),
    tokenEnv: text(merged.sources?.wandb?.tokenEnv, result.sources.wandb.tokenEnv, "sources.wandb.tokenEnv", { max: 120, pattern: /^[A-Za-z_][A-Za-z0-9_]*$/ }),
    entity: text(merged.sources?.wandb?.entity, result.sources.wandb.entity, "sources.wandb.entity", { max: 120, pattern: SAFE_NAME_PATTERN }),
    project: text(merged.sources?.wandb?.project, result.sources.wandb.project, "sources.wandb.project", { max: 160, pattern: SAFE_NAME_PATTERN }),
    timeoutSeconds: number(merged.sources?.wandb?.timeoutSeconds, result.sources.wandb.timeoutSeconds, 1, 120, "sources.wandb.timeoutSeconds"),
    pageSize: number(merged.sources?.wandb?.pageSize, result.sources.wandb.pageSize, 1, 500, "sources.wandb.pageSize"),
    maxRuns: number(merged.sources?.wandb?.maxRuns, result.sources.wandb.maxRuns, 1, 2_000, "sources.wandb.maxRuns"),
  };
  result.sources.tensorboard = {
    pythonCommand: text(merged.sources?.tensorboard?.pythonCommand, result.sources.tensorboard.pythonCommand, "sources.tensorboard.pythonCommand", { max: 500 }),
    logdir: relativePath(merged.sources?.tensorboard?.logdir, result.sources.tensorboard.logdir, config, "sources.tensorboard.logdir", { allowEmpty: true }),
    parserTimeoutSeconds: number(merged.sources?.tensorboard?.parserTimeoutSeconds, result.sources.tensorboard.parserTimeoutSeconds, 1, 300, "sources.tensorboard.parserTimeoutSeconds"),
    maxDepth: number(merged.sources?.tensorboard?.maxDepth, result.sources.tensorboard.maxDepth, 1, 20, "sources.tensorboard.maxDepth"),
    maxRuns: number(merged.sources?.tensorboard?.maxRuns, result.sources.tensorboard.maxRuns, 1, 2_000, "sources.tensorboard.maxRuns"),
  };
  result.execution = {
    dockerEnabled: bool(merged.execution?.dockerEnabled, result.execution.dockerEnabled),
    dockerHealthTimeoutSeconds: number(merged.execution?.dockerHealthTimeoutSeconds, result.execution.dockerHealthTimeoutSeconds, 1, 300, "execution.dockerHealthTimeoutSeconds"),
    dockerRunTimeoutSeconds: number(merged.execution?.dockerRunTimeoutSeconds, result.execution.dockerRunTimeoutSeconds, 1, 86_400, "execution.dockerRunTimeoutSeconds"),
  };
  result.tools = Object.fromEntries(["conda", "uv", "nvidia", "cuda"].map(id => [id, {
    command: text(merged.tools?.[id]?.command, result.tools[id].command, `tools.${id}.command`, { max: 500 }),
  }]));
  result.researchEnvironment = {
    kind: enumValue(merged.researchEnvironment?.kind, "default", ["default", "conda", "custom"], "researchEnvironment.kind"),
    prefix: text(merged.researchEnvironment?.prefix, "", "researchEnvironment.prefix", { max: 500, allowEmpty: true }),
    pythonCommand: text(merged.researchEnvironment?.pythonCommand, "python", "researchEnvironment.pythonCommand", { max: 500 }),
  };
  result.researchLocation = enumValue(merged.researchLocation, "local", ["local", "ssh"], "researchLocation");
  if (merged.remoteEnvironment !== null && merged.remoteEnvironment !== undefined) {
    const remote = merged.remoteEnvironment;
    result.remoteEnvironment = Object.fromEntries(["ownerId", "connectionId", "environmentId", "name", "source", "prefix", "pythonCommand", "hostLabel"].map(key => [key, text(remote[key], "", `remoteEnvironment.${key}`, { max: 600 })]));
    result.remoteEnvironment.revision = number(remote.revision, 1, 1, 1000000, "remoteEnvironment.revision");
  }
  if (result.researchLocation === "ssh" && !result.remoteEnvironment && config.project.workspace?.kind !== "ssh") throw new AppError("USER_SETTINGS_INVALID", "远程环境引用不完整。", { status: 422 });
  if (result.researchEnvironment.kind === "conda" && !path.isAbsolute(result.researchEnvironment.prefix)) {
    throw new AppError("USER_SETTINGS_INVALID", "Conda 环境必须使用完整目录路径。", { status: 422 });
  }
  const gateway = merged.experimentGateway ?? {};
  result.experimentGateway = {
    listTtlSeconds: number(gateway.listTtlSeconds, result.experimentGateway.listTtlSeconds, 1, 86_400, "experimentGateway.listTtlSeconds"),
    detailTtlSeconds: number(gateway.detailTtlSeconds, result.experimentGateway.detailTtlSeconds, 1, 86_400, "experimentGateway.detailTtlSeconds"),
    seriesTtlSeconds: number(gateway.seriesTtlSeconds, result.experimentGateway.seriesTtlSeconds, 1, 86_400, "experimentGateway.seriesTtlSeconds"),
    contextTtlSeconds: number(gateway.contextTtlSeconds, result.experimentGateway.contextTtlSeconds, 1, 86_400, "experimentGateway.contextTtlSeconds"),
    descriptorTtlSeconds: number(gateway.descriptorTtlSeconds, result.experimentGateway.descriptorTtlSeconds, 1, 86_400, "experimentGateway.descriptorTtlSeconds"),
    maxListRuns: number(gateway.maxListRuns, result.experimentGateway.maxListRuns, 1, 2_000, "experimentGateway.maxListRuns"),
    maxCacheEntries: number(gateway.maxCacheEntries, result.experimentGateway.maxCacheEntries, 16, 5_000, "experimentGateway.maxCacheEntries"),
    maxIngestionRuns: number(gateway.maxIngestionRuns, result.experimentGateway.maxIngestionRuns, 1, 200, "experimentGateway.maxIngestionRuns"),
    maxIngestionEventsPerRun: number(gateway.maxIngestionEventsPerRun, result.experimentGateway.maxIngestionEventsPerRun, 1_000, 1_000_000, "experimentGateway.maxIngestionEventsPerRun"),
    maxIngestionBatchEvents: number(gateway.maxIngestionBatchEvents, result.experimentGateway.maxIngestionBatchEvents, 1_000, 1_000_000, "experimentGateway.maxIngestionBatchEvents"),
  };
  const simulation = merged.simulation ?? {};
  result.simulation = {
    totalSteps: number(simulation.totalSteps, result.simulation.totalSteps, 10, 100_000, "simulation.totalSteps"),
    logEvery: number(simulation.logEvery, result.simulation.logEvery, 1, 100_000, "simulation.logEvery"),
    batchSteps: number(simulation.batchSteps, result.simulation.batchSteps, 1, 10_000, "simulation.batchSteps"),
    seed: number(simulation.seed, result.simulation.seed, 0, 1_000_000_000, "simulation.seed"),
    group: text(simulation.group, result.simulation.group, "simulation.group", { max: 80, pattern: SAFE_NAME_PATTERN }),
    runId: text(simulation.runId, result.simulation.runId, "simulation.runId", { max: 120, pattern: /^[A-Za-z0-9_-]+$/ }),
    conditioning: text(simulation.conditioning, result.simulation.conditioning, "simulation.conditioning", { max: 120, pattern: SAFE_NAME_PATTERN }),
    noiseSchedule: text(simulation.noiseSchedule, result.simulation.noiseSchedule, "simulation.noiseSchedule", { max: 120, pattern: SAFE_NAME_PATTERN }),
    dataset: text(simulation.dataset, result.simulation.dataset, "simulation.dataset", { max: 160, pattern: SAFE_NAME_PATTERN }),
  };
  if (result.sourceRefresh.freshForSeconds > result.sourceRefresh.intervalSeconds) {
    throw new AppError("USER_SETTINGS_INVALID", "来源 freshness window 不能大于自动检查间隔。", { status: 422 });
  }
  if (result.simulation.logEvery > result.simulation.totalSteps) {
    throw new AppError("USER_SETTINGS_INVALID", "simulation.logEvery 不能大于 totalSteps。", { status: 422 });
  }
  result.schemaVersion = USER_SETTINGS_SCHEMA_VERSION;
  return result;
}

export function applyUserSettings(config, settings) {
  config.researchEnvironment = { ...settings.researchEnvironment };
  config.toolCommands = Object.fromEntries(Object.entries(settings.tools).map(([id, tool]) => [id, tool.command]));
  config.project.name = settings.project.name;
  config.sourceRefresh.enabled = settings.sourceRefresh.enabled;
  config.sourceRefresh.intervalMs = settings.sourceRefresh.intervalSeconds * 1_000;
  config.sourceRefresh.freshForMs = settings.sourceRefresh.freshForSeconds * 1_000;
  config.sourceRefresh.foregroundThresholdMs = settings.sourceRefresh.foregroundThresholdSeconds * 1_000;
  config.git.timeoutMs = settings.git.timeoutSeconds * 1_000;
  config.git.maxOutputBytes = settings.git.maxOutputMb * 1_048_576;

  config.filesystem.roots = settings.sources.filesystem.roots.map((root) => path.resolve(config.project.root, root));
  config.filesystem.allowedExtensions = [...settings.sources.filesystem.allowedExtensions];
  config.filesystem.maxFiles = settings.sources.filesystem.maxFiles;
  config.filesystem.maxDepth = settings.sources.filesystem.maxDepth;
  config.filesystem.maxTextBytes = settings.sources.filesystem.maxTextBytes;
  config.filesystem.excerptChars = settings.sources.filesystem.excerptChars;

  config.mlflow.baseUrl = settings.sources.mlflow.baseUrl;
  config.mlflow.tokenEnv = settings.sources.mlflow.tokenEnv;
  config.mlflow.experimentId = settings.sources.mlflow.experimentId;
  config.mlflow.experimentName = settings.sources.mlflow.experimentName;
  config.mlflow.timeoutMs = settings.sources.mlflow.timeoutSeconds * 1_000;
  config.mlflow.pageSize = settings.sources.mlflow.pageSize;
  config.mlflow.maxRuns = settings.sources.mlflow.maxRuns;
  config.wandb.baseUrl = settings.sources.wandb.baseUrl;
  config.wandb.tokenEnv = settings.sources.wandb.tokenEnv;
  config.wandb.entity = settings.sources.wandb.entity;
  config.wandb.project = settings.sources.wandb.project;
  config.wandb.timeoutMs = settings.sources.wandb.timeoutSeconds * 1_000;
  config.wandb.pageSize = settings.sources.wandb.pageSize;
  config.wandb.maxRuns = settings.sources.wandb.maxRuns;
  config.tensorboard.logdir = settings.sources.tensorboard.logdir ? path.resolve(config.project.root, settings.sources.tensorboard.logdir) : "";
  config.tensorboard.pythonCommand = settings.sources.tensorboard.pythonCommand;
  config.tensorboard.parserTimeoutMs = settings.sources.tensorboard.parserTimeoutSeconds * 1_000;
  config.tensorboard.maxDepth = settings.sources.tensorboard.maxDepth;
  config.tensorboard.maxRuns = settings.sources.tensorboard.maxRuns;
  config.curator.enabled = settings.curator.enabled;
  config.curator.model = settings.curator.model;
  config.curator.reasoningEffort = settings.curator.reasoningEffort;
  config.curator.timeoutMs = settings.curator.timeoutSeconds * 1_000;
  config.curator.maxOutputBytes = settings.curator.maxOutputMb * 1_048_576;
  config.curator.maxEvents = settings.curator.maxEvents;
  config.curator.maxNodes = settings.curator.maxNodes;
  config.curator.maxSources = settings.curator.maxSources;
  config.curator.maxExcerptChars = settings.curator.maxExcerptChars;
  config.curator.automation = { ...settings.curator.automation };

  config.docker.executionEnabled = settings.execution.dockerEnabled;
  config.docker.healthTimeoutMs = settings.execution.dockerHealthTimeoutSeconds * 1_000;
  config.docker.runTimeoutMs = settings.execution.dockerRunTimeoutSeconds * 1_000;
  config.agentSessions.maxSessions = settings.agent.maxSessions;
  config.agentSessions.maxEventsPerSession = settings.agent.maxEventsPerSession;
  config.agentSessions.profiles = config.agentSessions.profiles.map((profile) => ({
    ...profile,
    model: settings.agent.profileModels[profile.id] || profile.model,
    reasoningEffort: profile.driver === "opencode-server" ? undefined : settings.agent.reasoningEffort,
    ...(["codex", "opencode", "claude"].includes(profile.provider) ? { approvalPolicy: settings.agent.approvalPolicy } : {}),
    ...(profile.provider === "codex" ? { sandbox: settings.agent.sandbox } : {}),
    ...(profile.provider === "claude" ? { permissionMode: settings.agent.approvalPolicy === "never" ? "dontAsk" : "default" } : {}),
  }));
  config.experimentGateway = {
    ...config.experimentGateway,
    listTtlMs: settings.experimentGateway.listTtlSeconds * 1_000,
    detailTtlMs: settings.experimentGateway.detailTtlSeconds * 1_000,
    seriesTtlMs: settings.experimentGateway.seriesTtlSeconds * 1_000,
    contextTtlMs: settings.experimentGateway.contextTtlSeconds * 1_000,
    descriptorTtlMs: settings.experimentGateway.descriptorTtlSeconds * 1_000,
    maxListRuns: settings.experimentGateway.maxListRuns,
    maxCacheEntries: settings.experimentGateway.maxCacheEntries,
    maxIngestionRuns: settings.experimentGateway.maxIngestionRuns,
    maxIngestionEventsPerRun: settings.experimentGateway.maxIngestionEventsPerRun,
    maxIngestionBatchEvents: settings.experimentGateway.maxIngestionBatchEvents,
  };
  return config;
}

export function publicSettingsSchema(config) {
  const profiles = (config.agentSessions?.profiles ?? []).map((profile) => ({ id: profile.id, label: profile.label, provider: profile.provider, driver: profile.driver ?? "acp-stdio" }));
  return {
    schemaVersion: USER_SETTINGS_SCHEMA_VERSION,
    profiles,
    options: {
      locale: ["zh", "en"],
      topologyLayout: ["elk", "force", "base"],
      topologyView: ["global", "question", "experiments"],
      reasoningEffort: EFFORTS,
      approvalPolicy: APPROVAL_POLICIES,
      sandbox: SANDBOXES,
    },
    editable: {
      interface: ["locale", "topologyLayout", "topologyView"],
      project: ["name"],
      agent: ["defaultProfileId", "profileModels.*", "reasoningEffort", "approvalPolicy", "sandbox", "maxSessions", "maxEventsPerSession"],
      curator: ["enabled", "model", "reasoningEffort", "timeoutSeconds", "maxOutputMb", "maxEvents", "maxNodes", "maxSources", "maxExcerptChars", "automation.enabled", "automation.triggerOnSessionCheckpoint", "automation.triggerOnSourceDelta", "automation.triggerOnExperimentDelta", "automation.triggerOnIdle", "automation.triggerOnContinuityBreak", "automation.triggerOnTopologyChanged", "automation.idleSeconds", "automation.minPendingEvents", "automation.cooldownSeconds", "automation.backgroundMode"],
      sourceRefresh: ["enabled", "intervalSeconds", "freshForSeconds", "foregroundThresholdSeconds"],
      git: ["timeoutSeconds", "maxOutputMb"],
      sources: ["filesystem.*", "mlflow.*", "wandb.*", "tensorboard.*"],
      tools: ["conda.command", "uv.command", "nvidia.command", "cuda.command"],
      execution: ["dockerEnabled", "dockerHealthTimeoutSeconds", "dockerRunTimeoutSeconds"],
      experimentGateway: ["*"],
      simulation: ["*"],
    },
    locked: [
      { key: "deployment.listen", reason: "服务端监听地址和端口由启动环境管理。" },
      { key: "project.root", reason: "项目根目录由当前工作区决定，避免 Agent 越界读取。" },
      { key: "runtime.commands", reason: "命令来自服务端 allowlist，不能由浏览器提交任意 executable。" },
      { key: "credentials", reason: "token 仍由本机环境变量或 provider 登录状态管理，设置页不保存密钥。" },
      { key: "agent.toolPolicy", reason: "Agent 工具白名单和 wrapper 参数由应用安全策略管理。" },
      { key: "topology.writeback", reason: "正式拓扑仍需用户确认候选 patch。" },
    ],
  };
}

export class UserSettingsStore {
  constructor({ filePath, config }) {
    this.filePath = filePath;
    this.config = config;
    this.settings = null;
    this.source = "defaults";
    this.updatedAt = null;
    this.lastError = null;
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    const defaults = defaultUserSettings(this.config);
    try {
      const payload = JSON.parse(await readFile(this.filePath, "utf8"));
      this.settings = normalizeUserSettings({ workspaceRevision: 0, ...(payload.settings ?? payload) }, this.config, defaults);
      this.source = "workspace";
      this.updatedAt = payload.updatedAt ?? null;
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.lastError = { code: error.code ?? "USER_SETTINGS_LOAD_FAILED", message: error.message };
      }
      this.settings = defaults;
      this.source = "defaults";
    }
    return this.snapshot();
  }

  snapshot({ schema = null } = {}) {
    return {
      schemaVersion: USER_SETTINGS_SCHEMA_VERSION,
      settings: clone(this.settings),
      source: this.source,
      updatedAt: this.updatedAt,
      lastError: clone(this.lastError),
      ...(schema ? { schema: publicSettingsSchema(this.config) } : {}),
    };
  }

  async update(patch) {
    const next = normalizeUserSettings(patch, this.config, this.settings ?? defaultUserSettings(this.config));
    this.settings = next;
    this.source = "workspace";
    this.updatedAt = new Date().toISOString();
    await this.#flush();
    return this.snapshot({ schema: true });
  }

  async #flush() {
    const payload = JSON.stringify({ schemaVersion: USER_SETTINGS_SCHEMA_VERSION, updatedAt: this.updatedAt, settings: this.settings }, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${payload}\n`, "utf8");
      await rename(temporary, this.filePath);
    });
    return this.writeChain;
  }
}
