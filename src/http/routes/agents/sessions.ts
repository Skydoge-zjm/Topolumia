import { readJson, sendJson } from "../../../lib/http.js";

import { buildResearchMcpBinding } from "../../../agent/research-mcp-binding.js";
import { MCP_SESSION_HINT } from "../../../domain/research/research-mcp-contract.js";

import {
  agentResearchContext,
  saveAgentMessage,
} from "../../../services/agents/agent-workbench-service.js";

import { openSessionEventStream } from "../../streams.js";
import { agentContextFromRequest } from "../../presenters.js";
import { sessionResearchChanges } from "../../../services/agents/agent-research-changes.js";
import { streamAgentImage, streamStoredAgentImage } from "../../../services/agents/agent-image-service.js";

export async function handleAgentsSessionsRoutes(context) {
  const {
    request,
    response,
    url,
    pathname,
    requestedProjectId,
    requestActor,
    collaboration,
    config,
    researchCommands,
    state,
    curatorTriggerCoordinator,
    agentSessionGateway,
    topologyService,
    commandActor,
    ensureFreshForContext,
  } = context;

  const runtimeConfig = context.requestRuntime.config;
  const persistMatch = pathname.match(/^\/api\/agent-sessions\/([^/]+)\/persist$/);
  if (persistMatch && request.method === "POST") { sendJson(response, 200, await agentSessionGateway.persist(persistMatch[1])); return true; }
  const media = context.requestRuntime.agentMedia;
  const changesMatch = pathname.match(/^\/api\/agent-sessions\/([^/]+)\/research-changes$/);
  if (changesMatch && request.method === "GET") {
    researchCommands.check(commandActor, "research.view");
    const result = sessionResearchChanges(agentSessionGateway.researchSnapshot(changesMatch[1]), researchCommands);
    const tag = `"${result.version}"`;
    if (request.headers["if-none-match"] === tag) { response.writeHead(304, { etag: tag, "cache-control": "private, no-cache" }); response.end(); }
    else { response.setHeader("etag", tag); sendJson(response, 200, result); }
    return true;
  }
  const attachmentMatch = pathname.match(/^\/api\/agent-sessions\/([^/]+)\/attachments(?:\/([^/]+))?$/);
  if (attachmentMatch) {
    const sessionId = decodeURIComponent(attachmentMatch[1]);
    agentSessionGateway.snapshot(sessionId);
    if (!attachmentMatch[2] && request.method === "POST") {
      await media.collect(() => agentSessionGateway.list());
      sendJson(response, 201, { attachment: await media.upload(request, sessionId) });
      return true;
    }
    if (attachmentMatch[2] && request.method === "DELETE") {
      const session = agentSessionGateway.snapshot(sessionId);
      const references = new Set([...(session.turns ?? []), ...(session.queuedMessages ?? [])].flatMap(message => (message.attachments ?? []).map(image => image.id)));
      await media.removeDraft(sessionId, decodeURIComponent(attachmentMatch[2]), references);
      sendJson(response, 200, { removed: true }); return true;
    }
    if (attachmentMatch[2] && request.method === "GET") {
      await streamStoredAgentImage(request, response, await media.content(sessionId, decodeURIComponent(attachmentMatch[2]), url.searchParams.get("variant") ?? "original"));
      return true;
    }
  }
  const sessionImageMatch = pathname.match(/^\/api\/agent-sessions\/([^/]+)\/images\/([^/]+)$/);
  if (sessionImageMatch && request.method === "GET") {
    await streamAgentImage(response,
      agentSessionGateway.snapshot(decodeURIComponent(sessionImageMatch[1])),
      decodeURIComponent(sessionImageMatch[2]), runtimeConfig.project.root, media, url.searchParams.get("variant") ?? "original", request);
    return true;
  }
  if (pathname === "/api/agent-profiles" && request.method === "GET") {
    const refresh = ["true", "1"].includes(url.searchParams.get("refresh"));
    sendJson(response, 200, {
      schemaVersion: "agent-profiles.v1",
      profiles: await agentSessionGateway.profiles({ refresh }),
    });
    return true;
  }
  if (pathname === "/api/agent-sessions" && request.method === "GET") {
    sendJson(response, 200, {
      schemaVersion: "agent-sessions.v1",
      sessions: agentSessionGateway.list({
        summary: url.searchParams.get("view") === "summary",
      }),
    });
    return true;
  }
  if (pathname === "/api/agent-sessions" && request.method === "POST") {
    const body = await readJson(request);
    await ensureFreshForContext("before-agent-session");
    const context = agentContextFromRequest(state, topologyService, body);
    const baseUrl = `http://127.0.0.1:${request.socket.localPort}`;
    const session = await agentSessionGateway.create({
      profileId: String(body?.profileId ?? ""),
      model: typeof body?.model === "string" ? body.model.trim() : undefined,
      reasoningEffort:
        typeof body?.reasoningEffort === "string"
          ? body.reasoningEffort.trim()
          : undefined,
      title: body?.title,
      locale: body?.locale,
      cwd: runtimeConfig.project.root,
      context,
      ownerUserId: requestActor.user.id,
      mcpBindingFactory: ({ runtimeInstanceId, researchSessionId }) =>
        buildResearchMcpBinding({
          baseUrl,
          runtimeInstanceId, researchSessionId, dataRoot: runtimeConfig.userSettings.file.replace(/[\\/][^\\/]+$/, ""),
          projectId: requestedProjectId,
          cwd: runtimeConfig.project.root,
          sessionToken: collaboration.issueAgentCredential(
            requestActor,
            requestedProjectId,
            runtimeInstanceId,
            { researchSessionId },
          ),
        }),
      developerInstructions: MCP_SESSION_HINT,
    });
    sendJson(response, 201, session);
    return true;
  }
  if (pathname === "/api/agent-sessions/search" && request.method === "GET") {
    sendJson(
      response,
      200,
      agentSessionGateway.searchMessages(url.searchParams.get("q"), {
        includeArchived: url.searchParams.get("includeArchived") === "true",
      }),
    );
    return true;
  }
  const sessionEventsMatch = pathname.match(
    /^\/api\/agent-sessions\/([^/]+)\/events$/,
  );
  if (sessionEventsMatch && request.method === "GET") {
    const after = Math.max(
      0,
      Number(url.searchParams.get("after")) || 0,
      Number(request.headers["last-event-id"]) || 0,
    );
    openSessionEventStream(
      request,
      response,
      agentSessionGateway,
      sessionEventsMatch[1],
      after,
      {
        validate: () => {
          const actor = collaboration.requireActor(request, requestedProjectId);
          collaboration.requireProject(actor, requestedProjectId);
          collaboration.requirePermission(actor, "project.view", { projectId: requestedProjectId });
        },
        subscribe: check => { collaboration.on("access-changed", check); return () => collaboration.off("access-changed", check); },
      },
    );
    return true;
  }
  const sessionTurnMatch = pathname.match(
    /^\/api\/agent-sessions\/([^/]+)\/turns$/,
  );
  if (sessionTurnMatch && request.method === "POST") {
    const body = await readJson(request);
    const attachments = await media.resolve(sessionTurnMatch[1], body.attachmentIds);
    const turn = agentSessionGateway.startTurn(sessionTurnMatch[1], { ...body, attachments });
    sendJson(response, 202, turn);
    return true;
  }
  const sessionApprovalMatch = pathname.match(
    /^\/api\/agent-sessions\/([^/]+)\/approvals\/([^/]+)$/,
  );
  const sessionQueueMatch = pathname.match(
    /^\/api\/agent-sessions\/([^/]+)\/queue\/([^/]+)$/,
  );
  if (sessionQueueMatch && request.method === "PATCH") {
    sendJson(
      response,
      200,
      agentSessionGateway.editQueuedMessage(
        sessionQueueMatch[1],
        sessionQueueMatch[2],
        await readJson(request),
      ),
    );
    return true;
  }
  if (sessionQueueMatch && request.method === "DELETE") {
    sendJson(
      response,
      200,
      agentSessionGateway.removeQueuedMessage(
        sessionQueueMatch[1],
        sessionQueueMatch[2],
      ),
    );
    return true;
  }
  if (
    sessionQueueMatch &&
    sessionQueueMatch[2] === "resume" &&
    request.method === "POST"
  ) {
    sendJson(
      response,
      200,
      agentSessionGateway.resumeQueue(sessionQueueMatch[1]),
    );
    return true;
  }
  if (sessionApprovalMatch && request.method === "POST") {
    const body = await readJson(request);
    const result = await agentSessionGateway.resolveApproval(
      sessionApprovalMatch[1],
      sessionApprovalMatch[2],
      body,
      requestActor,
    );
    sendJson(response, 200, result);
    return true;
  }
  const sessionCancelMatch = pathname.match(
    /^\/api\/agent-sessions\/([^/]+)\/cancel$/,
  );
  if (sessionCancelMatch && request.method === "POST") {
    sendJson(response, 202, agentSessionGateway.cancel(sessionCancelMatch[1]));
    return true;
  }
  const sessionResumeMatch = pathname.match(
    /^\/api\/agent-sessions\/([^/]+)\/(resume|permissions\/reset)$/,
  );
  if (sessionResumeMatch && request.method === "POST") {
    const body = await readJson(request);
    const baseUrl = `http://127.0.0.1:${request.socket.localPort}`;
    const resumeAction =
      sessionResumeMatch[2] === "permissions/reset"
        ? agentSessionGateway.resetPermissions.bind(agentSessionGateway)
        : agentSessionGateway.resume.bind(agentSessionGateway);
    const resumed = await resumeAction(sessionResumeMatch[1], {
      ...body,
      cwd: runtimeConfig.project.root,
      ownerUserId: requestActor.user.id,
      mcpBindingFactory: ({ runtimeInstanceId, researchSessionId }) =>
        buildResearchMcpBinding({
          baseUrl,
          runtimeInstanceId, researchSessionId, dataRoot: runtimeConfig.userSettings.file.replace(/[\\/][^\\/]+$/, ""),
          projectId: requestedProjectId,
          cwd: runtimeConfig.project.root,
          sessionToken: collaboration.issueAgentCredential(
            requestActor,
            requestedProjectId,
            runtimeInstanceId,
            { researchSessionId },
          ),
        }),
      developerInstructions: MCP_SESSION_HINT,
    });
    curatorTriggerCoordinator.noteActivity();
    void curatorTriggerCoordinator
      .consider("continuity_break", {
        sessionId: null,
        entryContext: {
          surface: "agent-session",
          action: "resumed",
          previousSessionId: sessionResumeMatch[1],
          resumedSessionId: resumed.id,
        },
      })
      .catch(() => {});
    sendJson(response, 200, resumed);
    return true;
  }
  const sessionSyncMatch = pathname.match(
    /^\/api\/agent-sessions\/([^/]+)\/sync$/,
  );
  if (sessionSyncMatch && request.method === "POST") {
    const body = await readJson(request);
    sendJson(
      response,
      200,
      await agentSessionGateway.sync(sessionSyncMatch[1], {
        reason: body?.reason ?? "manual",
      }),
    );
    return true;
  }
  const sessionCloseMatch = pathname.match(
    /^\/api\/agent-sessions\/([^/]+)\/close$/,
  );
  if (sessionCloseMatch && request.method === "POST") {
    const closed = await agentSessionGateway.close(sessionCloseMatch[1]);
    curatorTriggerCoordinator.noteActivity();
    void curatorTriggerCoordinator
      .consider("continuity_break", {
        sessionId: closed.id,
        entryContext: { surface: "agent-session", action: "closed" },
      })
      .catch(() => {});
    sendJson(response, 200, closed);
    return true;
  }
  const sessionMatch = pathname.match(/^\/api\/agent-sessions\/([^/]+)$/);
  const sessionContextMatch = pathname.match(
    /^\/api\/agent-sessions\/([^/]+)\/context$/,
  );
  if (sessionContextMatch && request.method === "GET") {
    researchCommands.check(commandActor, "research.view");
    sendJson(
      response,
      200,
      agentResearchContext(
        agentSessionGateway.researchSnapshot(sessionContextMatch[1]),
        researchCommands,
      ),
    );
    return true;
  }
  const sessionNotesMatch = pathname.match(
    /^\/api\/agent-sessions\/([^/]+)\/notes$/,
  );
  if (sessionNotesMatch && request.method === "POST") {
    const body = await readJson(request);
    const result = saveAgentMessage(
      agentSessionGateway.snapshot(sessionNotesMatch[1]),
      researchCommands,
      commandActor,
      body.eventIds,
    );
    sendJson(response, result.idempotent ? 200 : 201, result);
    return true;
  }
  if (sessionMatch && request.method === "PATCH") {
    sendJson(
      response,
      200,
      await agentSessionGateway.updateSession(
        sessionMatch[1],
        await readJson(request),
      ),
    );
    return true;
  }
  if (sessionMatch && request.method === "GET") {
    sendJson(response, 200, agentSessionGateway.snapshot(sessionMatch[1]));
    return true;
  }

  return false;
}
