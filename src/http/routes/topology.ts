import type { RouteContext } from "../route-context.js";
import { AppError } from "../../lib/errors.js";
import { readJsonObject, sendJson } from "../../lib/http.js";


export async function handleTopologyRoutes(context: RouteContext) {
  const {
    request,
    response,
    url,
    pathname,
    topologyLayoutService,
    curatorTriggerCoordinator,
  }: RouteContext = context;

  if (
    pathname === "/api/topology/curation/status" &&
    request.method === "GET"
  ) {
    sendJson(response, 200, curatorTriggerCoordinator.statusView());
    return true;
  }
  if (
    pathname === "/api/topology/curation/trigger" &&
    request.method === "POST"
  ) {
    const body = await readJsonObject(request);
    const triggered = await curatorTriggerCoordinator.trigger(body ?? {});
    const statusCode =
      triggered.status === "queued"
        ? 202
        : triggered.result?.disposition === "proposal"
          ? 201
          : 200;
    sendJson(response, statusCode, triggered);
    return true;
  }
  if (pathname === "/api/topology" && request.method === "GET") {
    sendJson(response, 200, context.requestRuntime.researchCommands.formalTopology());
    return true;
  }
  if (pathname === "/api/topology/layout" && request.method === "GET") {
    const requestedEngine = url.searchParams.get("engine") ?? "elk";
    if (!["elk", "force", "semantic-force"].includes(requestedEngine)) {
      throw new AppError(
        "TOPOLOGY_LAYOUT_ENGINE_INVALID",
        "不支持的拓扑布局引擎。",
        {
          status: 422,
          detail: { engine: requestedEngine, supported: ["elk", "force"] },
        },
      );
    }
    sendJson(
      response,
      200,
      await topologyLayoutService.layout(context.requestRuntime.researchCommands.formalTopology(), {
        engine: requestedEngine,
      }),
    );
    return true;
  }
  if (
    pathname === "/api/topology/curation/preview" &&
    request.method === "POST"
  ) {
    const body = await readJsonObject(request);
    const triggered = await curatorTriggerCoordinator.trigger({
      ...(body ?? {}),
      mode: "manual",
      cause: "user_request",
      bypassDedup: true,
    });
    const statusCode = triggered.result?.disposition === "proposal" ? 201 : 200;
    sendJson(response, statusCode, triggered.result ?? triggered);
    return true;
  }
  return false;
}
