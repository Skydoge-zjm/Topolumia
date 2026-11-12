import type { ResearchCommandService } from "../../../services/research/research-command-service.js";
import { recordPlotInputSchema, recordTableInputSchema } from "../../../domain/research/experiment-records.js";
import type { RouteContext } from "../../route-context.js";
import { readJsonObject, sendJson, parseInput } from "../../../lib/http.js";
import { operationSchemas } from "../../../domain/research/changes/operations.js";

export async function handleExperimentRecordRoutes({
  request,
  response,
  pathname,
  requestRuntime: runtime,
  requestActor: actor,
  url,
}: RouteContext) {
  const c: ResearchCommandService = runtime.researchCommands;
  if (
    pathname === "/api/research/experiments/table" &&
    request.method === "POST"
  ) {
    sendJson(
      response,
      200,
      await c.records.table(parseInput(recordTableInputSchema, await readJsonObject(request, 262144)), actor),
    );
    return true;
  }
  if (
    pathname === "/api/research/experiments/plot" &&
    request.method === "POST"
  ) {
    sendJson(
      response,
      200,
      await c.records.plot(parseInput(recordPlotInputSchema, await readJsonObject(request, 262144)), actor),
    );
    return true;
  }
  const match = pathname.match(/^\/api\/research-nodes\/([^/]+)\/experiment$/);
  if (!match) return false;
  const nodeId = decodeURIComponent(match[1]);
  if (request.method === "GET") {
    sendJson(response, 200, c.records.overview(nodeId, actor, undefined, url?.searchParams.get("blockId") ?? undefined));
    return true;
  }
  if (request.method === "PATCH") {
    const body = await readJsonObject(request, 262144);
    c.check(actor, "research.applyChange");
    const operation = c.changes.validate(operationSchemas.editExperiment, {
      op: "editExperiment",
      owner: { kind: "node", id: nodeId },
      blockId: body.blockId,
      expectedExperimentRevision: body.expectedExperimentRevision,
      patch: body.patch,
    });
    await c.records.prepareMaterialSelections(operation.patch, actor);
    c.changes.direct([operation], actor, "edit experiment records");
    sendJson(response, 200, c.records.overview(nodeId, actor, undefined, operation.blockId));
    return true;
  }
  return false;
}
