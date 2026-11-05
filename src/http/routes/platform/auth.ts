import { readJson, sendJson } from "../../../lib/http.js";

export async function handlePlatformAuthRoutes(context) {
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
    const body = await readJson(request);
    const user = collaboration.bootstrapAdmin(body);
    const login = collaboration.login(body.username, body.password, {
      ttlMs: config.collaboration.sessionTtlMs,
    });
    response.setHeader(
      "set-cookie",
      `rw_session=${login.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(config.collaboration.sessionTtlMs / 1_000)}`,
    );
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
    const body = await readJson(request);
    const login = collaboration.login(body?.username, body?.password, {
      ttlMs: config.collaboration.sessionTtlMs,
    });
    response.setHeader(
      "set-cookie",
      `rw_session=${login.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(config.collaboration.sessionTtlMs / 1_000)}`,
    );
    sendJson(response, 200, { user: login.user, expiresAt: login.expiresAt });
    return true;
  }
  if (pathname === "/api/auth/logout" && request.method === "POST") {
    const token =
      request.headers["x-rw-session"] ||
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
