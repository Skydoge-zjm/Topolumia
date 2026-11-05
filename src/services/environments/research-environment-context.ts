import path from "node:path";
import { readFile } from "node:fs/promises";
import { AppError } from "../../lib/errors.js";
import { versionHash } from "../../lib/hash.js";
import { requirePermission } from "../research/research-command-service.js";

const componentIds = ["jupyter", "tensorboard", "wandb", "mlflow", "torch", "jax", "tensorflow", "cuda"];
const clip = (value, max = 80) => typeof value === "string" ? value.slice(0, max) : value;
const fields = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, clip(value[key])]));
export const inspectionStale = (checkedAt) => !checkedAt || !Number.isFinite(Date.parse(checkedAt)) || Date.now() - Date.parse(checkedAt) > 900_000;

/** Read a diagnostic cache without starting discovery, imports, or commands. */
export async function cachedEnvironmentInspection(file, fingerprint) {
  try {
    const raw = await readFile(file, "utf8");
    if (raw.length > 262144) return null;
    const saved = JSON.parse(raw);
    return saved.schemaVersion === "research-environment.v1" && saved.fingerprint === fingerprint &&
      saved.status === "completed" && Array.isArray(saved.components) && saved.components.length <= 10
      ? saved : null;
  } catch { return null; }
}

function binding(runtime) {
  const { config, userSettings } = runtime;
  return versionHash([config.project.id, config.project.root, config.researchEnvironment, config.toolCommands,
    userSettings.settings.researchLocation, userSettings.settings.remoteEnvironment]);
}

function components(inspection) {
  return componentIds.flatMap(id => {
    const item = inspection?.components?.find(component => component.id === id);
    if (!item || item.status === "unchecked") return [];
    return [{ id, status: item.status, ...fields(item, ["version", "cudaVersion", "cudnnVersion", "ncclVersion", "gpuAvailable", "gpuTest", "origin"]),
      checkedAt: item.checkedAt ?? null }];
  });
}

function hardware(component) {
  if (!component) return { status: "unchecked", checkedAt: null };
  const gpus = Array.isArray(component.gpus) ? component.gpus : [];
  return { status: component.status, checkedAt: component.checkedAt ?? null, stale: inspectionStale(component.checkedAt),
    ...fields(component, ["version", "driverCudaMax"]),
    gpus: gpus.slice(0, 4).map(gpu => fields(gpu, ["index", "name", "totalMiB", "freeMiB"])),
    ...(gpus.length > 4 ? { additionalGpuCount: gpus.length - 4 } : {}) };
}

function tracking(config) {
  const result = {};
  if (config.tensorboard?.logdir) result.tensorboard = { logdir: config.tensorboard.logdir, location: "topolumia-service" };
  if (config.wandb?.baseUrl) result.wandb = { baseUrl: config.wandb.baseUrl, entity: config.wandb.entity, project: config.wandb.project };
  if (config.mlflow?.baseUrl) result.mlflow = { baseUrl: config.mlflow.baseUrl, experimentName: config.mlflow.experimentName, experimentId: config.mlflow.experimentId };
  return result;
}

/** A small briefing of the user's selection. The Agent owns further exploration. */
export async function readResearchEnvironmentContext({ runtime, actor, sshEnvironments, locale = "zh" }) {
  requirePermission(actor, "research.view");
  if (actor.projectId && actor.projectId !== runtime.config.project.id)
    throw new AppError("PROJECT_SCOPE_MISMATCH", "项目上下文不匹配。", { status: 403 });
  if (!["zh", "en"].includes(locale))
    throw new AppError("ENVIRONMENT_LOCALE_INVALID", "locale 必须是 zh 或 en。", { status: 422 });
  const initial = binding(runtime);
  const remote = runtime.userSettings.settings.researchLocation === "ssh";
  const localEntry = remote ? null : [...runtime.toolEnvironment.catalog?.entries?.values() ?? []]
    .find(entry => runtime.toolEnvironment.catalog.isCurrent(entry));
  const target = remote ? await sshEnvironments.contextSnapshot(runtime, actor.user.id) : {
    host: { kind: "local", platform: process.platform },
    directory: runtime.config.project.root,
    name: localEntry?.name ?? runtime.toolEnvironment.research.view().name,
    selection: runtime.config.researchEnvironment,
    toolCommands: runtime.config.toolCommands,
    inspection: runtime.toolEnvironment.research.view(),
    tools: [...runtime.toolEnvironment.results].map(([id, item]) => ({ id, ...item })),
  };
  if (initial !== binding(runtime))
    throw new AppError("ENVIRONMENT_CHANGED", "所选环境已改变，请重新读取环境梗概。", { status: 409 });
  const selection = target.selection;
  const python = target.inspection?.components?.find(item => item.id === "python" && item.status === "ready");
  const paths = remote ? path.posix : path;
  const executable = python?.python?.executable || (selection.kind === "conda"
    ? paths.join(selection.prefix, !remote && process.platform === "win32" ? "python.exe" : "bin/python")
    : selection.pythonCommand || "python");
  const prefix = selection.kind === "conda" ? selection.prefix : python?.python?.prefix ?? null;
  const invocation = selection.kind === "conda"
    ? { command: target.toolCommands?.conda || "conda", args: ["run", "--no-capture-output", "--prefix", selection.prefix, executable] }
    : { command: executable, args: [] };
  const availableTools = new Map((target.tools ?? []).map(item => [item.id, item]));
  const nvidia = [availableTools.get("nvidia"), target.inspection?.components?.find(item => item.id === "nvidia")]
    .filter(Boolean).sort((a, b) => String(b.checkedAt ?? "").localeCompare(String(a.checkedAt ?? "")))[0];
  const { connected: _connected, ...hostIdentity } = target.host;
  const result = {
    schemaVersion: "research-environment-context.v1",
    projectId: runtime.config.project.id,
    bindingVersion: versionHash([initial, hostIdentity, target.directory, target.selection, target.toolCommands]),
    host: target.host,
    workingDirectory: target.directory,
    environment: { name: target.name, kind: python?.python?.kind ?? selection.kind, prefix,
      python: { executable, version: python?.version ?? null, checkedAt: python?.checkedAt ?? null } },
    execution: { location: remote ? "remote-host" : "local-host", pythonPrefix: invocation },
    inspection: { status: target.inspection?.status ?? "unchecked", checkedAt: target.inspection?.checkedAt ?? null,
      stale: inspectionStale(target.inspection?.checkedAt), source: "cached-checks" },
    components: components(target.inspection),
    hardware: hardware(nvidia),
    tools: ["conda", "uv", "git", "docker"].flatMap(id => {
      const item = availableTools.get(id);
      if (!item && !target.toolCommands?.[id]) return [];
      return [{ id, status: item?.status ?? "unchecked", ...fields(item, ["version"]),
        checkedAt: item?.checkedAt ?? null,
        ...(target.toolCommands?.[id] ? { command: target.toolCommands[id] } : {}) }];
    }),
    tracking: tracking(runtime.config),
    guidance: locale === "en"
      ? "Use this selected target; inspect and execute with your own tools. Append Python arguments to pythonPrefix; use -m pip for packages. Remote paths/commands belong on the remote host; SSH login is separate from Topolumia's connection. Checks and free GPU memory are cached observations, not a live guarantee. Verify before training; do not silently use another environment."
      : "以此所选目标为准，用你自己的工具检查和执行。Python 参数追加到 pythonPrefix，包操作使用 -m pip。远程路径和命令须在远程主机使用，SSH 登录独立于 Topolumia 的连接。组件检测与空闲显存是缓存快照，训练前自行核实，不要静默改用其它环境。",
  };
  if (JSON.stringify(result).length > 8000)
    throw new AppError("ENVIRONMENT_CONTEXT_TOO_LARGE", "环境配置超出梗概长度限制，请精简路径或服务配置。", { status: 422 });
  return result;
}
