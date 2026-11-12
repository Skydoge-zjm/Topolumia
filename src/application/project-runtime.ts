import type { AppConfig, DeepPartial } from "../config.js";
import type { CollaborationStore, CollaborationActor } from "../services/platform/collaboration-store.js";
import type { UserSettings } from "../services/platform/user-settings-store.js";
import type { CuratorDriver } from "../services/topology/curator-types.js";
import type { SshConnectionService } from "../ssh/ssh-connection-service.js";
import { eventIdPart } from "../http/streams.js";

import { AsyncLocalStorage } from "node:async_hooks";

import { mkdir } from "node:fs/promises";

import path from "node:path";
import { isPathInside } from "../adapters/sources/filesystem-adapter.js";

import { AppError } from "../lib/errors.js";

import { AdapterRegistry } from "../services/platform/adapter-registry.js";
import { ResearchState } from "../services/research/research-state.js";
import { TopologyService } from "../services/topology/topology-service.js";
import { TopologyCuratorService } from "../services/topology/topology-curator.js";
import { AgentProfileRegistry } from "../services/agents/agent-profile-registry.js";
import { AgentSessionGateway } from "../services/agents/agent-session-gateway.js";
import { SourceRefreshCoordinator } from "../services/platform/source-refresh-coordinator.js";
import { MlflowRecordImporter } from "../services/research/experiments/mlflow-importer.js";
import { TopologyLayoutService } from "../services/topology/topology-layout-service.js";
import {
  UserSettingsStore,
  applyUserSettings,
} from "../services/platform/user-settings-store.js";
import { TopologyCuratorTriggerCoordinator } from "../services/topology/topology-curator-trigger-coordinator.js";

import { ResearchCommandService } from "../services/research/research-command-service.js";
import { ResearchAccessService } from "../services/research/research-access-service.js";
import { ToolEnvironmentService } from "../services/environments/tool-environment-service.js";
import { NotebookStore } from "../services/research/notebook-store.js";
import { ResearchRecords } from "../services/research/research-records.js";
import { ResearchNodeService } from "../services/topology/research-node-service.js";
import { AgentConfigurationService } from "../services/agents/agent-configuration-service.js";
import { NativeAgentConfigStore } from "../services/agents/configuration/native-config-store.js";
import { ResearchHistoryStore } from "../services/research/history/history-store.js";
import { ResearchHistoryTracker } from "../services/research/history/history-tracker.js";
import { sqliteTransaction } from "../lib/sqlite-transaction.js";
import { AgentAttachmentStore } from "../services/agents/agent-attachment-service.js";

export type ApplicationOptions = {
  config?: DeepPartial<AppConfig>; port?: number; host?: string; testMode?: boolean;
  collaborationFile?: string; userSettingsFile?: string; sshRoot?: string;
  sshOptions?: Omit<ConstructorParameters<typeof SshConnectionService>[0], "root">;
  topologyCuratorDriver?: CuratorDriver; recordCollectorDataDirectory?: string;
};
export type RuntimeProject = NonNullable<ReturnType<CollaborationStore["projectById"]>>;
export type ProjectRuntime = {
  project: RuntimeProject; config: AppConfig; userSettings: UserSettingsStore;
  agentProfileRegistry: AgentProfileRegistry; registry: AdapterRegistry;
  topologyCurator: TopologyCuratorService; topologyService: TopologyService;
  researchCommands: ResearchCommandService; researchAccess: ResearchAccessService;
  state: ResearchState; curatorTriggerCoordinator: TopologyCuratorTriggerCoordinator;
  agentSessionGateway: AgentSessionGateway; agentMedia: AgentAttachmentStore;
  activeCriticalOperations: number; nativeConfigs: NativeAgentConfigStore;
  history: ResearchHistoryStore; mlflowRecords: MlflowRecordImporter; notebook: NotebookStore;
  groups: ResearchCommandService["groups"]; records: ResearchRecords; researchNodes: ResearchNodeService;
  agentConfiguration: AgentConfigurationService; toolEnvironment: ToolEnvironmentService;
  sourceRefresh: SourceRefreshCoordinator;
  updateWorkspaceDirectory: (owner: string, connectionId: string, directory: string) => Promise<void>;
  dispose: () => Promise<void>;
};
export async function createProjectRuntimeRegistry({ config, collaboration, options }: {
  config: AppConfig; collaboration: CollaborationStore; options: ApplicationOptions;
}) {
  const baseTopologyService = new TopologyService({ demo: false });
  const topologyLayoutService = new TopologyLayoutService();
  const runtimes = new Map<string, ProjectRuntime>();
  const runtimePromises = new Map<string, Promise<ProjectRuntime>>();
  const actorContext = new AsyncLocalStorage<CollaborationActor | null>();
  function configForProject(project: RuntimeProject) {
    const projectConfig = structuredClone(config);
    projectConfig.project = {
      ...projectConfig.project,
      id: project.id,
      name: project.name,
      root: project.root,
      workspace: project.workspace,
    };
    if (project.id !== config.project.id || path.resolve(project.root) !== path.resolve(config.project.root))
      projectConfig.filesystem.roots = [project.root];
    const runtimeRoot = path.resolve(
      path.dirname(options.userSettingsFile ?? config.userSettings.file),
      "projects",
      project.id,
    );
    projectConfig.userSettings.file = path.join(runtimeRoot, "settings.json");
    if (
      config.collaboration.allowDevIdentity &&
      project.id === config.project.id
    )
      projectConfig.userSettings.file =
        options.userSettingsFile ?? config.userSettings.file;
    projectConfig.agentSessions.historyFile = path.join(
      runtimeRoot,
      "agent-sessions",
      "history.sqlite",
    );
    projectConfig.agentSessions.managedWrappersRoot =
      config.agentSessions.managedWrappersRoot;
    projectConfig.curator.runtimeRoot = path.join(runtimeRoot, "curator");
    projectConfig.filesystem.excludedRoots = [
      ...(config.filesystem.excludedRoots ?? []),
      ...(!isPathInside(path.dirname(options.userSettingsFile ?? config.userSettings.file), project.root)
        ? [path.dirname(options.userSettingsFile ?? config.userSettings.file)] : []),
      runtimeRoot,
    ];
    return projectConfig;
  }
  function attachPersistence(state: ResearchState, projectId: string, history: ResearchHistoryTracker) {
    let mutationDepth = 0;
    const scientificMutators = new Set(["commitResearch"]);
    const mutators = [
      "setSnapshot",
      "confirmSnapshot",
      "invalidateSourceCheck",
      "beginSourceRefresh",
      "completeSourceRefresh",
      "deferSourceRefresh",
      "failSourceRefresh",
      "setNextSourceRefresh",
      "setCuratorResult",
      "setCuratorTrigger",
      "recordEvent",
      "setExecutionPreview",
      "setExecutionRecord",
      "setError",
      "commitResearch",
    ] as const;
    for (const method of mutators) {
      wrap(method);
    }
    function wrap<K extends (typeof mutators)[number]>(method: K) {
      const original = state[method].bind(state) as ResearchState[K];
      const invoke = original as (...args: Parameters<ResearchState[K]>) => ReturnType<ResearchState[K]>;
      state[method] = ((...args: Parameters<ResearchState[K]>) => {
        if (mutationDepth) return invoke(...args);
        if (scientificMutators.has(method)) {
          const before = { topology: state.topology, research: state.research, agentEvents: state.agentEvents.slice(), _eventKeys: new Set(state._eventKeys) };
          mutationDepth++;
          try {
            return sqliteTransaction(collaboration.db, () => {
              const result = invoke(...args);
              history.capture(method, { ...state.view(), ...before }, state.view(), args, actorContext.getStore());
              collaboration.saveState(projectId, state.view());
              return result;
            });
          } catch (error) {
            Object.assign(state, before);
            throw error;
          } finally { mutationDepth--; }
        }
        const result = invoke(...args);
        try {
          collaboration.saveState(projectId, state.view());
        } catch {
          /* the in-memory request still completes; next recovery reports the error */
        }
        return result;
      }) as ResearchState[K];
    }
    return state;
  }
  async function buildRuntime(project: RuntimeProject): Promise<ProjectRuntime> {
    const dispose: Array<() => unknown> = [];
    try {
    const historyStore = new ResearchHistoryStore(collaboration.db, project.id);
    const history = new ResearchHistoryTracker(historyStore);
    const projectConfig = configForProject(project);
    const topologyService = baseTopologyService;
    await mkdir(projectConfig.project.root, { recursive: true });
    const userSettings = new UserSettingsStore({
      filePath: projectConfig.userSettings.file,
      config: projectConfig,
    });
    await userSettings.initialize();
    applyUserSettings(projectConfig, userSettings.settings);
    const nativeConfigs = new NativeAgentConfigStore(path.join(path.dirname(projectConfig.userSettings.file), "agent-config"));
    await nativeConfigs.initialize(projectConfig.agentSessions.profiles);
    const agentProfileRegistry = new AgentProfileRegistry(projectConfig, { nativeConfigs });
    const registry = new AdapterRegistry(projectConfig);
    const topologyCurator = new TopologyCuratorService({
      config: projectConfig.curator,
      driver: options.topologyCuratorDriver,
    });
    const state = attachPersistence(
      new ResearchState(topologyService.build()),
      project.id,
      history,
    );
    const savedState = collaboration.loadState(project.id);
    if (savedState) state.hydrate(savedState, topologyService.build());
    const curatorTriggerCoordinator = new TopologyCuratorTriggerCoordinator({
      topologyCurator,
      topologyService,
      state,
      getSettings: () => userSettings.settings,
    });
    dispose.push(() => curatorTriggerCoordinator.stop());
    curatorTriggerCoordinator.updateSettings(userSettings.settings);
    const researchCommands = new ResearchCommandService({
      state,
      topologyService,
      topologyCurator,
      db: collaboration.db,
      assetRoot: path.join(path.dirname(projectConfig.userSettings.file), "research-assets"),
      projectId: project.id,
      projectName: project.name,
      sourceReader: (source) => {
        if (typeof source.ref !== "string" || typeof source.locator !== "string" || typeof source.version !== "string" || typeof source.extension !== "string") throw new AppError("SOURCE_UNAVAILABLE", "来源缺少文件索引。", { status: 409 });
        return registry.filesystem.readIndexedText({ ref: source.ref, locator: source.locator, version: source.version, extension: source.extension });
      },
      sourceText: (source) => typeof source.ref === "string" && typeof source.version === "string" ? registry.filesystem.indexedText({ ref: source.ref, version: source.version }) : null,
      sourceAllowed: (source) => !source.ref?.startsWith("file:") || typeof source.locator === "string" && registry.filesystem.isResearchPath(source.locator),
      recordOptions: {
        pythonCommand: () => projectConfig.experimentRecords.pythonCommand,
      },
    });
    dispose.push(async () => { await researchCommands.assets.close(); await researchCommands.records.close(); });
    await researchCommands.assets.initialize();
    const agentMedia = new AgentAttachmentStore(projectConfig.agentSessions.historyFile);
    dispose.push(() => agentMedia.close());
    const agentSessionGateway = new AgentSessionGateway({
      profileRegistry: agentProfileRegistry,
      projectRoot: projectConfig.project.root,
      maxSessions: projectConfig.agentSessions.maxSessions,
      maxEventsPerSession: projectConfig.agentSessions.maxEventsPerSession,
      historyFile: projectConfig.agentSessions.historyFile,
      captureImage: (sessionId, event) => agentMedia.snapshot(sessionId, event, projectConfig.project.root),
      onSessionClosed: (runtimeInstanceId) =>
        collaboration.revokeAgentCredential(runtimeInstanceId),
      onResearchEvent: (event) => {
        state.recordEvent(event, { skipValidation: true });
        curatorTriggerCoordinator.noteActivity();
        if (event.type === "agentMessage")
          void curatorTriggerCoordinator
            .consider("session_checkpoint", {
              sessionId: event.sessionId,
              nodeIds: event.nodeIds,
              sourceRefs: event.sourceRefs,
              entryContext: {
                surface: "agent-session",
                action: "turn-completed",
              },
            })
            .catch(() => {});
      },
    });
    dispose.push(() => agentSessionGateway.closeAll());
    await agentSessionGateway.initialize();
    await agentMedia.collect(agentSessionGateway.list());
    researchCommands.onCandidateChange = candidate => agentSessionGateway.researchChanged(candidate);
    history.resolveAgent = sessionId => {
      const session = agentSessionGateway.list().find(session => session.researchSessionId === sessionId);
      return session ? { name: { codex: "Codex", claude: "Claude Code", opencode: "OpenCode" }[session.provider ?? "codex"] ?? "Agent", model: session.model,
        workbenchSessionId: session.id } : null;
    };
    const researchAccess = new ResearchAccessService(collaboration, project.id);
    const core = {
      project,
      config: projectConfig,
      userSettings,
      agentProfileRegistry,
      registry,
      topologyCurator,
      topologyService,
      researchCommands,
      researchAccess,
      state,
      curatorTriggerCoordinator,
      agentSessionGateway,
      agentMedia,
      activeCriticalOperations: 0,
      nativeConfigs,
      history: historyStore,
    };
    const mlflowRecords = new MlflowRecordImporter(researchCommands, projectConfig);
    const updateWorkspaceDirectory = async (owner: string, connectionId: string, directory: string) => {
      const workspace = runtime.config.project.workspace;
      if (workspace?.kind !== "ssh" || workspace.ownerId !== owner || workspace.connectionId !== connectionId || workspace.directory === directory) return;
      const actor = actorContext.getStore();
      if (actor?.user?.id !== owner) throw new AppError("FORBIDDEN", "项目目录更新需要当前登录身份。", { status: 403 });
      const result = collaboration.updateProjectWorkspace(project.id, { ...workspace, kind: "ssh", connectionId: workspace.connectionId ?? "", directory }, workspace.revision, actor);
      if (!result) throw new AppError("PROJECT_NOT_FOUND", "项目不存在。", { status: 404 });
      runtime.config.project.workspace = result.workspace;
      runtime.project.workspace = result.workspace;
      await runtime.userSettings.update({ workspaceRevision: result.workspace.revision, researchLocation: "ssh", remoteEnvironment: null });
    };
    const notebook = new NotebookStore(collaboration.db, project.id, event => history.documentChanged(event));
    history.resolveResearchObject = (type, id, revision) => {
      const version = researchCommands.store.get("versions", JSON.stringify([type, id]) + ":" + revision);
      if (!version || !("object" in version)) return null;
      return { ...version.object, members: ("members" in version.object ? version.object.members : undefined)?.map(member => ({ ...member, label: researchCommands.store.get("nodes", member.nodeId)?.core?.nodeName ?? member.nodeId })), contentBlockVersions: version.blocks.map(block => ({ id: block.id, title: block.title, type: block.type, revision: block.revision, lifecycle: block.lifecycle, ...(block.type === "experimentRecord" ? { recordCollection: block.recordCollection } : {}) })) };
    };
    const groups = researchCommands.groups;
    const records = new ResearchRecords(notebook, state);
    const researchNodes = new ResearchNodeService(core);
    const agentConfiguration = new AgentConfigurationService({
      config: projectConfig,
      profileRegistry: agentProfileRegistry,
      userSettings,
      applySettings: () => applyRuntimeSettings(userSettings.settings, runtime),
      nativeConfigs,
    });
    const toolEnvironment = new ToolEnvironmentService({
      config: projectConfig,
      registry,
      userSettings,
      applySettings: async (_settings) => {
        if (runtime.sourceRefresh.inFlight) await runtime.sourceRefresh.inFlight;
        applyRuntimeSettings(userSettings.settings, runtime);
      },
    });
    dispose.push(() => toolEnvironment.research.close(), () => toolEnvironment.catalog.close());
    const sourceRefresh = new SourceRefreshCoordinator({
      registry,
      topologyService,
      state,
      enabled: projectConfig.sourceRefresh.enabled,
      intervalMs: projectConfig.sourceRefresh.intervalMs,
      freshForMs: projectConfig.sourceRefresh.freshForMs,
      isBlocked: () =>
        runtime.activeCriticalOperations > 0 ||
        curatorTriggerCoordinator.statusView().running ||
        agentSessionGateway
          .list({ summary: true })
          .some((session) =>
            ["starting", "running", "awaiting_permission"].includes(
              session.status,
            ),
          ),
      onResult: (result) => {
        if (!result.changed) return;
        curatorTriggerCoordinator.resetForStateChange();
        state.recordEvent(
          {
            id: `source_delta:${eventIdPart(result.stateVersion ?? result.checkedAt)}`,
            type: "toolResult",
            actor: "adapter:source-refresh",
            sessionId: null,
            nodeIds: [],
            sourceRefs: [],
            payload: {
              adapter: "source-refresh",
              status: "updated",
              reason: result.reason,
              previousStateVersion: result.previousStateVersion,
              stateVersion: result.stateVersion,
            },
          },
          { skipValidation: true },
        );
        curatorTriggerCoordinator.updateState();
        void curatorTriggerCoordinator
          .consider("source_delta", {
            entryContext: { surface: "source-refresh", action: result.reason },
          })
          .catch(() => {});
      },
    });
    const disposeRuntime = async () => {
      runtime.sourceRefresh.stop();
      await runtime.sourceRefresh.inFlight?.catch(() => {});
      await Promise.allSettled(dispose.slice().reverse().map(close => Promise.resolve().then(close)));
    };
    const runtime: ProjectRuntime = { ...core, mlflowRecords, updateWorkspaceDirectory, notebook, groups, records, researchNodes, agentConfiguration, toolEnvironment, sourceRefresh, dispose: disposeRuntime };
    await toolEnvironment.initialize();
    runtimes.set(project.id, runtime);
    return runtime;
    } catch (error) {
      await Promise.allSettled(dispose.reverse().map(close => Promise.resolve().then(close)));
      throw error;
    }
  }
  async function getRuntime(projectId: string): Promise<ProjectRuntime> {
    const project = collaboration.projectById(projectId);
    if (!project || project.status === "deleted")
      throw new AppError("PROJECT_NOT_FOUND", "项目不存在。", { status: 404 });
    if (runtimePromises.has(project.id)) return runtimePromises.get(project.id)!;
    if (runtimes.has(project.id)) return runtimes.get(project.id)!;
    if (!runtimePromises.has(project.id))
      runtimePromises.set(project.id, buildRuntime(project));
    const pending = runtimePromises.get(project.id)!;
    try { return await pending; }
    finally { if (runtimePromises.get(project.id) === pending) runtimePromises.delete(project.id); }
  }
  async function replaceRuntime(projectId: string, update: () => unknown): Promise<ProjectRuntime> {
    if (runtimePromises.has(projectId)) await runtimePromises.get(projectId);
    const current = runtimes.get(projectId);
    if (current && (current.activeCriticalOperations || current.curatorTriggerCoordinator.statusView().running || current.agentSessionGateway.list({ summary: true }).some(session => ["starting", "running", "awaiting_permission"].includes(session.status)))) throw new AppError("PROJECT_WORKSPACE_BUSY", "项目仍有运行中的任务，请结束后再更换工作目录。", { status: 409 });
    const pending = Promise.resolve().then(async () => {
      update();
      if (current) await current.dispose();
      runtimes.delete(projectId);
      const project = collaboration.projectById(projectId);
      if (!project) throw new AppError("PROJECT_NOT_FOUND", "项目不存在。", { status: 404 });
      return buildRuntime(project);
    });
    runtimePromises.set(projectId, pending);
    try { return await pending; } finally { if (runtimePromises.get(projectId) === pending) runtimePromises.delete(projectId); }
  }
  const defaultRuntime = await getRuntime(config.project.id);
  function applyRuntimeSettings(settings: UserSettings, runtime: ProjectRuntime) {
    const providers = ["mlflow", "wandb", "tensorboard"] as const;
    const previous = Object.fromEntries(
      providers.map((provider) => [
        provider,
        JSON.stringify(runtime.config[provider]),
      ]),
    );
    const previousAgents = new Map(
      runtime.config.agentSessions.profiles.map((profile) => [
        profile.id,
        JSON.stringify(profile),
      ]),
    );
    const previousTools = JSON.stringify([
      runtime.config.git,
      runtime.config.filesystem,
      runtime.config.docker,
      runtime.config.toolCommands,
      ...providers.map((provider) => runtime.config[provider]),
    ]);
    applyUserSettings(runtime.config, settings);
    const changed = providers.filter(
      (provider) =>
        previous[provider] !== JSON.stringify(runtime.config[provider]),
    );
    if (changed.length) runtime.state.invalidateSourceCheck();
    if (
      previousTools !==
      JSON.stringify([
        runtime.config.git,
        runtime.config.filesystem,
        runtime.config.docker,
        runtime.config.toolCommands,
        ...providers.map((provider) => runtime.config[provider]),
      ])
    )
      runtime.toolEnvironment?.invalidate();
    const changedAgents = runtime.config.agentSessions.profiles
      .filter(
        (profile) => previousAgents.get(profile.id) !== JSON.stringify(profile),
      )
      .map((profile) => profile.id);
    if (changedAgents.length)
      runtime.agentConfiguration?.invalidate(changedAgents);
    runtime.agentProfileRegistry.applyUserSettings();
    runtime.agentSessionGateway.updateSettings({
      maxSessions: settings.agent.maxSessions,
      maxEventsPerSession: settings.agent.maxEventsPerSession,
    });
    runtime.sourceRefresh.updateSettings({
      enabled: settings.sourceRefresh.enabled,
      intervalMs: settings.sourceRefresh.intervalSeconds * 1_000,
      freshForMs: settings.sourceRefresh.freshForSeconds * 1_000,
    });
    runtime.topologyCurator.driver.config = runtime.config.curator;
    runtime.curatorTriggerCoordinator.updateSettings(settings);
    return runtime.config;
  }
  async function refreshForContext(reason: string, runtime: ProjectRuntime) {
    try {
      const result = await runtime.sourceRefresh.ensureFresh({ reason });
      if (result.outcome === "deferred" && !runtime.state.snapshot) {
        throw new AppError(
          "SOURCE_REFRESH_DEFERRED",
          "研究来源正在等待当前任务结束后检查。",
          { status: 409 },
        );
      }
      return result;
    } catch (error) {
      if (runtime.state.snapshot) return null;
      throw error;
    }
  }
  return {
    actorContext,
    runtimes,
    getRuntime,
    replaceRuntime,
    defaultRuntime,
    baseTopologyService,
    topologyLayoutService,
    applyRuntimeSettings,
    refreshForContext,
  };
}
