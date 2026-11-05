import { readJson, sendJson } from "../../../lib/http.js";
import { requirePermission } from "../../../services/research/research-command-service.js";

export async function handleAgentsConfigurationRoutes(context) {
  const {
    request,
    response,
    pathname,
    requestActor,
    requestRuntime,
    collaboration,
  } = context;

  if (pathname === "/api/agent-configuration" && request.method === "GET") {
    sendJson(response, 200, requestRuntime.agentConfiguration.inventory());
    return true;
  }
  if (
    pathname === "/api/agent-configuration/check" &&
    request.method === "POST"
  ) {
    sendJson(
      response,
      200,
      await requestRuntime.agentConfiguration.check(await readJson(request), {
        actor: requestActor,
        baseUrl: `http://127.0.0.1:${request.socket.localPort}`,
        collaboration,
      }),
    );
    return true;
  }
  const nativeMatch = pathname.match(/^\/api\/agent-configuration\/profiles\/([^/]+)\/native-config$/);
  if (nativeMatch) {
    requirePermission(requestActor, "project.manageSettings");
    if (request.method === "GET") { sendJson(response, 200, await requestRuntime.agentConfiguration.configurationDocument(decodeURIComponent(nativeMatch[1]))); return true; }
    if (request.method === "PUT") { sendJson(response, 200, await requestRuntime.agentConfiguration.saveConfigurationDocument(decodeURIComponent(nativeMatch[1]), await readJson(request))); return true; }
  }
  const agentConfigurationMatch = pathname.match(
    /^\/api\/agent-configuration\/profiles\/([^/]+)$/,
  );
  if (agentConfigurationMatch && request.method === "PATCH") {
    sendJson(
      response,
      200,
      await requestRuntime.agentConfiguration.configure(
        agentConfigurationMatch[1],
        await readJson(request),
      ),
    );
    return true;
  }

  return false;
}
