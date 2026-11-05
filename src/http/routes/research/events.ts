import { AppError } from "../../../lib/errors.js";
import { readJson, sendJson } from "../../../lib/http.js";

import { validateResearchEvent } from "../../../domain/validators.js";

export async function handleResearchEventsRoutes(context) {
  const {
    request,
    response,
    pathname,
    state,
    curatorTriggerCoordinator,
    topologyService,
  } = context;

  if (pathname === "/api/agent-events" && request.method === "GET") {
    sendJson(response, 200, {
      schemaVersion: "research-events.v1",
      events: state.agentEvents,
      count: state.agentEvents.length,
    });
    return true;
  }
  if (pathname === "/api/agent-events" && request.method === "POST") {
    const body = await readJson(request);
    const snapshotRefs = topologyService
      .sourceIndex(state.snapshot)
      .map((item) => item.ref);
    const nodeIds = Array.isArray(body?.nodeIds)
      ? body.nodeIds.map(String)
      : [];
    const sourceRefs = Array.isArray(body?.sourceRefs)
      ? body.sourceRefs.map(String)
      : [];
    validateResearchEvent(
      {
        schemaVersion: "research-event.v1",
        id: "human-input",
        type: "humanResearchMove",
        occurredAt: new Date().toISOString(),
        actor: "user",
        sessionId: null,
        nodeIds,
        sourceRefs,
        payload: { text: body?.text },
      },
      {
        allowedNodeIds: state.topology.nodes.map((item) => item.id),
        allowedSourceRefs: snapshotRefs,
      },
    );
    if (
      typeof body?.text !== "string" ||
      body.text.trim().length === 0 ||
      body.text.length > 2_000
    ) {
      throw new AppError("HUMAN_MOVE_REQUIRED", "请填写一条研究进展。", {
        status: 422,
      });
    }
    const event = state.recordEvent({
      type: "humanResearchMove",
      actor: "user",
      sessionId: null,
      nodeIds,
      sourceRefs,
      payload: { text: body.text.trim() },
    });
    curatorTriggerCoordinator.noteActivity();
    void curatorTriggerCoordinator
      .consider("session_checkpoint", {
        sessionId: event.sessionId,
        nodeIds: event.nodeIds,
        sourceRefs: event.sourceRefs,
        entryContext: { surface: "human-research", action: "recorded" },
        force: true,
      })
      .catch(() => {});
    sendJson(response, 201, event);
    return true;
  }

  return false;
}
