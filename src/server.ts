import { createProjectRuntimeRegistry } from "./application/project-runtime.js";
import { sendStatic } from "./http/static.js";

import { requiredProjectPermission } from "./http/authorization.js";
import { handlePlatformAuthRoutes } from "./http/routes/platform/auth.js";
import { handlePlatformCollaborationRoutes } from "./http/routes/platform/collaboration.js";
import { handleAgentsConfigurationRoutes } from "./http/routes/agents/configuration.js";
import { handleEnvironmentsRoutes } from "./http/routes/environments.js";
import { handleResearchCommandsRoutes } from "./http/routes/research/commands.js";
import { handleTopologyRoutes } from "./http/routes/topology.js";
import { handleNotebookRoutes } from "./http/routes/research/notebook.js";
import { handleResearchNodeRoutes } from "./http/routes/research/nodes.js";
import { handleExperimentRecordRoutes } from "./http/routes/research/experiment-records.js";
import { handleResearchGroupRoutes } from "./http/routes/research/groups.js";
import { handleResearchObjectRoutes } from "./http/routes/research/objects.js";
import { handlePlatformSettingsRoutes } from "./http/routes/platform/settings.js";
import { handleExperimentsRoutes } from "./http/routes/experiments.js";
import { handlePlatformSchemasRoutes } from "./http/routes/platform/schemas.js";
import { handleAgentsSessionsRoutes } from "./http/routes/agents/sessions.js";
import { handleResearchEventsRoutes } from "./http/routes/research/events.js";
import { handlePlatformSourcesRoutes } from "./http/routes/platform/sources.js";
import { handleExecutionsRoutes } from "./http/routes/executions.js";
import { createServer } from "node:http";

import { randomUUID } from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "./config.js";
import { AppError, asAppError, errorPayload } from "./lib/errors.js";
import { sendJson } from "./lib/http.js";

import { CollaborationStore } from "./services/platform/collaboration-store.js";

import { SshConnectionService } from "./ssh/ssh-connection-service.js";
import { SshEnvironmentHub } from "./ssh/ssh-environment-hub.js";

const routeHandlers = [
  handlePlatformAuthRoutes,
  handlePlatformCollaborationRoutes,
  handleAgentsConfigurationRoutes,
  handleEnvironmentsRoutes,
  handleResearchCommandsRoutes,
  handleExperimentRecordRoutes,
  handleResearchNodeRoutes,
  handleResearchGroupRoutes,
  handleResearchObjectRoutes,
  handleNotebookRoutes,
  handleTopologyRoutes,
  handlePlatformSettingsRoutes,
  handleExperimentsRoutes,
  handlePlatformSchemasRoutes,
  handleAgentsSessionsRoutes,
  handleResearchEventsRoutes,
  handlePlatformSourcesRoutes,
  handleExecutionsRoutes,
];

export async function createMvpApplication(options = {}) {
  const config = await loadConfig(options.config ?? {});
  if (options.testMode === true) config.collaboration.allowDevIdentity = true;
  config.collaboration.databaseFile = path.resolve(
    options.collaborationFile ??
      (options.port === 0
        ? path.join(
            os.tmpdir(),
            `research-workbench-test-${randomUUID()}.sqlite`,
          )
        : config.collaboration.databaseFile),
  );
  if (options.port === 0 && !options.userSettingsFile && !options.config?.userSettings?.file) {
    config.userSettings.file = path.join(path.dirname(config.collaboration.databaseFile), path.basename(config.collaboration.databaseFile) + ".runtime", "settings.json");
  }
  if (!config.collaboration.allowDevIdentity) {
    config.project = {
      ...config.project,
      id: "research-project",
      name: "Research Project",
      root: path.join(config.project.workspacesRoot, "research-project"),
    };
    config.filesystem.roots = [config.project.root];
    config.mlflow.fixtureFile = null;
    config.wandb.fixtureFile = null;
    config.tensorboard.fixtureFile = null;
    config.mlflow.baseUrl = "";
    config.wandb.baseUrl = "";
    config.tensorboard.logdir = "";
  }
  const collaboration = new CollaborationStore({
    filePath: config.collaboration.databaseFile,
    defaultProject: {
      id: config.project.id,
      name: config.project.name,
      root: config.project.root,
    },
    defaultAdminPassword: config.collaboration.adminPassword,
    allowDevIdentity: config.collaboration.allowDevIdentity,
    projectRootFactory: (projectId) =>
      path.resolve(config.project.workspacesRoot, projectId),
  });
  await collaboration.initialize();
  config.collaboration.databaseFile = collaboration.filePath;
  const sshConnections = new SshConnectionService({
    root:
      options.sshRoot ??
      path.join(
        path.dirname(collaboration.filePath),
        `${path.basename(collaboration.filePath)}.ssh`,
      ),
    ...options.sshOptions,
  });
  const sshEnvironments = new SshEnvironmentHub(sshConnections);
  const {
    actorContext,
    runtimes,
    getRuntime,
    defaultRuntime,
    baseTopologyService,
    topologyLayoutService,
    applyRuntimeSettings,
    refreshForContext,
  } = await createProjectRuntimeRegistry({ config, collaboration, options });

  const handler = async (request, response) => {
    const url = new URL(
      request.url,
      `http://${request.headers.host || "127.0.0.1"}`,
    );
    const pathname = url.pathname;
    try {
      const pathProjectMatch = pathname.match(/^\/api\/projects\/([^/]+)/);
      let requestedProjectId;
      try {
        requestedProjectId = decodeURIComponent(
          url.searchParams.get("projectId") ||
            pathProjectMatch?.[1] ||
            request.headers["x-rw-project-id"] ||
            config.project.id,
        );
      } catch {
        throw new AppError("PROJECT_ID_INVALID", "项目 ID 格式无效。", {
          status: 422,
        });
      }
      const isStatic = !pathname.startsWith("/api/");
      const isPublicApi =
        isStatic ||
        pathname === "/api/health" ||
        pathname === "/api/auth/status" ||
        pathname === "/api/auth/login" ||
        pathname === "/api/auth/logout" ||
        pathname === "/api/auth/bootstrap" ||
        pathname.startsWith("/api/schemas/");
      let requestActor = null;
      let requestRuntime = defaultRuntime;
      if (!isPublicApi) {
        requestActor = collaboration.requireActor(request, requestedProjectId);
        if (requestActor.isAgent && !pathname.startsWith("/api/research/"))
          throw new AppError(
            "AGENT_SCOPE_FORBIDDEN",
            "Agent 凭据仅可调用项目研究命令。",
            { status: 403 },
          );
        const projectCollection = pathname === "/api/projects";
        const invitationAcceptPath =
          /^\/api\/projects\/[^/]+\/invitations\/[^/]+\/accept$/.test(pathname);
        if (
          !projectCollection &&
          !invitationAcceptPath &&
          pathname !== "/api/auth/me" &&
          pathname !== "/api/collaboration/context"
        )
          collaboration.requireProject(requestActor, requestedProjectId);
        const noRuntime =
          pathname === "/api/auth/me" ||
          pathname === "/api/collaboration/context" ||
          pathname === "/api/users" ||
          projectCollection;
        if (!noRuntime) requestRuntime = await getRuntime(requestedProjectId);
        const requiredPermission = requiredProjectPermission(
          pathname,
          request.method,
        );
        if (requiredPermission)
          collaboration.requirePermission(requestActor, requiredPermission, {
            projectId: requestedProjectId,
          });
      }
      if (requestActor)
        response.setHeader("x-rw-project-id", requestedProjectId);
      return actorContext.run(requestActor, async () => {
        const {
          config,
          registry,
          trainingSimulation,
          topologyCurator,
          researchCommands,
          state,
          curatorTriggerCoordinator,
          agentSessionGateway,
          sourceRefresh,
          userSettings,
        } = requestRuntime;
        const topologyService =
          requestRuntime.topologyService ?? baseTopologyService;
        const commandActor = requestActor;
        const ensureFreshForContext = (reason) =>
          refreshForContext(reason, requestRuntime);
        try {
          if (["POST", "PATCH", "DELETE"].includes(request.method)) {
            const ownedSession = pathname.match(
              /^\/api\/agent-sessions\/([^/]+)(?:\/(?:turns|persist|attachments(?:\/[^/]+)?|cancel|resume|sync|close|notes|permissions\/reset|approvals\/[^/]+|queue\/[^/]+))?$/,
            );
            if (
              ownedSession &&
              agentSessionGateway.snapshot(ownedSession[1]).ownerUserId !==
                requestActor?.user?.id
            ) {
              throw new AppError(
                "AGENT_SESSION_OWNER_MISMATCH",
                "不能操作其他用户的 Agent 运行会话。",
                { status: 403 },
              );
            }
          }
          const routeContext = {
            request,
            response,
            url,
            pathname,
            requestedProjectId,
            requestActor,
            requestRuntime,
            collaboration,
            sshConnections,
            sshEnvironments,
            topologyLayoutService,
            runtimes,
            getRuntime,
            applyRuntimeSettings,
            config,
            registry,
            trainingSimulation,
            topologyCurator,
            researchCommands,
            state,
            curatorTriggerCoordinator,
            agentSessionGateway,
            sourceRefresh,
            userSettings,
            topologyService,
            commandActor,
            ensureFreshForContext,
          };
          for (const route of routeHandlers)
            if (await route(routeContext)) return;
          if (pathname.startsWith("/api/")) {
            throw new AppError("API_NOT_FOUND", "未找到 API。", {
              status: 404,
            });
          }
          if (!["GET", "HEAD"].includes(request.method)) {
            throw new AppError("METHOD_NOT_ALLOWED", "该资源不支持此方法。", {
              status: 405,
            });
          }
          await sendStatic(
            request,
            response,
            config.publicRoot,
            pathname,
          );
        } catch (error) {
          const appError = asAppError(error);
          state.setError(appError);
          if (!response.headersSent)
            sendJson(response, appError.status, errorPayload(appError));
          else response.end();
        }
      });
    } catch (error) {
      const appError = asAppError(error);
      if (!response.headersSent)
        sendJson(response, appError.status, errorPayload(appError));
      else response.end();
    }
  };

  const server = createServer((request, response) => {
    handler(request, response).catch((error) => {
      if (!response.headersSent) sendJson(response, 500, errorPayload(error));
      else response.end();
    });
  });
  server.on("close", () => {
    void sshEnvironments
      .close()
      .finally(() => sshConnections.close())
      .catch(() => {});
    for (const runtime of runtimes.values()) {
      runtime.sourceRefresh.stop();
      void runtime.toolEnvironment.research.close();
      void runtime.toolEnvironment.catalog.close();
      runtime.curatorTriggerCoordinator.stop();
      void runtime.agentSessionGateway.closeAll().catch(() => {});
    }
    void Promise.allSettled([...runtimes.values()].map(async runtime => { await runtime.researchCommands.assets.close(); await runtime.researchCommands.records.close(); })).then(() => collaboration.close());
  });

  return {
    ...defaultRuntime,
    config: defaultRuntime.config,
    collaboration,
    runtimes,
    getRuntime,
    topologyLayoutService,
    sshConnections,
    sshEnvironments,
    server,
  };
}

export async function startMvpServer(options = {}) {
  const requestedPort =
    options.port ?? (await loadConfig(options.config ?? {})).server.port;
  const app = await createMvpApplication({
    ...options,
    testMode: options.testMode ?? requestedPort === 0,
  });
  const host = options.host ?? app.config.server.host;
  const port = options.port ?? app.config.server.port;
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(port, host, resolve);
  });
  const address = app.server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  app.sourceRefresh.start();
  app.curatorTriggerCoordinator.start();
  return { ...app, url: `http://${host}:${actualPort}` };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (
  invokedPath &&
  invokedPath === path.resolve(fileURLToPath(import.meta.url))
) {
  const app = await startMvpServer();
  process.stdout.write(`Topolumia Adapter MVP running at ${app.url}\n`);
}
