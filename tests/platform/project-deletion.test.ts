import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { setTimeout as tick } from "node:timers/promises";
import path from "node:path";
import os from "node:os";
import { startMvpServer } from "../../src/server.js";
import { ProjectDataStore } from "../../src/services/platform/project-data-store.js";

async function fixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "topolumia-project-deletion-"),
  );
  const options = {
    port: 0,
    testMode: false,
    collaborationFile: path.join(root, "app.sqlite"),
    userSettingsFile: path.join(root, "settings.json"),
    config: {
      project: { workspacesRoot: path.join(root, "workspaces") },
      sourceRefresh: { enabled: false },
      curator: { enabled: false },
    },
  };
  const app = await startMvpServer(options);
  const user = app.collaboration.bootstrapAdmin({
    username: "owner",
    password: "Project-Deletion-Fixture!",
  });
  const token = app.collaboration.login(
    "owner",
    "Project-Deletion-Fixture!",
  ).token;
  const request = async (
    route,
    {
      method = "GET",
      body,
      session = token,
      project = app.config.project.id,
    }: any = {},
  ) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-rw-session": session,
        "x-rw-project-id": project,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return { app, options, root, user, token, request };
}

test("project deletion requires a human server administrator and the exact project name", async (t) => {
  const { app, request, user } = await fixture(t);
  const created = await request("/api/projects", {
    method: "POST",
    body: { id: "delete-me", name: "Research to remove" },
  });
  assert.equal(created.status, 201);
  const member = app.collaboration.createUser(
    { username: "member", password: "Member-password!" },
    app.collaboration.actorForUser(user.id, "delete-me"),
  );
  const memberToken = app.collaboration.login(
    "member",
    "Member-password!",
  ).token;
  const invitation = await request("/api/projects/delete-me/invitations", {
    method: "POST",
    body: { userId: member.id, role: "p-admin" },
  });
  assert.equal(
    (
      await request(
        `/api/projects/delete-me/invitations/${invitation.data.id}/accept`,
        { method: "POST", session: memberToken },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/projects/delete-me", {
        method: "DELETE",
        session: memberToken,
        body: { name: "Research to remove" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/projects/delete-me", {
        method: "DELETE",
        session: "invalid",
        body: { name: "Research to remove" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/projects/delete-me", {
        method: "DELETE",
        body: { name: "wrong" },
      })
    ).data.error.code,
    "PROJECT_NAME_MISMATCH",
  );
  assert.equal(
    (
      await request("/api/projects/delete-me", {
        method: "DELETE",
        body: { name: "Research to remove", deleteFiles: true },
      })
    ).status,
    422,
  );
  assert.equal(
    app.runtimes.has("delete-me"),
    false,
    "validation does not start the target runtime",
  );
  assert.equal(app.collaboration.projectById("delete-me").status, "active");
});

test("deletion closes idle sessions, revokes project credentials and invitations, and preserves research and original files", async (t) => {
  const { app, request, user, root, token } = await fixture(t);
  const directory = path.join(root, "existing-code");
  await mkdir(directory);
  await writeFile(path.join(directory, "keep.txt"), "original research\n");
  await request("/api/projects", {
    method: "POST",
    body: {
      id: "delete-local",
      name: "Local project",
      workspace: { kind: "local", directory },
    },
  });
  await request("/api/projects", {
    method: "POST",
    body: { id: "keep-project", name: "Other project" },
  });
  const runtime = await app.getRuntime("delete-local"),
    actor = app.collaboration.actorForUser(user.id, "delete-local");
  const source = runtime.researchCommands.projectRecords.configure(
    { provider: "wandb", directory, hostId: "local", hostLabel: "local" },
    actor,
  );
  const grant = runtime.researchCommands.ingestion.grant(source.id, actor);
  const controls = [];
  app.recordCollectors.control = async (_runtime, _source, action) => {
    controls.push(action);
    return { status: "stopped" };
  };
  let closed = false;
  runtime.agentProfileRegistry.createAdapter = async () => ({
    profile: { provider: "codex" },
    start: async () => ({ capabilities: {} }),
    close: async () => {
      closed = true;
    },
  });
  const session = await runtime.agentSessionGateway.create({
    profileId: "fixture",
    ownerUserId: user.id,
  });
  const credential = app.collaboration.issueAgentCredential(
    actor,
    "delete-local",
    session.runtimeInstanceId,
  );
  const invitee = app.collaboration.createUser(
    { username: "invitee", password: "Invitee-password!" },
    actor,
  );
  const invitation = app.collaboration.invite(
    "delete-local",
    { userId: invitee.id },
    actor,
  );
  const event = await request("/api/agent-events", {
    method: "POST",
    project: "delete-local",
    body: { text: "Retained scientific progress" },
  });
  assert.equal(event.status, 201);
  const keepRuntime = await app.getRuntime("keep-project");
  assert.equal(
    (
      await request("/api/projects/delete-local", {
        method: "DELETE",
        session: credential,
        body: { name: "Local project" },
      })
    ).status,
    403,
  );
  const stream = await fetch(
    `${app.url}/api/agent-sessions/${session.id}/events`,
    {
      headers: { "x-rw-session": token, "x-rw-project-id": "delete-local" },
      signal: AbortSignal.timeout(10000),
    },
  );
  assert.equal(stream.status, 200);
  const streamBody = stream.text();
  const deleted = await request("/api/projects/delete-local", {
    method: "DELETE",
    body: { name: "Local project" },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.data, {
    id: "delete-local",
    deleted: true,
    stoppedCollectors: true,
  });
  assert.equal(closed, true);
  assert.match(await streamBody, /event: access.revoked/);
  assert.deepEqual(controls, ["stop"]);
  assert.equal(app.runtimes.has("delete-local"), false);
  assert.equal(await app.getRuntime("keep-project"), keepRuntime);
  assert.equal(app.collaboration.agentCredentials.size, 0);
  const retained = new ProjectDataStore(
    runtime.projectData.filePath,
    "delete-local",
  );
  t.after(() => retained.close());
  assert.equal(
    JSON.parse(
      String(
        retained.db
          .prepare("SELECT body FROM project_record_sources WHERE id=?")
          .get(source.id).body,
      ),
    ).enabled,
    false,
  );
  assert.equal(
    JSON.parse(
      retained.db
        .prepare("SELECT body FROM record_grants WHERE id=?")
        .get(grant.id).body,
    ).revoked,
    true,
  );
  assert.equal(
    app.collaboration.db
      .prepare("SELECT status FROM invitations WHERE id=?")
      .get(invitation.id).status,
    "revoked",
  );
  assert.equal(app.collaboration.invitationsForUser(invitee.id).length, 0);
  assert.equal(
    (
      await request(
        `/api/projects/delete-local/invitations/${invitation.id}/accept`,
        { method: "POST" },
      )
    ).status,
    404,
  );
  for (const route of [
    "/api/projects/delete-local",
    "/api/state?projectId=delete-local",
    "/api/agent-sessions?projectId=delete-local",
    "/api/record-ingestion/capabilities?projectId=delete-local",
  ]) {
    assert.equal((await request(route)).status, 404, route);
  }
  const context = await request("/api/collaboration/context", {
    project: "delete-local",
  });
  assert.equal(context.data.project, null);
  assert.equal(context.data.membership, null);
  assert.equal(
    context.data.projects.some((project) => project.id === "delete-local"),
    false,
  );
  assert.equal(
    (
      await request("/api/projects/delete-local", {
        method: "DELETE",
        body: { name: "Local project" },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request("/api/projects", {
        method: "POST",
        body: { id: "delete-local", name: "Reused ID" },
      })
    ).status,
    409,
  );
  assert.equal(
    await readFile(path.join(directory, "keep.txt"), "utf8"),
    "original research\n",
  );
  assert.ok((await stat(runtime.config.agentSessions.historyFile)).size > 0);
  assert.ok(
    retained
      .loadState()
      .agentEvents.some(
        (event) => event.payload?.text === "Retained scientific progress",
      ),
  );
  assert.equal(
    app.collaboration.db
      .prepare(
        "SELECT count(*) AS count FROM audit_events WHERE project_id=? AND type='project.deleted'",
      )
      .get("delete-local").count,
    1,
  );
  retained.close();
});

test("busy project deletion fails without changing access and concurrent deletes cannot rebuild a retiring runtime", async (t) => {
  const { app, request } = await fixture(t);
  const id = app.config.project.id;
  const runtime = await app.getRuntime(id);
  runtime.activeCriticalOperations++;
  assert.equal(
    (
      await request(`/api/projects/${id}`, {
        method: "DELETE",
        body: { name: runtime.project.name },
      })
    ).data.error.code,
    "PROJECT_BUSY",
  );
  runtime.activeCriticalOperations--;
  assert.equal(app.collaboration.projectById(id).status, "active");
  let release;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = app.recordCollectors.removeProject.bind(
    app.recordCollectors,
  );
  let entered = false;
  app.recordCollectors.removeProject = async (project) => {
    entered = true;
    await blocked;
    return original(project);
  };
  const deleting = request(`/api/projects/${id}`, {
    method: "DELETE",
    body: { name: runtime.project.name },
  });
  while (!entered) await tick(10);
  try {
    const concurrent = await request(`/api/projects/${id}`, {
      method: "DELETE",
      body: { name: runtime.project.name },
    });
    assert.equal(concurrent.data.error.code, "PROJECT_DELETING");
    assert.equal(
      (await request("/api/state")).data.error.code,
      "PROJECT_DELETING",
    );
    await assert.rejects(app.getRuntime(id), { code: "PROJECT_DELETING" });
  } finally {
    release();
  }
  assert.equal((await deleting).status, 200);
  await assert.rejects(app.getRuntime(id), { code: "PROJECT_NOT_FOUND" });
});

test("deleting the default and last project survives restart and still permits login and project creation", async (t) => {
  const { app, options, request, token } = await fixture(t);
  const id = app.config.project.id;
  await writeFile(
    path.join(app.config.project.root, "keep.txt"),
    "managed original",
  );
  assert.equal(
    (
      await request(`/api/projects/${id}`, {
        method: "DELETE",
        body: { name: "Research Project" },
      })
    ).status,
    200,
  );
  await app.close();
  assert.equal(
    await readFile(path.join(app.config.project.root, "keep.txt"), "utf8"),
    "managed original",
  );
  const restarted = await startMvpServer(options);
  t.after(() => restarted.close());
  try {
    const headers = {
      "x-rw-session": token,
      "content-type": "application/json",
    };
    for (const route of [
      "/api/health",
      "/api/auth/me",
      "/api/projects",
      "/api/collaboration/context",
      "/api/project-workspaces/defaults",
      "/api/schemas/research-event",
      "/",
    ]) {
      assert.equal(
        (await fetch(restarted.url + route, { headers })).status,
        200,
        route,
      );
    }
    assert.equal(restarted.runtimes.size, 0);
    const context = await (
      await fetch(restarted.url + "/api/collaboration/context", { headers })
    ).json();
    assert.deepEqual(context.projects, []);
    assert.equal(context.project, null);
    assert.equal(restarted.collaboration.projectById(id).status, "deleted");
    const created = await fetch(restarted.url + "/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "New project" }),
    });
    assert.equal(created.status, 201);
    const project = (await created.json()).project;
    assert.equal(
      (
        await fetch(restarted.url + "/api/state?projectId=" + project.id, {
          headers,
        })
      ).status,
      200,
    );
  } finally {
    await restarted.close();
  }
});

test("an agent starting in the project blocks deletion until startup is complete", async (t) => {
  const { app, request, user } = await fixture(t);
  const runtime = await app.getRuntime(app.config.project.id);
  let release;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.agentProfileRegistry.createAdapter = async () => ({
    profile: { provider: "codex" },
    start: async () => {
      await gate;
      return { capabilities: {} };
    },
    close: async () => {},
  });
  const starting = runtime.agentSessionGateway.create({
    profileId: "fixture",
    ownerUserId: user.id,
  });
  try {
    assert.equal(
      (
        await request(`/api/projects/${runtime.project.id}`, {
          method: "DELETE",
          body: { name: runtime.project.name },
        })
      ).data.error.code,
      "PROJECT_BUSY",
    );
    assert.equal(
      app.collaboration.projectById(runtime.project.id).status,
      "active",
    );
  } finally {
    release();
  }
  await starting;
  assert.equal(
    (
      await request(`/api/projects/${runtime.project.id}`, {
        method: "DELETE",
        body: { name: runtime.project.name },
      })
    ).status,
    200,
  );
});

test("offline record readers are reported while credentials and forwards are still revoked", async (t) => {
  const { app, request, user } = await fixture(t);
  const runtime = await app.getRuntime(app.config.project.id);
  const actor = app.collaboration.actorForUser(user.id, runtime.project.id);
  const source = runtime.researchCommands.projectRecords.configure(
    {
      provider: "wandb",
      directory: "/remote/research",
      hostId: "offline",
      hostLabel: "offline",
    },
    actor,
  );
  const grant = runtime.researchCommands.ingestion.grant(source.id, actor);
  let closed = false;
  const key = app.recordCollectors.key(runtime, source);
  app.recordCollectors.forwards.set(key, {
    close() {
      closed = true;
    },
  });
  app.recordCollectors.control = async () => {
    throw new Error("SSH disconnected");
  };
  const deleted = await request(`/api/projects/${runtime.project.id}`, {
    method: "DELETE",
    body: { name: runtime.project.name },
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.stoppedCollectors, false);
  assert.equal(closed, true);
  assert.equal(app.recordCollectors.forwards.has(key), false);
  const retained = new ProjectDataStore(
    runtime.projectData.filePath,
    runtime.project.id,
  );
  t.after(() => retained.close());
  assert.equal(
    JSON.parse(
      retained.db
        .prepare("SELECT body FROM record_grants WHERE id=?")
        .get(grant.id).body,
    ).revoked,
    true,
  );
  assert.equal(
    JSON.parse(
      String(
        retained.db
          .prepare("SELECT body FROM project_record_sources WHERE id=?")
          .get(source.id).body,
      ),
    ).enabled,
    false,
  );
  retained.close();
});

test("database failure rolls project deletion and authority changes back together", async (t) => {
  const { app, user } = await fixture(t);
  const id = app.config.project.id,
    actor = app.collaboration.actorForUser(user.id, id);
  const credential = app.collaboration.issueAgentCredential(
    actor,
    id,
    "fixture-runtime",
  );
  app.collaboration.db.exec(
    "CREATE TRIGGER reject_project_deletion BEFORE INSERT ON audit_events WHEN NEW.type='project.deleted' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
  );
  let notifications = 0;
  app.collaboration.on("access-changed", () => {
    notifications++;
  });
  assert.throws(
    () => app.collaboration.deleteProject(id, "Research Project", actor),
    /synthetic audit failure/,
  );
  assert.equal(app.collaboration.projectById(id).status, "active");
  assert.equal(app.collaboration.membership(id, user.id).status, "active");
  assert.equal(notifications, 0);
  assert.ok(app.collaboration.agentCredentials.size);
  assert.equal(typeof credential, "string");
});
