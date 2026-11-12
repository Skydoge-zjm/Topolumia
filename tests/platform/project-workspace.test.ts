import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startMvpServer } from "../../src/server.js";
import { readResearchEnvironmentContext } from "../../src/services/environments/research-environment-context.js";

async function fixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "topolumia-project-workspace-"),
  );
  const app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: path.join(root, "app.sqlite"),
    userSettingsFile: path.join(root, "settings.json"),
    config: {
      project: {
        root: path.join(root, "default"),
        workspacesRoot: path.join(root, "workspaces"),
      },
      sourceRefresh: { enabled: false },
      curator: { enabled: false },
    },
  });
  const user = app.collaboration.bootstrapAdmin({
    username: "workspace-owner",
    password: "Workspace-Fixture-2026!",
  });
  const token = app.collaboration.login(
    "workspace-owner",
    "Workspace-Fixture-2026!",
  ).token;
  const actor = app.collaboration.actorForUser(user.id, app.config.project.id);
  const request = async (
    route,
    {
      method = "GET",
      body = undefined,
      project = app.config.project.id,
    }: any = {},
  ) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "x-rw-session": token,
        "x-rw-project-id": project,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { app, actor, user, root, request };
}

test("project names generate unique IDs and isolated workspaces without a directory requirement", async (t) => {
  const { app, actor, root, request } = await fixture(t);
  const preview = await request("/api/project-workspaces/defaults");
  assert.equal(preview.status, 200);
  assert.equal(
    preview.data.directory,
    path.join(root, "workspaces", preview.data.id),
  );
  assert.equal(app.collaboration.projectById(preview.data.id), null);
  const first = await request("/api/projects", {
    method: "POST",
    body: { id: preview.data.id, name: "同名研究" },
  });
  const second = await request("/api/projects", {
    method: "POST",
    body: { name: "同名研究" },
  });
  assert.equal(first.status, 201);
  assert.equal(first.data.project.root, preview.data.directory);
  assert.equal(second.status, 201);
  assert.notEqual(first.data.project.id, second.data.project.id);
  assert.equal(first.data.project.workspace.kind, "managed");
  assert.equal(
    first.data.project.root,
    path.join(root, "workspaces", first.data.project.id),
  );
  const project = app.collaboration.projectById(first.data.project.id);
  assert.equal(project.workspace.directory, project.root);
  assert.deepEqual(await readdir(project.root), []);
  assert.equal(
    app.collaboration.membership(project.id, actor.user.id).role,
    "p-admin",
  );
});

test("existing local directories are validated and reused without writing into their contents", async (t) => {
  const { app, root, request } = await fixture(t);
  const directory = path.join(root, "existing-code");
  await mkdir(directory);
  await writeFile(path.join(directory, "keep.py"), "print('original')\n");
  const validated = await request("/api/project-workspaces/validate", {
    method: "POST",
    body: { kind: "local", directory },
  });
  assert.equal(validated.status, 200);
  assert.equal(validated.data.workspace.directory, await realpath(directory));
  const result = await request("/api/projects", {
    method: "POST",
    body: { name: "已有代码", workspace: { kind: "local", directory } },
  });
  assert.equal(result.status, 201);
  const runtime = await app.getRuntime(result.data.project.id);
  assert.equal(runtime.config.project.root, await realpath(directory));
  assert.deepEqual(runtime.config.filesystem.roots, [
    await realpath(directory),
  ]);
  assert.deepEqual(await readdir(directory), ["keep.py"]);
  assert.equal(
    await readFile(path.join(directory, "keep.py"), "utf8"),
    "print('original')\n",
  );
});

test("changing the default workspace root never redirects a saved project's files or content", async (t) => {
  const { app, actor, root } = await fixture(t);
  const projectId = app.config.project.id,
    directory = app.config.project.root;
  const note = app.researchNodes.createNode(
    "note",
    { nodeName: "Existing research" },
    actor,
  ).node;
  await app.close();
  const restarted = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: path.join(root, "app.sqlite"),
    userSettingsFile: path.join(root, "settings.json"),
    config: {
      project: { workspacesRoot: path.join(root, "new-workspaces") },
      sourceRefresh: { enabled: false },
      curator: { enabled: false },
    },
  });
  try {
    assert.equal(restarted.config.project.root, directory);
    assert.deepEqual(restarted.config.filesystem.roots, [directory]);
    assert.equal(
      restarted.collaboration.projectById(projectId).root,
      directory,
    );
    assert.equal(
      restarted.researchCommands.nodes.node(note.id).core.nodeName,
      "Existing research",
    );
    assert.notEqual(
      restarted.config.project.workspacesRoot,
      path.dirname(directory),
    );
  } finally {
    await restarted.close();
  }
});

test("invalid directory choices create no project and folder browsing returns bounded metadata only", async (t) => {
  const { app, actor, root, request } = await fixture(t),
    before = app.collaboration.listProjects(actor).length;
  const invalid = await request("/api/projects", {
    method: "POST",
    body: {
      name: "未创建",
      workspace: { kind: "local", directory: path.join(root, "missing") },
    },
  });
  const postponed = await request("/api/projects", {
    method: "POST",
    body: { name: "不存在的选项", workspace: { kind: "unassigned" } },
  });
  assert.equal(postponed.status, 422);
  assert.equal(invalid.status, 422);
  assert.equal(invalid.data.error.code, "PROJECT_DIRECTORY_NOT_FOUND");
  assert.equal(app.collaboration.listProjects(actor).length, before);
  const directory = path.join(root, "folders");
  await mkdir(directory);
  await Promise.all(
    Array.from({ length: 105 }, (_, index) =>
      mkdir(path.join(directory, "project-" + String(index).padStart(3, "0"))),
    ),
  );
  await writeFile(path.join(directory, "private.txt"), "must not be read");
  const page = await request(
    "/api/project-workspaces/directories?" +
      new URLSearchParams({ kind: "local", directory }),
  );
  assert.equal(page.status, 200);
  assert.equal(page.data.entries.length, 100);
  assert.equal(page.data.nextOffset, 100);
  assert.equal(
    page.data.entries.some((entry) => entry.name === "private.txt"),
    false,
  );
  assert.equal(JSON.stringify(page.data).includes("must not be read"), false);
  assert.throws(
    () =>
      app.projectWorkspaces.requireAdministrator({
        ...actor,
        isServerAdmin: false,
      }),
    { code: "FORBIDDEN" },
  );
});

test("a default workspace can be changed while research content survives and stale updates are rejected", async (t) => {
  const { app, user, root, request } = await fixture(t);
  const created = await request("/api/projects", {
    method: "POST",
    body: { name: "先写研究笔记", workspace: { kind: "managed" } },
  });
  const project = created.data.project,
    actor = app.collaboration.actorForUser(user.id, project.id),
    initial = await app.getRuntime(project.id);
  const note = initial.researchNodes.createNode(
    "note",
    { nodeName: "保留的想法" },
    actor,
  ).node;
  const context = await readResearchEnvironmentContext({
    runtime: initial,
    actor,
    sshEnvironments: app.sshEnvironments,
  });
  assert.equal(context.workingDirectory, project.root);
  await initial.userSettings.update({
    researchEnvironment: {
      kind: "custom",
      pythonCommand: "old-project-python",
      prefix: "",
    },
    sources: { filesystem: { roots: ["old-files"] } },
  });
  const saved = JSON.parse(
    await readFile(initial.userSettings.filePath, "utf8"),
  );
  delete saved.settings.workspaceRevision;
  await writeFile(initial.userSettings.filePath, JSON.stringify(saved));
  const directory = path.join(root, "later-code");
  await mkdir(directory);
  const changed = await request("/api/project-workspaces", {
    method: "PATCH",
    project: project.id,
    body: {
      workspace: { kind: "local", directory },
      expectedRevision: project.workspace.revision,
    },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const current = await app.getRuntime(project.id);
  assert.notEqual(current, initial);
  assert.equal(current.config.project.root, await realpath(directory));
  assert.notEqual(
    current.config.researchEnvironment.pythonCommand,
    "old-project-python",
  );
  assert.deepEqual(current.config.filesystem.roots, [
    await realpath(directory),
  ]);
  assert.equal(
    current.researchCommands.nodes.node(note.id).core.nodeName,
    "保留的想法",
  );
  const unchanged = await request("/api/project-workspaces", {
    method: "PATCH",
    project: project.id,
    body: {
      workspace: { kind: "local", directory },
      expectedRevision: changed.data.project.workspace.revision,
    },
  });
  assert.equal(unchanged.status, 200);
  assert.equal(await app.getRuntime(project.id), current);
  const stale = await request("/api/project-workspaces", {
    method: "PATCH",
    project: project.id,
    body: {
      workspace: { kind: "managed" },
      expectedRevision: project.workspace.revision,
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(
    (await app.getRuntime(project.id)).researchCommands.nodes.node(note.id).core
      .nodeName,
    "保留的想法",
  );
});

test("SSH creation uses read-only SFTP and preserves an explicit pending Python selection", async (t) => {
  const { app, user, request } = await fixture(t);
  const profile = await app.sshConnections.save(user.id, {
    name: "Research host",
    mode: "alias",
    alias: "research",
  });
  class DirectorySftp extends EventEmitter {
    realpath(value, callback) {
      callback(null, value === "." ? "/home/scientist" : value);
    }
    stat(_value, callback) {
      callback(null, { isDirectory: () => true });
    }
    opendir(_value, callback) {
      callback(null, Buffer.from("directory-handle"));
    }
    readdir(_handle, callback) {
      callback(Object.assign(new Error("End of directory"), { code: 1 }));
    }
    close(_value, callback) {
      callback(null);
    }
    end() {}
  }
  const session = {
    owner: user.id,
    profile: await app.sshConnections.profile(user.id, profile.id),
    status: "connected",
    info: {
      platform: "Linux",
      home: "/home/scientist",
      user: "scientist",
      python: null,
    },
    channels: new Set(),
    clients: [],
    proxies: [],
    client: {
      sftp: (callback) => callback(null, new DirectorySftp()),
      end() {},
    },
  };
  app.sshConnections.sessions.set(
    app.sshConnections.sessionKey(user.id, profile.id),
    session,
  );
  app.sshConnections.run = async () => {
    throw new Error(
      "Directory selection must not execute Python or shell commands",
    );
  };
  const empty = await request(
    "/api/project-workspaces/directories?" +
      new URLSearchParams({
        kind: "ssh",
        connectionId: profile.id,
        directory: "/srv/research",
      }),
  );
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.entries, []);
  const result = await request("/api/projects", {
    method: "POST",
    body: {
      name: "远程研究",
      workspace: {
        kind: "ssh",
        connectionId: profile.id,
        directory: "/srv/research",
      },
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const runtime = await app.getRuntime(result.data.project.id),
    actor = app.collaboration.actorForUser(user.id, result.data.project.id);
  assert.equal(
    (await app.sshEnvironments.projectSettings(runtime, user.id, profile.id))
      .directory,
    "/srv/research",
  );
  const binding = await app.sshEnvironments.currentBinding(runtime, user.id);
  assert.equal(binding.connectionId, profile.id);
  assert.equal(binding.name, "unselected");
  const context = await readResearchEnvironmentContext({
    runtime,
    actor,
    sshEnvironments: app.sshEnvironments,
  });
  assert.equal(context.workingDirectory, "/srv/research");
  assert.equal(context.execution.location, "remote-host");
  assert.equal(context.environment.selected, false);
  assert.equal(context.execution.pythonPrefix, null);
  assert.equal(session.channels.size, 0);
});
