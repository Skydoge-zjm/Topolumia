import * as z from "zod/v4";
import type { RouteContext } from "../../route-context.js";
import { readJsonObject, sendJson, parseInput } from "../../../lib/http.js";
import { requirePermission, fail } from "../../../domain/research/access.js";
import { groupRef } from "../../../domain/research/object-ref.js";
import { pendingObjectCandidates } from "../../../services/research/changes/candidate-summary.js";

export async function handleResearchGroupRoutes({ request, response, pathname, url, requestRuntime: runtime, requestActor: actor }: RouteContext) {
  const match = pathname.match(/^\/api\/research-groups(?:\/([^/]+))?(?:\/(core|members|parent|primary-relations|delete-impact))?$/);
  if (!match) return false;
  const c = runtime.researchCommands, q = c.queries, id = match[1] && decodeURIComponent(match[1]), segment = match[2];
  requirePermission(actor, request.method === "GET" ? "research.view" : "research.applyChange");
  if (actor.isAgent && request.method !== "GET") fail("REVIEW_REQUIRES_USER", "Agent changes require human review.", 403);
  if (request.method === "GET") {
    const page = { actor, limit: Number(url.searchParams.get("limit") ?? 20), cursor: url.searchParams.get("cursor") ?? undefined, maxChars: 16000 };
    if (!id) sendJson(response, 200, q.readGroups({ ...page, mode: "list", query: url.searchParams.get("q") ?? undefined }));
    else if (segment === "members") sendJson(response, 200, q.readGroups({ ...page, mode: "members", groupId: id, scope: url.searchParams.get("scope") ?? "direct", query: url.searchParams.get("q") ?? undefined }));
    else if (segment === "delete-impact") sendJson(response, 200, q.readGroups({ ...page, mode: "show", groupId: id, section: "deleteImpact" }));
    else { const detail = c.groups.detail(id); sendJson(response, 200, { ...detail, pendingCandidates: pendingObjectCandidates(c, groupRef(id), actor) }); }
    return true;
  }
  const body = await readJsonObject(request, 262144);
  if (request.method === "POST" && !id) { const result = c.changes.direct([{ ...body, op: "addGroup", clientRef: "group" }], actor, "create node group"); sendJson(response, 201, c.groups.detail(result.allocation["group:group"])); return true; }
  if (!id) return false;
  let op;
  if (request.method === "PATCH" && segment === "core") op = { ...body, op: "updateCore", owner: groupRef(id) };
  else if (request.method === "PATCH" && segment === "members") op = { ...body, op: "updateMembers", groupId: id };
  else if (request.method === "PATCH" && segment === "parent") op = { ...body, op: "setGroupParent", groupId: id };
  else if (request.method === "PATCH" && segment === "primary-relations") op = { ...body, op: "setGroupPrimaryRelations", groupId: id };
  else if (request.method === "DELETE" && !segment) op = { ...body, op: "deleteGroup", groupId: id };
  else return false;
  c.changes.direct([op], actor, typeof body.reason === "string" ? body.reason : "edit node group");
  const remainingInScope = segment === "members" ? parseInput(z.object({remove:z.array(z.string()).default([])}),body.patch ?? {}).remove.filter(nodeId => c.groups.range(id).nodeIds.includes(nodeId)) : [];
  sendJson(response, 200, request.method === "DELETE" ? { deleted: true, id } : { ...c.groups.detail(id), remainingInScope });
  return true;
}
