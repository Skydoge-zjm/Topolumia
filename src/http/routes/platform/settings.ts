import { AppError } from "../../../lib/errors.js";
import { readJson, sendJson } from "../../../lib/http.js";

export async function handlePlatformSettingsRoutes(context) {
  const {
    request,
    response,
    pathname,
    requestRuntime,
    applyRuntimeSettings,
    sourceRefresh,
    userSettings,
  } = context;

  if (pathname === "/api/settings" && request.method === "GET") {
    sendJson(response, 200, userSettings.snapshot({ schema: true }));
    return true;
  }
  if (pathname === "/api/settings" && request.method === "PATCH") {
    const body = await readJson(request);
    const patch =
      body?.settings && typeof body.settings === "object"
        ? body.settings
        : body;
    if (
      patch &&
      ["researchEnvironment", "researchLocation", "remoteEnvironment"].some(
        (key) => Object.hasOwn(patch, key),
      )
    )
      throw new AppError(
        "RESEARCH_ENVIRONMENT_USE_SELECTION",
        "请通过科研环境选择接口验证并切换环境。",
        { status: 422 },
      );
    const updated = await userSettings.update(patch);
    applyRuntimeSettings(updated.settings, requestRuntime);
    sendJson(response, 200, {
      ...updated,
      runtime: {
        appliesTo:
          "new Agent sessions and subsequent source/curator operations",
        sourceRefreshScheduled: userSettings.settings.sourceRefresh.enabled,
        activeSessionsUnaffected: true,
      },
    });
    return true;
  }

  return false;
}
