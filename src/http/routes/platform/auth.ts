import type { PlatformRouteContext } from "../../route-context.js";
import { readJsonObject, sendJson, requiredString, headerValue } from "../../../lib/http.js";

export function sessionCookie(token: string, ttlMs: number) {
  return `rw_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(Math.max(0, ttlMs) / 1_000)}`;
}

export async function handlePlatformAuthRoutes(context: PlatformRouteContext) {
  const {
    request,
    response,
    pathname,
    requestedProjectId,
    requestActor,
    collaboration,
    config,
  } = context;

  if (pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, {
      status: "ok",
      service: "research-workbench-adapter-mvp",
      now: new Date().toISOString(),
    });
    return true;
  }
  if (pathname === "/api/auth/bootstrap" && request.method === "POST") {
    const body = await readJsonObject(request);
    const user = collaboration.bootstrapAdmin(body);
    const login = collaboration.login(requiredString(body.username), requiredString(body.password), {
      ttlMs: config.collaboration.sessionTtlMs,
    });
    response.setHeader("set-cookie", sessionCookie(login.token, config.collaboration.sessionTtlMs));
    sendJson(response, 201, {
      user,
      expiresAt: login.expiresAt,
      initialized: true,
    });
    return true;
  }
  if (pathname === "/api/auth/status" && request.method === "GET") {
    sendJson(response, 200, {
      initialized:
        collaboration.hasUsers?.() ??
        Boolean(collaboration.userByUsername("admin")),
    });
    return true;
  }
  if (pathname === "/api/auth/login" && request.method === "POST") {
    const body = await readJsonObject(request);
    const login = collaboration.login(requiredString(body.username), requiredString(body.password), {
      ttlMs: config.collaboration.sessionTtlMs,
    });
    response.setHeader("set-cookie", sessionCookie(login.token, config.collaboration.sessionTtlMs));
    sendJson(response, 200, { user: login.user, expiresAt: login.expiresAt });
    return true;
  }
  if (pathname === "/api/auth/logout" && request.method === "POST") {
    const token =
      headerValue(request, "x-rw-session") ||
      (request.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("rw_session="))
        ?.slice("rw_session=".length);
    collaboration.logout(token);
    response.setHeader(
      "set-cookie",
      "rw_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    );
    sendJson(response, 200, { loggedOut: true });
    return true;
  }
  if (pathname === "/api/auth/me" && request.method === "GET") {
    sendJson(response, 200, {
      user: requestActor?.user ?? null,
      projectId: requestedProjectId,
      membership: requestActor?.membership ?? null,
      permissions: requestActor?.permissions ?? [],
    });
    return true;
  }

  return false;
}
