import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../src/server.js";

const apps = [];
const roots = [];

afterEach(async () => {
  while (apps.length) {
    const app = apps.pop();
    if (app?.server) await new Promise((resolve) => app.server.close(resolve));
  }
  while (roots.length) await rm(roots.pop(), { recursive: true, force: true });
});

async function makeApp() {
  const root = await mkdtemp(path.join(os.tmpdir(), "research-workbench-collaboration-"));
  roots.push(root);
  const app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: path.join(root, "collaboration.sqlite"),
    config: {
      collaboration: { allowDevIdentity: false },
      sourceRefresh: { enabled: false },
    },
  });
  apps.push(app);
  return app;
}

async function request(app, pathName, options = {}) {
  const response = await fetch(`${app.url}${pathName}`, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function bootstrap(app) {
  const result = await request(app, "/api/auth/bootstrap", {
    method: "POST",
    body: JSON.stringify({ username: "admin", displayName: "Admin", password: "long-development-password" }),
  });
  assert.equal(result.response.status, 201);
  const login = await request(app, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "admin", password: "long-development-password" }),
  });
  assert.equal(login.response.status, 200);
  return login.response.headers.get("set-cookie");
}

test("server collaboration isolates projects and persists project state across restart", async () => {
  const app = await makeApp();
  const cookie = await bootstrap(app);
  const createdUser = await request(app, "/api/users", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ username: "researcher", displayName: "Researcher", password: "researcher-password" }),
  });
  assert.equal(createdUser.response.status, 201);
  const createdProject = await request(app, "/api/projects", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ id: "project-b", name: "Project B" }),
  });
  assert.equal(createdProject.response.status, 201);
  const invitation = await request(app, "/api/projects/project-b/invitations", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ userId: createdUser.payload.user.id, role: "researcher" }),
  });
  assert.equal(invitation.response.status, 201);

  const researcherLogin = await request(app, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "researcher", password: "researcher-password" }),
  });
  const researcherCookie = researcherLogin.response.headers.get("set-cookie");
  const accepted = await request(app, `/api/projects/project-b/invitations/${invitation.payload.id}/accept`, {
    method: "POST",
    headers: { cookie: researcherCookie },
  });
  assert.equal(accepted.response.status, 200);

  const deniedDefault = await request(app, "/api/state?projectId=research-project", { headers: { cookie: researcherCookie } });
  assert.equal(deniedDefault.response.status, 404);
  const projectState = await request(app, "/api/state?projectId=project-b", { headers: { cookie: researcherCookie } });
  assert.equal(projectState.response.status, 200);
  assert.equal(projectState.payload.projectId, "project-b");

  const event = await request(app, "/api/agent-events?projectId=project-b", {
    method: "POST",
    headers: { cookie: researcherCookie },
    body: JSON.stringify({ text: "记录项目 B 的研究进展。" }),
  });
  assert.equal(event.response.status, 201);

  const restarted = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: app.config.collaboration.databaseFile,
    config: { collaboration: { allowDevIdentity: false }, sourceRefresh: { enabled: false } },
  });
  apps.push(restarted);
  const restored = await request(restarted, "/api/agent-events?projectId=project-b", { headers: { cookie: researcherCookie } });
  assert.equal(restored.response.status, 200);
  assert.ok(restored.payload.events.some((item) => item.payload?.text === "记录项目 B 的研究进展。"));
});

test("project permission overrides take effect without changing the role", async () => {
  const app = await makeApp();
  const adminCookie = await bootstrap(app);
  const createdUser = await request(app, "/api/users", {
    method: "POST",
    headers: { cookie: adminCookie },
    body: JSON.stringify({ username: "reader", displayName: "Reader", password: "reader-password" }),
  });
  const invitation = await request(app, "/api/projects", {
    method: "POST",
    headers: { cookie: adminCookie },
    body: JSON.stringify({ id: "project-c", name: "Project C" }),
  });
  assert.equal(invitation.response.status, 201);
  const invite = await request(app, "/api/projects/project-c/invitations", {
    method: "POST",
    headers: { cookie: adminCookie },
    body: JSON.stringify({ userId: createdUser.payload.user.id, role: "researcher" }),
  });
  const login = await request(app, "/api/auth/login", { method: "POST", body: JSON.stringify({ username: "reader", password: "reader-password" }) });
  const cookie = login.response.headers.get("set-cookie");
  await request(app, `/api/projects/project-c/invitations/${invite.payload.id}/accept`, { method: "POST", headers: { cookie } });
  const before = await request(app, "/api/auth/me?projectId=project-c", { headers: { cookie } });
  assert.ok(before.payload.permissions.includes("research.applyChange"));
  const denied = await request(app, "/api/projects/project-c/members/" + createdUser.payload.user.id + "/permissions", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ permission: "research.applyChange", effect: "deny", reason: "review required" }),
  });
  assert.equal(denied.response.status, 403);
  const updated = await request(app, "/api/projects/project-c/members", { headers: { cookie: adminCookie } });
  const target = updated.payload.members.find((item) => item.user.id === createdUser.payload.user.id);
  const override = await request(app, `/api/projects/project-c/members/${target.user.id}/permissions`, {
    method: "POST",
    headers: { cookie: adminCookie },
    body: JSON.stringify({ permission: "research.applyChange", effect: "deny", reason: "review required" }),
  });
  assert.equal(override.response.status, 200);
  const after = await request(app, "/api/auth/me?projectId=project-c", { headers: { cookie } });
  assert.equal(after.payload.membership.role, "researcher");
  assert.equal(after.payload.permissions.includes("research.applyChange"), false);
});

test("collaboration context recovers from a stale project and supports member lifecycle controls", async () => {
  const app = await makeApp();
  const adminCookie = await bootstrap(app);
  const createdUser = await request(app, "/api/users", {
    method: "POST",
    headers: { cookie: adminCookie },
    body: JSON.stringify({ username: "stale-reader", displayName: "Stale Reader", password: "reader-password" }),
  });
  const project = await request(app, "/api/projects", {
    method: "POST",
    headers: { cookie: adminCookie },
    body: JSON.stringify({ id: "project-stale", name: "Stale Context Project" }),
  });
  assert.equal(project.response.status, 201);
  const invite = await request(app, "/api/projects/project-stale/invitations", {
    method: "POST",
    headers: { cookie: adminCookie },
    body: JSON.stringify({ userId: createdUser.payload.user.id, role: "researcher" }),
  });
  assert.equal(invite.response.status, 201);
  const userLogin = await request(app, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "stale-reader", password: "reader-password" }),
  });
  const userCookie = userLogin.response.headers.get("set-cookie");
  const pendingContext = await request(app, "/api/collaboration/context", { headers: { cookie: userCookie, "x-rw-project-id": "project-stale" } });
  assert.equal(pendingContext.response.status, 200);
  assert.equal(pendingContext.payload.project, null);
  assert.equal(pendingContext.payload.invitations.length, 1);
  const staleContext = await request(app, "/api/collaboration/context", { headers: { cookie: userCookie, "x-rw-project-id": "research-project" } });
  assert.equal(staleContext.response.status, 200);
  assert.equal(staleContext.payload.project, null);
  assert.equal(staleContext.payload.projects.length, 0);
  const staleMe = await request(app, "/api/auth/me", { headers: { cookie: userCookie, "x-rw-project-id": "research-project" } });
  assert.equal(staleMe.response.status, 200);

  const accepted = await request(app, `/api/projects/project-stale/invitations/${invite.payload.id}/accept`, { method: "POST", headers: { cookie: userCookie } });
  assert.equal(accepted.response.status, 200);
  const members = await request(app, "/api/projects/project-stale/members", { headers: { cookie: adminCookie } });
  const target = members.payload.members.find((item) => item.user.id === createdUser.payload.user.id);
  assert.equal(target.membership.role, "researcher");
  const roleChanged = await request(app, `/api/projects/project-stale/members/${target.user.id}`, {
    method: "PATCH",
    headers: { cookie: adminCookie },
    body: JSON.stringify({ role: "guest" }),
  });
  assert.equal(roleChanged.response.status, 200);
  const afterRole = await request(app, "/api/auth/me?projectId=project-stale", { headers: { cookie: userCookie } });
  assert.equal(afterRole.payload.membership.role, "guest");
  assert.equal(afterRole.payload.permissions.includes("research.recordProgress"), false);
});
