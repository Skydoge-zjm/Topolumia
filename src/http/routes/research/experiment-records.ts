import { readJson, sendJson } from "../../../lib/http.js";
import { operationSchemas } from "../../../domain/research/changes/operations.js";

export async function handleExperimentRecordRoutes({
  request,
  response,
  pathname,
  requestRuntime: runtime,
  requestActor: actor,
  url,
}) {
  const c = runtime.researchCommands;
  if (
    pathname === "/api/research/experiments/table" &&
    request.method === "POST"
  ) {
    sendJson(
      response,
      200,
      await c.records.table(await readJson(request, 262144), actor),
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
      await c.records.plot(await readJson(request, 262144), actor),
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
    const body = await readJson(request, 262144);
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
    sendJson(response, 200, c.records.overview(nodeId, actor, undefined, body.blockId));
    return true;
  }
  return false;
}
