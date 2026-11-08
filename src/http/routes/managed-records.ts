import { readJson, sendJson } from "../../lib/http.js";
import { fail } from "../../domain/research/access.js";
import * as z from "zod/v4";

const assignSchema = z.strictObject({ runs: z.array(z.strictObject({ sourceId: z.string().min(1).max(500), runId: z.string().min(1).max(500) })).min(1).max(200), nodeId: z.string().min(1).max(240).optional(), nodeName: z.string().trim().min(1).max(240).optional(), expectedCollectionRevision: z.number().int().positive().optional(), title: z.string().trim().min(1).max(240).optional() });

export async function handleManagedRecordRoutes(context) {
  const { request, response, pathname, url, requestActor: actor, requestRuntime: runtime, recordCollectors: manager } = context;
  if (pathname === "/api/research/training-records/assign" && request.method === "POST") {
    const parsed = assignSchema.safeParse(await readJson(request, 65536));
    if (!parsed.success || !parsed.data.nodeId && !parsed.data.nodeName) fail("INPUT_INVALID", "请选择实验或填写新实验名称。", 422);
    sendJson(response, 201, runtime.researchCommands.projectRecords.assign(parsed.data, actor)); return true;
  }
  if (pathname === "/api/research/training-records" && request.method === "GET") {
    sendJson(response, 200, runtime.researchCommands.projectRecords.directory(actor, { offset: Number(url.searchParams.get("offset") ?? 0), limit: Number(url.searchParams.get("limit") ?? 50), q: url.searchParams.get("q") ?? "", provider: url.searchParams.get("provider") ?? "", hostId: url.searchParams.get("hostId") ?? "", unassigned: url.searchParams.get("unassigned") === "true" }));
    return true;
  }
  const base = "/api/tools-environment/record-collectors";
  if (!pathname.startsWith(base)) return false;
  const hostId = request.headers["x-rw-ssh-id"] ?? "local";
  if (typeof hostId !== "string" || hostId !== "local" && !/^[a-f0-9-]{36}$/.test(hostId)) fail("SSH_CONNECTION_INVALID", "SSH 连接标识无效。", 422);
  if (pathname === base && request.method === "GET") { sendJson(response, 200, manager.view(runtime, actor, hostId)); return true; }
  const enable = pathname.match(/^\/api\/tools-environment\/record-collectors\/(wandb|tensorboard)\/enable$/);
  if (enable && request.method === "POST") {
    const body = await readJson(request, 16384);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "directories")) fail("COLLECTION_CONFIG_INVALID", "采集配置无效。", 422);
    sendJson(response, 202, await manager.enable(runtime, actor, hostId, enable[1], body.directories)); return true;
  }
  const source = pathname.match(/^\/api\/tools-environment\/record-collectors\/sources\/([^/]+)\/(pause|resume)$/);
  if (source && request.method === "POST") {
    await readJson(request, 1024);
    const id = decodeURIComponent(source[1]), value = runtime.researchCommands.projectRecords.get(id);
    if (!value || value.userId !== actor.user.id) fail("COLLECTION_NOT_FOUND", "采集来源不存在。", 404);
    sendJson(response, 202, source[2] === "pause" ? await manager.pause(runtime, actor, id) : await manager.resume(runtime, actor, id)); return true;
  }
  fail("METHOD_NOT_ALLOWED", "此入口不支持该方法。", 405);
}
