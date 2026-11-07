import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const compiled = path.basename(path.resolve(moduleRoot, "..")) === "dist";
export const mvpRoot = compiled ? path.resolve(moduleRoot, "../..") : path.resolve(moduleRoot, "..");
export const bundledRoot = compiled ? path.resolve(moduleRoot, "..") : mvpRoot;

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return override ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(base?.[key] ?? {}, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function resolveFromMvp(value) {
  return path.isAbsolute(value) ? value : path.resolve(mvpRoot, value);
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export async function loadConfig(overrides = {}) {
  // The repository root is the safe local default. The previous parent-directory
  // default resolved to the drive root in this checkout on Windows.
  const defaultProjectRoot = mvpRoot;
  const defaults = {
    server: {
      host: "127.0.0.1",
      port: 5510,
    },
    project: {
      id: "diffusion-sr-reproduction",
      name: "DiffusionSR Reproduction",
      root: defaultProjectRoot,
      workspacesRoot: path.resolve(mvpRoot, "workspaces"),
    },
    sourceRefresh: {
      enabled: true,
      intervalMs: 60_000,
      freshForMs: 15_000,
      foregroundThresholdMs: 30_000,
    },
    experimentGateway: {
      listTtlMs: 15_000,
      detailTtlMs: 30_000,
      seriesTtlMs: 30_000,
      contextTtlMs: 30_000,
      descriptorTtlMs: 30_000,
      maxListRuns: 300,
      maxCacheEntries: 256,
      maxIngestionRuns: 32,
      maxIngestionEventsPerRun: 300_000,
      maxIngestionBatchEvents: 300_000,
    },
    git: {
      command: "git",
      timeoutMs: 5_000,
      maxOutputBytes: 1_048_576,
    },
    toolCommands: { conda: "conda", uv: "uv", nvidia: "nvidia-smi", cuda: "nvcc" },
    researchEnvironment: { kind: "default", prefix: "", pythonCommand: "python" },
    filesystem: {
      roots: ["fixtures/research"],
      allowedExtensions: [".md", ".txt", ".yaml", ".yml", ".json", ".py", ".pdf", ".png", ".jpg", ".jpeg"],
      maxFiles: 80,
      maxDepth: 4,
      maxTextBytes: 65_536,
      excerptChars: 1_800,
    },
    mlflow: {
      baseUrl: "",
      experimentId: "",
      experimentName: "diffusion-sr-reproduction",
      tokenEnv: "MLFLOW_TRACKING_TOKEN",
      fixtureFile: path.resolve(bundledRoot, "fixtures/mlflow-runs.json"),
      timeoutMs: 4_000,
      pageSize: 100,
      maxRuns: 300,
    },
    wandb: {
      baseUrl: "",
      graphqlPath: "/graphql",
      authScheme: "basic",
      entity: "local",
      project: "diffusion-sr-reproduction",
      tokenEnv: "WANDB_API_KEY",
      fixtureFile: path.resolve(bundledRoot, "fixtures/wandb-runs.json"),
      timeoutMs: 4_000,
      pageSize: 100,
      maxRuns: 300,
    },
    tensorboard: {
      logdir: "",
      fixtureFile: path.resolve(bundledRoot, "fixtures/tensorboard-runs.json"),
      pythonCommand: "python",
      parserScript: path.resolve(mvpRoot, "scripts/runtime/tensorboard-event-parser.py"),
      parserTimeoutMs: 10_000,
      maxDepth: 4,
      maxRuns: 300,
    },
    experimentRecords: { pythonCommand: "python" },
    docker: {
      command: "docker",
      executionEnabled: false,
      healthTimeoutMs: 5_000,
      runTimeoutMs: 20_000,
    },
    curator: {
      enabled: true,
      command: "codex",
      model: "gpt-6-luna",
      timeoutMs: 300_000,
      maxOutputBytes: 4_194_304,
      runtimeRoot: path.resolve(mvpRoot, "runtime/curator"),
      maxEvents: 120,
      maxSources: 100,
      maxNodes: 180,
      maxExcerptChars: 14_000,
      automation: {
        enabled: false,
        triggerOnSessionCheckpoint: true,
        triggerOnSourceDelta: true,
        triggerOnExperimentDelta: true,
        triggerOnIdle: true,
        triggerOnContinuityBreak: true,
        triggerOnTopologyChanged: false,
        idleSeconds: 900,
        minPendingEvents: 3,
        cooldownSeconds: 300,
        backgroundMode: "suggested",
      },
    },
    userSettings: {
      file: path.resolve(mvpRoot, "runtime/user-settings.json"),
    },
    collaboration: {
      databaseFile: path.resolve(mvpRoot, "runtime/collaboration.sqlite"),
      allowDevIdentity: false,
      adminPassword: process.env.MVP_ADMIN_PASSWORD || "",
      sessionTtlMs: 8 * 60 * 60 * 1_000,
    },
    agentSessions: {
      maxSessions: 50,
      maxEventsPerSession: 1_000,
      historyFile: path.resolve(mvpRoot, "runtime/agent-sessions/history.sqlite"),
      managedWrappersRoot: path.resolve(bundledRoot, "managed-wrappers"),
      profiles: [
        {
          id: "codex-acp",
          label: "Codex",
          provider: "codex",
          source: "native",
          driver: "codex-app-server",
          transport: "codex-app-server-stdio",
          command: "codex",
          args: ["app-server", "--listen", "stdio://"],
          versionArgs: ["--version"],
          minVersion: "0.147.0",
          authProbe: { kind: "codex", args: ["login", "status"] },
          requiresRuntime: "codex",
          model: "gpt-6-luna",
          models: [
            { id: "gpt-6-luna", label: "6 Luna" },
            { id: "gpt-6-astra", label: "6 Astra" },
            { id: "gpt-6.1-sol", label: "6.1 Sol" },
            { id: "gpt-5.6-sol", label: "5.6 Sol" },
            { id: "gpt-5.6-luna", label: "5.6 Luna" },
          ],
          reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
          // Persist native Codex threads. Topolumia keeps its own local
          // snapshot, so this is a source binding rather than the UI store.
          ephemeral: false,
          description: "Direct native integration with the installed Codex CLI app-server.",
        },
        {
          id: "claude-agent-acp",
          label: "Claude Code",
          provider: "claude",
          source: "native",
          driver: "claude-cli-stream",
          transport: "claude-cli-stream-json",
          command: "claude",
          versionArgs: ["--version"],
          authProbe: { kind: "claude", args: ["auth", "status", "--json"] },
          requiresRuntime: "claude",
          model: "gpt-6-luna",
          models: [
            { id: "gpt-6-luna", label: "6 Luna" },
            { id: "sonnet", label: "Sonnet" },
            { id: "opus", label: "Opus" },
            { id: "haiku", label: "Haiku" },
          ],
          reasoningEfforts: ["low", "medium", "high"],
          permissionMode: "default",
          allowedTools: ["Read", "Grep", "Glob"],
          description: "Direct native integration with the installed Claude Code CLI stream-json mode.",
        },
        {
          id: "opencode-acp",
          label: "OpenCode",
          provider: "opencode",
          driver: "opencode-server",
          transport: "opencode-server-http-sse",
          source: "native",
          command: "opencode",
          model: "gpt-6-luna",
          requiresRuntime: "opencode",
          args: ["serve"],
          versionArgs: ["--version"],
          minVersion: "1.19.0",
          approvalPolicy: "on-request",
          description: "OpenCode native Server API and official TypeScript SDK.",
        },
      ],
    },
  };

  const configPath = process.env.TOPOLUMIA_CONFIG
    ? path.resolve(process.env.TOPOLUMIA_CONFIG)
    : path.resolve(mvpRoot, "config/topolumia.config.json");
  const fileConfig = await readOptionalJson(configPath);
  let config = deepMerge(defaults, fileConfig);
  config = deepMerge(config, overrides);

  config.server.host = String(config.server.host || "127.0.0.1");
  config.server.port = Number(config.server.port || 5510);
  config.experimentRecords.pythonCommand = String(config.experimentRecords.pythonCommand || "python");
  if (!path.isAbsolute(config.experimentRecords.pythonCommand) && /[\\/]/.test(config.experimentRecords.pythonCommand)) config.experimentRecords.pythonCommand = path.resolve(mvpRoot, config.experimentRecords.pythonCommand);
  config.mlflow.baseUrl = process.env.MLFLOW_TRACKING_URI || config.mlflow.baseUrl;
  config.wandb.baseUrl = process.env.WANDB_API_URL || config.wandb.baseUrl;
  config.tensorboard.logdir = process.env.TENSORBOARD_LOGDIR || config.tensorboard.logdir;
  config.tensorboard.pythonCommand = process.env.TENSORBOARD_PYTHON || config.tensorboard.pythonCommand;
  config.tensorboard.parserScript = process.env.TENSORBOARD_EVENT_PARSER || config.tensorboard.parserScript;
  config.docker.executionEnabled = parseBoolean(process.env.MVP_ENABLE_DOCKER_RUN, config.docker.executionEnabled);
  config.curator.enabled = parseBoolean(process.env.MVP_ENABLE_REAL_CURATOR, config.curator.enabled);
  config.sourceRefresh.enabled = parseBoolean(process.env.MVP_SOURCE_REFRESH_ENABLED, config.sourceRefresh.enabled);
  config.collaboration.allowDevIdentity = parseBoolean(process.env.MVP_ALLOW_DEV_IDENTITY, config.collaboration.allowDevIdentity);
  config.collaboration.adminPassword = process.env.MVP_ADMIN_PASSWORD || config.collaboration.adminPassword;
  config.project.root = resolveFromMvp(config.project.root);
  config.project.workspacesRoot = resolveFromMvp(config.project.workspacesRoot);
  config.filesystem.roots = config.filesystem.roots.map((root) => (
    path.isAbsolute(root) ? root : path.resolve(config.project.root, root)
  ));
  config.mlflow.fixtureFile = resolveFromMvp(config.mlflow.fixtureFile);
  config.wandb.fixtureFile = resolveFromMvp(config.wandb.fixtureFile);
  config.tensorboard.fixtureFile = resolveFromMvp(config.tensorboard.fixtureFile);
  if (config.tensorboard.logdir) config.tensorboard.logdir = resolveFromMvp(config.tensorboard.logdir);
  config.tensorboard.parserScript = config.tensorboard.parserScript ? resolveFromMvp(config.tensorboard.parserScript) : "";
  config.agentSessions.historyFile = resolveFromMvp(config.agentSessions.historyFile);
  config.agentSessions.managedWrappersRoot = resolveFromMvp(config.agentSessions.managedWrappersRoot);
  config.userSettings.file = resolveFromMvp(config.userSettings.file);
  config.collaboration.databaseFile = resolveFromMvp(config.collaboration.databaseFile);
  config.curator.runtimeRoot = resolveFromMvp(config.curator.runtimeRoot);
  config.publicRoot = path.resolve(mvpRoot, "frontend", "dist");

  return config;
}
