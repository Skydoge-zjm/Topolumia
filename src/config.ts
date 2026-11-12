import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { appPaths, configurationFiles } from "./lib/app-paths.js";
import type { AgentProfile } from "./domain/agents/agent-types.js";
import type { ProjectWorkspace } from "./domain/projects/workspace.js";

export interface AppConfig {
  applicationPaths: ReturnType<typeof appPaths>;
  publicRoot: string;
  server: { host: string; port: number };
  project: { id: string; name: string; root: string; workspacesRoot: string; workspace?: ProjectWorkspace };
  remoteExecution?: boolean;
  sourceRefresh: { enabled: boolean; intervalMs: number; freshForMs: number; foregroundThresholdMs: number };
  git: { command: string; timeoutMs: number; maxOutputBytes: number };
  toolCommands: { conda: string; uv: string; nvidia: string; cuda: string };
  researchEnvironment: { kind: string; prefix: string; pythonCommand: string };
  filesystem: { roots: string[]; excludedRoots?: string[]; allowedExtensions: string[]; maxFiles: number; maxDepth: number; maxTextBytes: number; excerptChars: number };
  mlflow: { baseUrl: string; experimentId: string; experimentName: string; tokenEnv: string; timeoutMs: number; pageSize: number; maxRuns: number };
  wandb: { baseUrl: string; graphqlPath: string; authScheme: string; entity: string; project: string; tokenEnv: string; timeoutMs: number };
  tensorboard: { logdir: string; pythonCommand: string };
  experimentRecords: { pythonCommand: string };
  docker: { command: string; executionEnabled: boolean; healthTimeoutMs: number; runTimeoutMs: number };
  curator: {
    enabled: boolean; command: string; model: string; reasoningEffort?: string; timeoutMs: number; maxOutputBytes: number; runtimeRoot: string;
    maxEvents: number; maxSources: number; maxNodes: number; maxExcerptChars: number;
    automation: { enabled: boolean; triggerOnSessionCheckpoint: boolean; triggerOnSourceDelta: boolean; triggerOnExperimentDelta: boolean; triggerOnIdle: boolean; triggerOnContinuityBreak: boolean; triggerOnTopologyChanged: boolean; idleSeconds: number; minPendingEvents: number; cooldownSeconds: number; backgroundMode: string };
  };
  userSettings: { file: string };
  collaboration: { databaseFile: string; allowDevIdentity: boolean; adminPassword: string; sessionTtlMs: number };
  agentSessions: { maxSessions: number; maxEventsPerSession: number; historyFile: string; managedWrappersRoot: string; requestTimeoutMs?: number; profiles: AgentProfile[] };
}
export type DeepPartial<T> = T extends readonly (infer Item)[] ? Item[] : T extends object ? { [Key in keyof T]?: DeepPartial<T[Key]> } : T;

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const compiled = path.basename(path.resolve(moduleRoot, "..")) === "dist";
export const mvpRoot = compiled ? path.resolve(moduleRoot, "../..") : path.resolve(moduleRoot, "..");
export const bundledRoot = compiled ? path.resolve(moduleRoot, "..") : mvpRoot;

function parseBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function deepMerge<T extends object>(base: T, override: unknown): T {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(base));
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const previous = result[key];
      result[key] = deepMerge(previous && typeof previous === "object" ? previous : {}, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

function resolveFromMvp(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(mvpRoot, value);
}

async function readOptionalJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

export async function loadConfig(overrides: DeepPartial<AppConfig> = {}): Promise<AppConfig> {
  const locations = appPaths();
  const defaultProjectRoot = path.join(locations.workspacesRoot, "research-project");
  const defaults: AppConfig = {
    applicationPaths: locations,
    publicRoot: path.resolve(mvpRoot, "frontend", "dist"),
    server: {
      host: "127.0.0.1",
      port: 5510,
    },
    project: {
      id: "diffusion-sr-reproduction",
      name: "DiffusionSR Reproduction",
      root: defaultProjectRoot,
      workspacesRoot: locations.workspacesRoot,
    },
    sourceRefresh: {
      enabled: true,
      intervalMs: 60_000,
      freshForMs: 15_000,
      foregroundThresholdMs: 30_000,
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
      timeoutMs: 4_000,
    },
    tensorboard: {
      logdir: "",
      pythonCommand: "python",
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
      runtimeRoot: path.join(locations.cacheRoot, "curator"),
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
      file: path.join(locations.dataRoot, "user-settings.json"),
    },
    collaboration: {
      databaseFile: path.join(locations.dataRoot, "collaboration.sqlite"),
      allowDevIdentity: false,
      adminPassword: process.env.MVP_ADMIN_PASSWORD || "",
      sessionTtlMs: 8 * 60 * 60 * 1_000,
    },
    agentSessions: {
      maxSessions: 50,
      maxEventsPerSession: 1_000,
      historyFile: path.join(locations.dataRoot, "agent-sessions/history.sqlite"),
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
          id: "opencode-v2", label: "OpenCode 2", provider: "opencode",
          driver: "opencode-server-v2", transport: "opencode-v2-http-sse", source: "native",
          command: "opencode", requiresRuntime: "opencode", args: ["serve"], versionArgs: ["--version"],
          minVersion: "2.2.7", maxVersion: "3.0.0", requireVersion: true,
          approvalPolicy: "on-request", description: "OpenCode 2 native API and TypeScript client.",
        },
        {
          id: "opencode-acp",
          label: "OpenCode 1（旧版）",
          provider: "opencode",
          driver: "opencode-server-v1",
          transport: "opencode-server-http-sse",
          source: "native",
          command: "opencode",
          model: "gpt-6-luna",
          requiresRuntime: "opencode",
          args: ["serve"],
          versionArgs: ["--version"],
          minVersion: "1.19.0",
          maxVersion: "2.0.0", requireVersion: true,
          approvalPolicy: "on-request",
          description: "OpenCode 1 legacy integration (frozen).",
        },
      ],
    },
  };

  let config = defaults;
  for (const configPath of configurationFiles()) config = deepMerge(config, await readOptionalJson(configPath));
  config = deepMerge(config, overrides);
  config.applicationPaths = locations;

  config.server.host = String(config.server.host || "127.0.0.1");
  config.server.port = Number(config.server.port || 5510);
  config.experimentRecords.pythonCommand = String(config.experimentRecords.pythonCommand || "python");
  if (!path.isAbsolute(config.experimentRecords.pythonCommand) && /[\\/]/.test(config.experimentRecords.pythonCommand)) config.experimentRecords.pythonCommand = path.resolve(mvpRoot, config.experimentRecords.pythonCommand);
  config.mlflow.baseUrl = process.env.MLFLOW_TRACKING_URI || config.mlflow.baseUrl;
  config.wandb.baseUrl = process.env.WANDB_API_URL || config.wandb.baseUrl;
  config.tensorboard.logdir = process.env.TENSORBOARD_LOGDIR || config.tensorboard.logdir;
  config.tensorboard.pythonCommand = process.env.TENSORBOARD_PYTHON || config.tensorboard.pythonCommand;
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
  if (config.tensorboard.logdir) config.tensorboard.logdir = resolveFromMvp(config.tensorboard.logdir);
  config.agentSessions.historyFile = resolveFromMvp(config.agentSessions.historyFile);
  config.agentSessions.managedWrappersRoot = resolveFromMvp(config.agentSessions.managedWrappersRoot);
  config.userSettings.file = resolveFromMvp(config.userSettings.file);
  config.collaboration.databaseFile = resolveFromMvp(config.collaboration.databaseFile);
  config.curator.runtimeRoot = resolveFromMvp(config.curator.runtimeRoot);
  config.publicRoot = path.resolve(mvpRoot, "frontend", "dist");

  return config;
}
