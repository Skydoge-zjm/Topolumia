import { AppError } from "../../../lib/errors.js";
import { readJson, sendJson } from "../../../lib/http.js";

export async function handlePlatformSourcesRoutes(context) {
  const { request, response, pathname, sourceRefresh } = context;

  if (pathname === "/api/source-refresh" && request.method === "POST") {
    const body = await readJson(request);
    const allowedReasons = new Set([
      "manual",
      "workspace-opened",
      "workspace-visible",
      "foreground-interval",
    ]);
    const reason = allowedReasons.has(body?.reason) ? body.reason : "manual";
    const result = await sourceRefresh.refresh({
      reason,
      force: reason === "manual",
    });
    sendJson(response, result.outcome === "deferred" ? 202 : 200, result);
    return true;
  }
  if (pathname === "/api/sync" && request.method === "POST") {
    const result = await sourceRefresh.refresh({
      reason: "manual",
      force: true,
    });
    if (result.outcome === "deferred") {
      throw new AppError(
        "SOURCE_REFRESH_DEFERRED",
        "研究来源将在当前任务结束后检查。",
        { status: 409 },
      );
    }
    sendJson(response, 200, result.snapshot);
    return true;
  }

  return false;
}
