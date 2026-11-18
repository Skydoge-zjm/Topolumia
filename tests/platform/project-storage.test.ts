import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rename,
  cp,
  rm,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../src/server.js";
import { CollaborationStore } from "../../src/services/platform/collaboration-store.js";
import { projectDataPaths } from "../../src/services/platform/project-data-store.js";

async function fixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "topolumia-portable-project-"),
  );
  const apps = [];
  t.after(async () => {
    for (const app of apps.reverse()) await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const open = async (suffix = "first") => {
    const options = {
      port: 0,
      testMode: false,
      collaborationFile: path.join(root, suffix, "accounts.sqlite"),
      userSettingsFile: path.join(root, suffix, "settings.json"),
      config: {
        project: { workspacesRoot: path.join(root, suffix, "workspaces") },
        sourceRefresh: { enabled: false },
        curator: { enabled: false },
      },
    };
    const app = await startMvpServer(options);
    apps.push(app);
    if (!app.collaboration.hasUsers())
      app.collaboration.bootstrapAdmin({
        username: "owner",
        password: "Portable-Project-Fixture!",
      });
    const token = app.collaboration.login(
      "owner",
      "Portable-Project-Fixture!",
    ).token;
    const user = app.collaboration.userByUsername("owner");
    const request = async (
      route,
      { method = "GET", body, project }: any = {},
    ) => {
      const response = await fetch(app.url + route, {
        method,
        headers: {
          "x-rw-session": token,
          "content-type": "application/json",
          ...(project ? { "x-rw-project-id": project } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };
    return { app, request, user };
  };
  return { root, open };
}

test("a local project stores science, assets, configuration and sessions together and keeps accounts outside", async (t) => {
  const { root, open } = await fixture(t),
    { app, request, user } = await open();
  const directory = path.join(root, "research");
  await mkdir(directory);
  await writeFile(path.join(directory, "train.py"), "original code\n");
  assert.equal(
    (
      await request("/api/project-workspaces/validate", {
        method: "POST",
        body: { kind: "local", directory },
      })
    ).status,
    200,
  );
  assert.deepEqual(
    await readdir(directory),
    ["train.py"],
    "validation is read-only",
  );
  const created = await request("/api/projects", {
    method: "POST",
    body: { name: "Portable science", workspace: { kind: "local", directory } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const project = created.data.project,
    runtime = await app.getRuntime(project.id),
    actor = app.collaboration.actorForUser(user.id, project.id);
  const paths = projectDataPaths(directory);
  assert.equal(runtime.projectData.filePath, paths.database);
  assert.equal(runtime.researchCommands.store.db, runtime.projectData.db);
  assert.equal(runtime.history.db, runtime.projectData.db);
  assert.equal(runtime.notebook.db, runtime.projectData.db);
  assert.equal(runtime.researchAccess.db, runtime.projectData.db);
  assert.equal(runtime.userSettings.filePath, paths.settings);
  assert.equal(runtime.config.agentSessions.historyFile, paths.history);
  assert.equal(runtime.researchCommands.assets.root, paths.assets);
  assert.equal(
    runtime.nativeConfigs.root,
    path.join(paths.directory, "agent-config"),
  );
  const node = runtime.researchNodes.createNode(
    "note",
    { nodeName: "Preserved note" },
    actor,
  ).node;
  runtime.records.save(
    { type: "progress", title: "Preserved progress" },
    actor,
  );
  await runtime.userSettings.update({ interface: { locale: "en" } });
  const bytes = Buffer.from("portable material\n");
  const asset = await runtime.researchCommands.assets.upload(
    (async function* () {
      yield bytes;
    })(),
    {
      originalName: "material.txt",
      mediaType: "text/plain",
      idempotencyKey: "portable-material",
    },
    actor,
  );
  runtime.agentProfileRegistry.createAdapter = async () => ({
    profile: { provider: "codex" },
    start: async () => ({ capabilities: {} }),
    close: async () => {},
  });
  const session = await runtime.agentSessionGateway.create({
    profileId: "fixture",
    ownerUserId: user.id,
  });
  assert.equal(
    runtime.projectData.db
      .prepare("SELECT name FROM sqlite_master WHERE name='users'")
      .get(),
    undefined,
  );
  assert.equal(
    runtime.projectData.db
      .prepare("SELECT name FROM sqlite_master WHERE name='auth_sessions'")
      .get(),
    undefined,
  );
  assert.equal(
    app.collaboration.db
      .prepare("SELECT name FROM sqlite_master WHERE name='research_nodes'")
      .get(),
    undefined,
  );
  const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
  assert.equal(manifest.id, project.id);
  await app.close();
  const moved = path.join(root, "moved-research");
  await cp(directory, moved, { recursive: true });
  const second = await open("different-account-store");
  assert.notEqual(second.user.id, user.id);
  const opened = await second.request("/api/projects", {
    method: "POST",
    body: {
      id: "unused-preview-id",
      name: "Must not overwrite existing name",
      workspace: { kind: "local", directory: moved },
    },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.data));
  assert.equal(opened.data.project.id, project.id);
  assert.equal(opened.data.project.name, "Portable science");
  const restored = await second.app.getRuntime(project.id),
    secondActor = second.app.collaboration.actorForUser(
      second.user.id,
      project.id,
    );
  assert.equal(
    restored.researchCommands.nodes.node(node.id).core.nodeName,
    "Preserved note",
  );
  assert.equal(restored.records.list().items[0].title, "Preserved progress");
  assert.equal(restored.userSettings.settings.interface.locale, "en");
  assert.equal(
    restored.agentSessionGateway.list().some((item) => item.id === session.id),
    true,
  );
  const restoredAsset = restored.researchCommands.assets.assert(
    asset.id,
    secondActor,
  );
  assert.deepEqual(
    await readFile(restored.researchCommands.assets.file(restoredAsset)),
    bytes,
  );
  assert.equal(
    await readFile(path.join(moved, "train.py"), "utf8"),
    "original code\n",
  );
  assert.ok(restored.history.list().total >= 2);
  const again = await second.request("/api/projects", {
    method: "POST",
    body: { name: "Ignored", workspace: { kind: "local", directory: moved } },
  });
  assert.equal(again.data.project.id, project.id);
});

test("moving a registered project keeps its identity and does not recreate an empty store at the old path", async (t) => {
  const { root, open } = await fixture(t),
    first = await open();
  const runtime = await first.app.getRuntime(first.app.config.project.id);
  const actor = first.app.collaboration.actorForUser(
    first.user.id,
    runtime.project.id,
  );
  const node = runtime.researchNodes.createNode(
    "note",
    { nodeName: "Moved default project" },
    actor,
  ).node;
  const original = runtime.project.root,
    moved = path.join(root, "moved-default");
  await first.app.close();
  await rename(original, moved);
  const reopened = await open();
  assert.equal(
    reopened.app.runtimes.size,
    0,
    "account and project management work while the old location is absent",
  );
  assert.equal(
    (await reopened.request("/api/state")).data.error.code,
    "PROJECT_DATA_UNAVAILABLE",
  );
  const result = await reopened.request("/api/projects", {
    method: "POST",
    body: {
      name: "Open existing",
      workspace: { kind: "local", directory: moved },
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.project.id, runtime.project.id);
  const restored = await reopened.app.getRuntime(runtime.project.id);
  assert.equal(
    restored.researchCommands.nodes.node(node.id).core.nodeName,
    "Moved default project",
  );
  await assert.rejects(readFile(projectDataPaths(original).manifest), {
    code: "ENOENT",
  });
});

test("project data refuses malformed directories and foreign projects without overwriting them", async (t) => {
  const { root, open } = await fixture(t),
    { app, request } = await open();
  const damaged = path.join(root, "damaged");
  await mkdir(path.join(damaged, ".topolumia"), { recursive: true });
  await writeFile(path.join(damaged, ".topolumia", "private.txt"), "keep me");
  const result = await request("/api/projects", {
    method: "POST",
    body: {
      name: "Do not reset",
      workspace: { kind: "local", directory: damaged },
    },
  });
  assert.equal(result.data.error.code, "PROJECT_DATA_INVALID");
  assert.deepEqual(await readdir(path.join(damaged, ".topolumia")), [
    "private.txt",
  ]);
  const first = await request("/api/projects", {
      method: "POST",
      body: { name: "First" },
    }),
    second = await request("/api/projects", {
      method: "POST",
      body: { name: "Second" },
    });
  const source = first.data.project,
    target = second.data.project;
  const changed = await request("/api/project-workspaces", {
    method: "PATCH",
    project: source.id,
    body: {
      expectedRevision: source.workspace.revision,
      workspace: { kind: "local", directory: target.root },
    },
  });
  assert.equal(changed.data.error.code, "PROJECT_DATA_MISMATCH");
  assert.equal(app.collaboration.projectById(source.id).root, source.root);
  assert.equal(
    JSON.parse(await readFile(projectDataPaths(target.root).manifest, "utf8"))
      .id,
    target.id,
  );
});

test("existing shared scientific rows and application files are preserved once before using project storage", async (t) => {
  const { root, open } = await fixture(t);
  const accounts = path.join(root, "first", "accounts.sqlite"),
    directory = path.join(root, "first", "workspaces", "research-project");
  const legacy = await new CollaborationStore({
    filePath: accounts,
    allowDevIdentity: false,
    defaultProject: {
      id: "research-project",
      name: "Research Project",
      root: directory,
    },
  }).initialize();
  legacy.db.exec(
    "CREATE TABLE research_fixture(project_id TEXT,id TEXT,body TEXT); INSERT INTO research_fixture VALUES('research-project','preserved','original bytes'),('other-project','unrelated','private other project');",
  );
  legacy.close();
  const previous = path.join(root, "first", "projects", "research-project");
  await mkdir(path.join(previous, "research-assets"), { recursive: true });
  await writeFile(
    path.join(previous, "research-assets", "original.bin"),
    Buffer.from([0, 255, 1, 2]),
  );
  await writeFile(
    path.join(previous, "settings.json"),
    JSON.stringify({ settings: { interface: { locale: "en" } } }),
  );
  const { app } = await open();
  assert.equal(
    app.projectData.db
      .prepare("SELECT body FROM research_fixture WHERE id='preserved'")
      .get().body,
    "original bytes",
  );
  assert.equal(
    app.projectData.db
      .prepare("SELECT count(*) AS n FROM research_fixture")
      .get().n,
    1,
  );
  assert.equal(
    app.collaboration.db
      .prepare("SELECT count(*) AS n FROM research_fixture")
      .get().n,
    2,
    "original shared data remains intact",
  );
  assert.deepEqual(
    await readFile(
      path.join(projectDataPaths(directory).assets, "original.bin"),
    ),
    Buffer.from([0, 255, 1, 2]),
  );
  assert.equal(app.userSettings.settings.interface.locale, "en");
  app.projectData.db
    .prepare(
      "UPDATE research_fixture SET body='new authority' WHERE id='preserved'",
    )
    .run();
  await app.close();
  const restarted = await open();
  assert.equal(
    restarted.app.projectData.db
      .prepare("SELECT body FROM research_fixture WHERE id='preserved'")
      .get().body,
    "new authority",
  );
});

test("a directory change waits for active HTTP work and closes the old store before copying", async (t) => {
  const { root, open } = await fixture(t),
    { app, request, user } = await open();
  const id = app.config.project.id,
    runtime = await app.getRuntime(id),
    actor = app.collaboration.actorForUser(user.id, id);
  const note = runtime.researchNodes.createNode(
    "note",
    { nodeName: "Keep during requests" },
    actor,
  ).node;
  let release, entered;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const original = runtime.registry.syncSources.bind(runtime.registry);
  runtime.registry.syncSources = async () => {
    entered();
    await gate;
    return original();
  };
  const refreshing = request("/api/source-refresh", {
    method: "POST",
    body: {},
  });
  await started;
  const directory = path.join(root, "new-location");
  await mkdir(directory);
  const body = {
    expectedRevision: runtime.project.workspace.revision,
    workspace: { kind: "local", directory },
  };
  try {
    const blocked = await request("/api/project-workspaces", {
      method: "PATCH",
      project: id,
      body,
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.error.code, "PROJECT_WORKSPACE_BUSY");
    assert.equal(runtime.projectData.closed, false);
  } finally {
    release();
  }
  assert.equal((await refreshing).status, 200);
  const changed = await request("/api/project-workspaces", {
    method: "PATCH",
    project: id,
    body,
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal(runtime.projectData.closed, true);
  assert.equal(runtime.retired, true);
  assert.equal(
    (await app.getRuntime(id)).researchCommands.nodes.node(note.id).core
      .nodeName,
    "Keep during requests",
  );
});
