import type { RouteContext } from "../../route-context.js";
import { AppError } from "../../../lib/errors.js";
import { readJsonObject, sendJson } from "../../../lib/http.js";
import { requirePermission } from "../../../services/research/research-command-service.js";
import { revision } from "../../../domain/research/workspace-input.js";
import * as z from "zod/v4";
async function bodyObject(request: RouteContext["request"]) {
  const body = await readJsonObject(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("RESEARCH_INPUT_INVALID", "请求内容必须是对象。", { status: 422 });
  return body;
}
const decode = (value: string) => { try { return decodeURIComponent(value); } catch { throw new AppError("RESEARCH_ID_INVALID", "对象标识无效。", { status: 422 }); } };
const expectedRevision = (value: unknown) => {
  const result = revision.safeParse(value);
  if (!result.success) throw new AppError("RESEARCH_REVISION_REQUIRED", "请提供当前内容版本。", { status: 422 });
  return result.data;
};
export async function handleNotebookRoutes({ request, response, pathname, url, requestRuntime: runtime, requestActor: actor }: RouteContext) {
  if (pathname === "/api/research-history" && request.method === "GET") {
    requirePermission(actor, "research.view");
    sendJson(response, 200, runtime.history.list({ query: url.searchParams.get("q") ?? "", category: url.searchParams.get("category") ?? "", actor: url.searchParams.get("actor") ?? "", outcome: url.searchParams.get("outcome") ?? "",
      objectId: url.searchParams.get("objectId") ?? "", proposalId: url.searchParams.get("proposalId") ?? "", offset: Number(url.searchParams.get("offset") ?? 0), limit: Number(url.searchParams.get("limit") ?? 40) })); return true;
  }
  const history = pathname.match(/^\/api\/research-history\/([^/]+)$/);
  if (history && request.method === "GET") {
    requirePermission(actor, "research.view");
    const event = runtime.history.get(decode(history[1]));
    const liveObjects = event.changes.filter(change => {
      if (change.subject.type === "node") return runtime.state.topology?.nodes.some(node => node.id === change.subject.id);
      if (change.subject.type === "group") { try { runtime.researchCommands.groups.get(change.subject.id); return true; } catch { return false; } }
      if (change.subject.type !== "record") return false;
      try { runtime.notebook.get(change.subject.type, change.subject.id); return true; } catch { return false; }
    }).map(change => `${change.subject.type}:${change.subject.id}`);
    sendJson(response, 200, { ...event, liveObjects }); return true;
  }
  if (!/^\/api\/(?:research-records|research-series)(?:\/|$)/.test(pathname)) return false;
  requirePermission(actor, request.method === "GET" ? "research.view" : "research.recordProgress");
  const { records, notebook } = runtime;
  if (pathname === "/api/research-records" && request.method === "GET") {
    sendJson(response, 200, records.list({ query: url.searchParams.get("q") ?? "", type: url.searchParams.get("type") ?? "", status: url.searchParams.get("status") ?? "", offset: Number(url.searchParams.get("offset") ?? 0), limit: Number(url.searchParams.get("limit") ?? 40) })); return true;
  }
  const record = pathname.match(/^\/api\/research-records(?:\/([^/]+)(?:\/(revisions)(?:\/(\d+))?)?)?$/);
  if (record) {
    const id = record[1] && decode(record[1]);
    if (request.method === "GET" && id) {
      const data = record[3] ? notebook.version("record", id, Number(record[3])) : record[2]
        ? { items: records.versions(id).slice(0, 100).map(item => ({ revision: item.revision, updatedAt: item.updatedAt, updatedBy: item.updatedBy, status: item.status })) } : records.get(id);
      sendJson(response, 200, data); return true;
    }
    if (request.method === "POST" && !id || request.method === "PATCH" && id && !record[2]) {
      const { expectedRevision: expected, ...input } = await bodyObject(request);
      sendJson(response, id ? 200 : 201, records.save(input, actor, id ? { id, expectedRevision: expectedRevision(expected) } : {})); return true;
    }
  }
  const series = pathname.match(/^\/api\/research-series(?:\/([^/]+)(?:\/(occurrences))?)?$/);
  if (series) {
    const id = series[1] && decode(series[1]);
    if (request.method === "GET" && !id) { sendJson(response, 200, { items: records.series() }); return true; }
    if (request.method === "POST" && id && series[2]) {
      const parsed = z.strictObject({ date: z.iso.date().optional() }).safeParse(await bodyObject(request));
      if (!parsed.success) throw new AppError("RECORD_OCCURRENCE_INVALID", "场次参数无效。", { status: 422 });
      sendJson(response, 201, records.schedule(id, actor, parsed.data)); return true;
    }
    if (request.method === "POST" && !id || request.method === "PATCH" && id && !series[2]) {
      const { expectedRevision: expected, ...input } = await bodyObject(request);
      sendJson(response, id ? 200 : 201, records.saveSeries(input, actor, id ? { id, expectedRevision: expectedRevision(expected) } : {})); return true;
    }
  }
  throw new AppError("RESEARCH_METHOD_NOT_ALLOWED", "此对象不支持该操作。", { status: 405 });
}
