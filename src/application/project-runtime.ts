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
import { TrainingSimulationService } from "../services/experiments/training-simulator.js";
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

export async function createProjectRuntimeRegistry({
  config,
  collaboration,
  options,
}) {
  const baseTopologyService = new TopologyService({ demo: false });
  const topologyLayoutService = new TopologyLayoutService();
  const runtimes = new Map();
  const runtimePromises = new Map();
  const actorContext = new AsyncLocalStorage();
  function configForProject(project) {
    const projectConfig = structuredClone(config);
    projectConfig.project = {
      ...projectConfig.project,
      id: project.id,
      name: project.name,
      root: project.root,
    };
    if (project.id !== config.project.id)
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
  function attachPersistence(state, projectId, history) {
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
    ];
    for (const method of mutators) {
      const original = state[method].bind(state);
      state[method] = (...args) => {
        if (mutationDepth) return original(...args);
        if (scientificMutators.has(method)) {
          const before = { topology: state.topology, research: state.research, agentEvents: state.agentEvents.slice(), _eventKeys: new Set(state._eventKeys) };
          mutationDepth++;
          try {
            return sqliteTransaction(collaboration.db, () => {
              const result = original(...args);
              history.capture(method, before, state, args, actorContext.getStore());
              collaboration.saveState(projectId, state.view());
              return result;
            });
          } catch (error) {
            Object.assign(state, before);
            throw error;
          } finally { mutationDepth--; }
        }
        const result = original(...args);
        try {
          collaboration.saveState(projectId, state.view());
        } catch {
          /* the in-memory request still completes; next recovery reports the error */
        }
        return result;
      };
    }
    return state;
  }
  async function buildRuntime(project) {
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
    const trainingSimulation = new TrainingSimulationService({
      gateway: registry.experiments,
    });
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
      sourceReader: (source) => registry.filesystem.readIndexedText(source),
      sourceText: (source) => registry.filesystem.indexedText(source),
      sourceAllowed: (source) => !source.ref?.startsWith("file:") || registry.filesystem.isResearchPath(source.locator),
      recordOptions: {
        gateway: registry.experiments,
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
      const session = agentSessionGateway.list({ summary: true }).find(session => session.researchSessionId === sessionId);
      return session ? { name: { codex: "Codex", claude: "Claude Code", opencode: "OpenCode" }[session.provider] ?? "Agent", model: session.model,
        workbenchSessionId: session.id } : null;
    };
    const researchAccess = new ResearchAccessService(collaboration, project.id);
    const runtime = {
      project,
      config: projectConfig,
      userSettings,
      agentProfileRegistry,
      registry,
      trainingSimulation,
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
    runtime.notebook = new NotebookStore(collaboration.db, project.id, event => history.documentChanged(event));
    history.resolveResearchObject = (type, id, revision) => {
      const version = researchCommands.store.get("versions", JSON.stringify([type, id]) + ":" + revision);
      if (!version) return null;
      return { ...version.object, members: version.object.members?.map(member => ({ ...member, label: researchCommands.store.get("nodes", member.nodeId)?.core?.nodeName ?? member.nodeId })), contentBlockVersions: version.blocks.map(block => ({ id: block.id, title: block.title, type: block.type, revision: block.revision, lifecycle: block.lifecycle, ...(block.type === "experimentRecord" ? { recordCollection: block.recordCollection } : {}) })) };
    };
    runtime.groups = researchCommands.groups;
    runtime.records = new ResearchRecords(runtime.notebook, state);
    runtime.researchNodes = new ResearchNodeService(runtime);
    runtime.agentConfiguration = new AgentConfigurationService({
      config: projectConfig,
      profileRegistry: agentProfileRegistry,
      userSettings,
      applySettings: () => applyRuntimeSettings(userSettings.settings, runtime),
      nativeConfigs,
    });
    runtime.toolEnvironment = new ToolEnvironmentService({
      config: projectConfig,
      registry,
      userSettings,
      applySettings: async (settings) => {
        // Drain existing reads before changing their connection configuration.
        while (
          runtime.sourceRefresh.inFlight ||
          runtime.registry.experiments.inFlight.size
        ) {
          await Promise.allSettled(
            [
              runtime.sourceRefresh.inFlight,
              ...runtime.registry.experiments.inFlight.values(),
            ].filter(Boolean),
          );
        }
        applyRuntimeSettings(userSettings.settings, runtime);
      },
    });
    dispose.push(() => runtime.toolEnvironment.research.close(), () => runtime.toolEnvironment.catalog.close());
    await runtime.toolEnvironment.initialize();
    runtime.sourceRefresh = new SourceRefreshCoordinator({
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
    runtimes.set(project.id, runtime);
    return runtime;
    } catch (error) {
      await Promise.allSettled(dispose.reverse().map(close => Promise.resolve().then(close)));
      throw error;
    }
  }
  async function getRuntime(projectId) {
    const project = collaboration.projectById(projectId);
    if (!project || project.status === "deleted")
      throw new AppError("PROJECT_NOT_FOUND", "项目不存在。", { status: 404 });
    if (runtimes.has(project.id)) return runtimes.get(project.id);
    if (!runtimePromises.has(project.id))
      runtimePromises.set(project.id, buildRuntime(project));
    const pending = runtimePromises.get(project.id);
    try { return await pending; }
    finally { if (runtimePromises.get(project.id) === pending) runtimePromises.delete(project.id); }
  }
  const defaultRuntime = await getRuntime(config.project.id);
  function applyRuntimeSettings(settings, runtime) {
    const providers = ["mlflow", "wandb", "tensorboard"];
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
    for (const provider of changed)
      runtime.registry.experiments.invalidateConnection(provider);
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
    runtime.agentProfileRegistry.applyUserSettings(settings);
    runtime.agentSessionGateway.updateSettings({
      maxSessions: settings.agent.maxSessions,
      maxEventsPerSession: settings.agent.maxEventsPerSession,
    });
    runtime.sourceRefresh.updateSettings({
      enabled: settings.sourceRefresh.enabled,
      intervalMs: settings.sourceRefresh.intervalSeconds * 1_000,
      freshForMs: settings.sourceRefresh.freshForSeconds * 1_000,
    });
    runtime.registry.experiments.updateSettings({
      listTtlMs: settings.experimentGateway.listTtlSeconds * 1_000,
      detailTtlMs: settings.experimentGateway.detailTtlSeconds * 1_000,
      seriesTtlMs: settings.experimentGateway.seriesTtlSeconds * 1_000,
      contextTtlMs: settings.experimentGateway.contextTtlSeconds * 1_000,
      descriptorTtlMs: settings.experimentGateway.descriptorTtlSeconds * 1_000,
      maxListRuns: settings.experimentGateway.maxListRuns,
      maxCacheEntries: settings.experimentGateway.maxCacheEntries,
      maxIngestionRuns: settings.experimentGateway.maxIngestionRuns,
      maxIngestionEventsPerRun:
        settings.experimentGateway.maxIngestionEventsPerRun,
      maxIngestionBatchEvents:
        settings.experimentGateway.maxIngestionBatchEvents,
    });
    runtime.topologyCurator.driver.config = runtime.config.curator;
    runtime.curatorTriggerCoordinator.updateSettings(settings);
    return runtime.config;
  }
  async function refreshForContext(reason, runtime) {
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
    defaultRuntime,
    baseTopologyService,
    topologyLayoutService,
    applyRuntimeSettings,
    refreshForContext,
  };
}
