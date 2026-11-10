import { objectRefSchema } from "../../../domain/research/object-schemas.js";
import { parseInput } from "../../../lib/http.js";
import type { RouteContext } from "../../route-context.js";
import { readJsonObject, sendJson } from "../../../lib/http.js";
import { requirePermission, fail } from "../../../domain/research/access.js";
import { objectKey, sameObject } from "../../../domain/research/object-ref.js";

export async function handleResearchObjectRoutes({ request, response, pathname, url, requestRuntime: runtime, requestActor: actor }: RouteContext) {
  const c = runtime.researchCommands;
  if (pathname === "/api/research-relations" || /^\/api\/research-relations\/[^/]+$/.test(pathname)) {
    requirePermission(actor, request.method === "GET" ? "research.view" : "research.applyChange");
    if (request.method === "GET") { const object = JSON.parse(url.searchParams.get("object") ?? "null"); sendJson(response, 200, c.queries.neighbors({ actor, object, scope: url.searchParams.get("scope") ?? "direct", cursor: url.searchParams.get("cursor") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 30), maxChars: 16000 })); return true; }
    const body = await readJsonObject(request, 262144), edgeId = pathname.split("/")[3] && decodeURIComponent(pathname.split("/")[3]);
    let op;
    if (request.method === "POST" && !edgeId) { const { label, expectedEndpointRevisions, ...edge } = body; op = { op: "addEdge", clientRef: "relation", edge, label, expectedEndpointRevisions }; }
    else if (edgeId && ["PATCH", "DELETE"].includes(request.method ?? "GET")) op = { ...body, op: request.method === "DELETE" ? "deleteEdge" : "updateEdge", edgeId };
    else return false;
    const result = c.changes.direct([op], actor, "edit research relation");
    sendJson(response, request.method === "POST" ? 201 : 200, { saved: true, relation: result.topology.edges.find(edge => edge.id === (edgeId ?? result.allocation["edge:relation"])) }); return true;
  }
  const match = pathname.match(/^\/api\/research-objects\/(node|group)\/([^/]+)\/(content-blocks|versions)(?:\/([^/]+))?$/);
  if (!match) return false;
  const owner = parseInput(objectRefSchema, { kind: match[1], id: decodeURIComponent(match[2]) }), segment = match[3], blockId = match[4] && decodeURIComponent(match[4]);
  requirePermission(actor, request.method === "GET" ? "research.view" : "research.applyChange"); c.objects.get(owner);
  if (request.method === "GET") {
    if (segment === "versions") { const versions = c.store.all("versions").filter((value): value is Extract<typeof value, {object: unknown}> => "object" in value && sameObject(value.owner, owner)); const value = blockId ? versions.find(version => String(version.object.revision) === blockId) : { items: versions.map(version => ({ revision: version.object.revision, updatedAt: version.object.updatedAt })).sort((a, b) => b.revision - a.revision) }; if (!value) fail("RESEARCH_REVISION_NOT_FOUND", "Revision not found.", 404); sendJson(response, 200, value); }
    else if (blockId) sendJson(response, 200, url.searchParams.has("revision") ? c.objects.blockVersion(owner, blockId, Number(url.searchParams.get("revision"))) : c.objects.block(owner, blockId));
    else sendJson(response, 200, await c.queries.readBlocks({ actor, mode: "list", owner, limit: Number(url.searchParams.get("limit") ?? 20), cursor: url.searchParams.get("cursor") ?? undefined, maxChars: 16000 }));
    return true;
  }
  const body = await readJsonObject(request, 262144); let op;
  if (segment !== "content-blocks") return false;
  if (request.method === "POST" && blockId === "reorder") op = { ...body, op: "reorderBlocks", owner };
  else if (request.method === "POST" && !blockId) op = { ...body, op: "addBlock", owner, clientRef: "block" };
  else if (request.method === "PATCH" && blockId) op = { ...body, op: "updateBlock", owner, blockId };
  else if (request.method === "DELETE" && blockId) op = { ...body, op: "archiveBlock", owner, blockId };
  else return false;
  const result = c.changes.direct([op], actor, "edit research material");
  sendJson(response, request.method === "POST" ? 201 : 200, { owner, revision: result.allObjects.get(objectKey(owner))?.revision, contentBlock: result.blocks.find(block => block.id === (blockId ?? result.allocation["block:block"])) });
  return true;
}
