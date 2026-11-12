import type { RouteContext } from "../route-context.js";
import { readJsonObject, sendJson } from "../../lib/http.js";

export async function handleExperimentsRoutes(context: RouteContext) {
  const { request, response, pathname } = context;

  if (pathname === "/api/research-experiments" && request.method === "GET") {
    sendJson(
      response,
      200,
      context.requestRuntime.researchCommands.records.list(
        context.requestActor,
      ),
    );
    return true;
  }
  const researchExperimentDetailMatch = pathname.match(
    /^\/api\/research-experiments\/([^/]+)$/,
  );
  if (researchExperimentDetailMatch && request.method === "GET") {
    const nodeId = decodeURIComponent(researchExperimentDetailMatch[1]);
    sendJson(
      response,
      200,
      context.requestRuntime.researchCommands.records.overview(
        nodeId,
        context.requestActor,
      ),
    );
    return true;
  }
  if (pathname === "/api/research/experiments/mlflow/catalog" && request.method === "GET") {
    sendJson(response, 200, await context.requestRuntime.mlflowRecords.catalog(context.requestActor));
    return true;
  }
  if (pathname === "/api/research/experiments/mlflow/import" && request.method === "POST") {
    sendJson(response, 201, await context.requestRuntime.mlflowRecords.import(await readJsonObject(request), context.requestActor));
    return true;
  }
  return false;
}
