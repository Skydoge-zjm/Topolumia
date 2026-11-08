import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
import { readJson, sendJson } from "../../../lib/http.js";
import { fail } from "../../../domain/research/access.js";
import { recordIngestionCapabilities } from "../../../domain/research/record-ingestion.js";

export async function handleRecordIngestionRoutes({
  request,
  response,
  pathname,
  url,
  requestRuntime,
  requestActor,
}) {
  const service = requestRuntime.researchCommands.ingestion;
  const collector = pathname.match(
    /^\/api\/record-ingestion\/([^/]+)\/(capabilities|batches|attachments)(?:\/([a-f0-9]{64}))?$/,
  );
  const research = pathname.match(
    /^\/api\/research\/record-blocks\/([^/]+)\/(version|status|events|snapshots|grants)(?:\/([^/]+)\/(revoke|renew))?$/,
  );
  if (!collector && !research) return false;
  const match = collector ?? research,
    blockId = decodeURIComponent(match[1]),
    action = match[2],
    actor = requestActor;
  service.block(blockId, actor, Boolean(collector));
  if (collector) {
    if (!actor.collectorGrant)
      fail(
        "COLLECTOR_CREDENTIAL_REQUIRED",
        "此入口需要绑定记录块的采集凭据。",
        403,
      );
    if (action === "capabilities" && request.method === "GET") {
      sendJson(response, 200, recordIngestionCapabilities);
      return true;
    }
    if (action === "batches" && request.method === "POST") {
      if (
        request.headers["content-encoding"] &&
        request.headers["content-encoding"] !== "gzip"
      )
        fail("ENCODING_UNSUPPORTED", "使用 JSON 或 gzip。", 415);
      const body =
        request.headers["content-encoding"] === "gzip"
          ? request.pipe(createGunzip())
          : request;
      const result = service.receive(
        blockId,
        await readJson(body, recordIngestionCapabilities.maxBatchBytes),
        actor,
      );
      sendJson(response, 200, result);
      return true;
    }
    if (action === "attachments" && match[3] && request.method === "PUT") {
      sendJson(
        response,
        200,
        await service.uploadAttachment(blockId, match[3], request, actor),
      );
      return true;
    }
  } else {
    if (action === "version" && request.method === "GET") {
      sendJson(response, 200, service.version(blockId, actor));
      return true;
    }
    if (action === "status" && request.method === "GET") {
      sendJson(response, 200, service.status(blockId, actor));
      return true;
    }
    if (action === "events" && request.method === "GET") {
      sendJson(
        response,
        200,
        service.events(blockId, actor, {
          after: Number(url.searchParams.get("after") ?? 0),
          limit: Number(url.searchParams.get("limit") ?? 50),
          snapshotId: url.searchParams.get("snapshotId") ?? undefined,
          runId: url.searchParams.get("runId") ?? undefined,
          kind: url.searchParams.get("kind") ?? undefined,
        }),
      );
      return true;
    }
    if (action === "snapshots" && request.method === "POST") {
      sendJson(response, 201, service.snapshot(blockId, actor));
      return true;
    }
    if (action === "grants" && request.method === "POST") {
      await readJson(request, 8192);
      sendJson(
        response,
        200,
        match[3]
          ? service.changeGrant(
              blockId,
              decodeURIComponent(match[3]),
              match[4],
              actor,
            )
          : service.grant(blockId, actor),
      );
      return true;
    }
  }
  fail("METHOD_NOT_ALLOWED", "此入口不支持该方法。", 405);
}

export async function handleRecordAttachmentRead({
  request,
  response,
  pathname,
  requestRuntime,
  requestActor,
}) {
  const match = pathname.match(
    /^\/api\/research\/record-blocks\/([^/]+)\/attachments\/([a-f0-9]{64})$/,
  );
  if (!match || request.method !== "GET") return false;
  const service = requestRuntime.researchCommands.ingestion,
    blockId = decodeURIComponent(match[1]);
  service.block(blockId, requestActor);
  const requestUrl = new URL(request.url, "http://localhost");
  const snapshotId = requestUrl.searchParams.get("snapshotId"), snapshot = snapshotId ? service.getSnapshot(snapshotId, requestActor) : null;
  if (snapshot && snapshot.blockId !== blockId) fail("INGESTION_SCOPE_MISMATCH", "快照不属于记录块。", 403);
  const row = requestRuntime.researchCommands.projectRecords.attachment(snapshot?.block ?? service.block(blockId, requestActor), match[2], snapshot);
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": row.size,
    "x-content-type-options": "nosniff",
    "content-disposition": "attachment",
  });
  createReadStream(row.path)
    .on("error", (error) => response.destroy(error))
    .pipe(response);
  return true;
}
