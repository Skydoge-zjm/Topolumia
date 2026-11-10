import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../src/server.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-tools-"));
  const databaseFile = path.join(root, "db.sqlite");
  const app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: databaseFile,
    userSettingsFile: path.join(root, "settings.json"),
    config: {
      collaboration: { databaseFile },
      sourceRefresh: { enabled: false },
    },
  });
  app.collaboration.bootstrapAdmin({
    username: "admin",
    password: "Tools-Integration-2026!",
  });
  const token = app.collaboration.login(
    "admin",
    "Tools-Integration-2026!",
  ).token;
  const request = async (
    route,
    {
      method = "GET",
      body,
      project = app.config.project.id,
      session = token,
    } = {},
  ) => {
    const response = await fetch(`${app.url}${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-rw-session": session,
        "x-rw-project-id": project,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => {
    await app.toolEnvironment.catalog.close();
    await app.toolEnvironment.research.close();
    await app.agentSessionGateway.closeAll();
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { app, request };
}

test("tools: real connection checks, configuration invalidation, credential references and project isolation", async (t) => {
  const { request } = await fixture(t);
  let hits = 0;
  let authorization = "";
  const provider = http.createServer((req, res) => {
    hits++;
    authorization = String(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ experiment: { experiment_id: "1", name: "Test study" } }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(async () => {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    delete process.env.TOPOLUMIA_TOOLS_TEST_TOKEN;
  });
  const baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  process.env.TOPOLUMIA_TOOLS_TEST_TOKEN =
    "fixture-private-token-do-not-return";
  const initial = await request("/api/tools-environment");
  assert.equal(initial.status, 200);
  assert.equal(
    initial.data.tools.find((tool) => tool.id === "mlflow").status,
    "not_configured",
  );
  assert.equal(hits, 0);
  const config = {
    baseUrl,
    experimentName: "Test study",
    experimentId: "",
    tokenEnv: "TOPOLUMIA_TOOLS_TEST_TOKEN",
  };
  const configured = await request("/api/tools-environment/tools/mlflow", {
    method: "PATCH",
    body: config,
  });
  assert.equal(configured.status, 200);
  assert.equal(
    configured.data.tools.find((tool) => tool.id === "mlflow").status,
    "unchecked",
  );
  assert.equal(hits, 0, "Saving config must not silently contact a service");
  const checked = await request("/api/tools-environment/check", {
    method: "POST",
    body: { toolId: "mlflow" },
  });
  const tool = checked.data.tools.find((tool) => tool.id === "mlflow");
  assert.equal(tool.status, "ready");
  assert.ok(tool.checkedAt);
  assert.equal(hits, 1);
  assert.equal(
    authorization,
    `Bearer ${process.env.TOPOLUMIA_TOOLS_TEST_TOKEN}`,
  );
  assert.ok(
    !JSON.stringify(checked.data).includes(
      process.env.TOPOLUMIA_TOOLS_TEST_TOKEN,
    ),
  );
  assert.equal(tool.credential.available, true);
  assert.equal(
    (await request("/api/tools-environment")).data.tools.find(
      (tool) => tool.id === "mlflow",
    ).checkedAt,
    tool.checkedAt,
  );
  assert.equal(
    (
      await request("/api/projects", {
        method: "POST",
        body: { id: "tools-project-b", name: "Project B" },
      })
    ).status,
    201,
  );
  const other = await request("/api/tools-environment", {
    project: "tools-project-b",
  });
  assert.equal(
    other.data.tools.find((tool) => tool.id === "mlflow").configuration.baseUrl,
    "",
  );
  assert.equal(
    other.data.tools.find((tool) => tool.id === "mlflow").status,
    "not_configured",
  );
  const disconnected = await request("/api/tools-environment/tools/mlflow", {
    method: "PATCH",
    body: { ...config, baseUrl: "" },
  });
  assert.equal(
    disconnected.data.tools.find((tool) => tool.id === "mlflow").status,
    "not_configured",
  );
  const disabled = await request("/api/tools-environment/check", {
    method: "POST",
    body: { toolId: "mlflow" },
  });
  assert.equal(
    disabled.data.tools.find((tool) => tool.id === "mlflow").status,
    "not_configured",
  );
  assert.equal(hits, 1);
});

test("environment catalog APIs keep browse, package refresh and activation permissions project-scoped", async t => {
  const { app, request } = await fixture(t);
  const prefix = path.join(app.config.project.root, "catalog env");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const executable = path.join(prefix, process.platform === "win32" ? "python.exe" : "bin/python");
  await mkdir(path.dirname(executable), { recursive: true }); await writeFile(executable, "fixture");
  app.config.toolCommands.conda = process.execPath;
  let inventories = 0;
  app.toolEnvironment.commandRunner = async (_command, args) => {
    if (args[0] === "info") return { ok: true, stdout: JSON.stringify({ conda_version: "26.1.0", root_prefix: prefix, envs: [prefix] }), stderr: "" };
    if (args[0] === "list") { inventories++; return { ok: true, stdout: JSON.stringify([{ name: "openssl", version: "3.4.0", channel: "private-channel" }]), stderr: "" }; }
    return { ok: false, stdout: "", stderr: "" };
  };
  const discovered = await request("/api/tools-environment/catalog/sources/conda");
  const environment = discovered.data.sources.find(source => source.id === "conda").environments[0];
  const endpoint = `/api/tools-environment/catalog/environments/${environment.id}`;
  const actor = app.collaboration.actorForUser(app.collaboration.userByUsername("admin").id, app.config.project.id);
  const reader = app.collaboration.createUser({ username: "inventory-reader", displayName: "Reader", password: "Inventory-Reader-Test!" }, actor);
  app.collaboration.db.prepare("INSERT INTO memberships (project_id,user_id,role,status,created_at,updated_at) VALUES (?,?,'guest','active',?,?)").run(app.config.project.id, reader.id, new Date().toISOString(), new Date().toISOString());
  const readerSession = app.collaboration.login("inventory-reader", "Inventory-Reader-Test!").token;
  assert.equal((await request(`${endpoint}/packages`, { session: readerSession })).data.status, "unchecked");
  assert.equal(inventories, 0);
  for (const action of ["activate", "check", "packages/refresh"]) assert.equal((await request(`${endpoint}/${action}`, { method: "POST", body: {}, session: readerSession })).status, 403);
  assert.equal((await request(`${endpoint}/packages/refresh`, { method: "POST", body: { command: "extra" } })).status, 422);
  assert.equal((await request(`${endpoint}/packages/refresh`, { method: "POST", body: {} })).status, 202);
  let result;
  for (let i = 0; i < 30; i++) { result = await request(`${endpoint}/packages`, { session: readerSession }); if (result.data.status === "completed") break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.deepEqual(result.data.items, [{ name: "openssl", version: "3.4.0", source: "conda" }]);
  assert.equal(inventories, 1);
  assert.equal((await request(`${endpoint}/packages?limit=1000`)).status, 422);
  await request("/api/projects", { method: "POST", body: { id: "inventory-other", name: "Other" } });
  assert.equal((await request(`${endpoint}/packages`, { project: "inventory-other" })).status, 404);
});

test("tools: input validation, deleted endpoint and permission boundaries", async (t) => {
  const { app, request } = await fixture(t);
  assert.equal((await request("/api/adapters")).status, 404);
  assert.equal(
    (
      await request("/api/tools-environment/check", {
        method: "POST",
        body: { toolId: "arbitrary-shell" },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request("/api/tools-environment/tools/git", {
        method: "PATCH",
        body: { command: "arbitrary-shell" },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request("/api/tools-environment/tools/tensorboard", {
        method: "PATCH",
        body: { logdir: "../../outside" },
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await request("/api/tools-environment/tools/python", {
        method: "PATCH",
        body: { command: "python", unknown: true },
      })
    ).status,
    422,
  );
  const previous = app.config.researchEnvironment;
  const invalidPython = await request("/api/tools-environment/tools/python", {
    method: "PATCH", body: { command: process.execPath },
  });
  assert.equal(invalidPython.status, 422);
  assert.deepEqual(app.config.researchEnvironment, previous);
  const reader = app.collaboration.createUser(
    {
      username: "reader",
      displayName: "Reader",
      password: "Reader-Tools-Test!",
    },
    app.collaboration.actorForUser(
      app.collaboration.userByUsername("admin").id,
      app.config.project.id,
    ),
  );
  app.collaboration.db
    .prepare(
      "INSERT INTO memberships (project_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'guest', 'active', ?, ?)",
    )
    .run(
      app.config.project.id,
      reader.id,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  const readerToken = app.collaboration.login(
    "reader",
    "Reader-Tools-Test!",
  ).token;
  assert.equal(
    (await request("/api/tools-environment", { session: readerToken })).status,
    200,
  );
  assert.equal(
    (
      await request("/api/tools-environment/check", {
        method: "POST",
        session: readerToken,
        body: { toolId: "node" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/tools-environment/tools/python", {
        method: "PATCH",
        session: readerToken,
        body: { command: "python" },
      })
    ).status,
    403,
  );
  const credential = app.collaboration.issueAgentCredential(
    app.collaboration.actorForUser(
      app.collaboration.userByUsername("admin").id,
      app.config.project.id,
    ),
    app.config.project.id,
    "tools-test-agent",
  );
  assert.equal(
    (await request("/api/tools-environment", { session: credential })).status,
    403,
  );
});

test("tools: a delayed connection check cannot restore a result after its configuration changes", async (t) => {
  const { request } = await fixture(t);
  let release;
  let received;
  const hit = new Promise<void>((resolve) => {
    received = resolve;
  });
  const provider = http.createServer((_req, res) => {
    release = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"experiments":[]}');
    };
    received();
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(async () => {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });
  const config = {
    baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}`,
    experimentName: "Study",
    experimentId: "",
    tokenEnv: "MLFLOW_TRACKING_TOKEN",
  };
  await request("/api/tools-environment/tools/mlflow", {
    method: "PATCH",
    body: config,
  });
  const pending = request("/api/tools-environment/check", {
    method: "POST",
    body: { toolId: "mlflow" },
  });
  await hit;
  await request("/api/tools-environment/tools/mlflow", {
    method: "PATCH",
    body: { ...config, baseUrl: "" },
  });
  release();
  const result = await pending;
  assert.equal(
    result.data.tools.find((tool) => tool.id === "mlflow").status,
    "not_configured",
  );
});

test("tools: MLflow catalog follows the current configured connection and experiment", async t => {
  const { request } = await fixture(t);
  const provider = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    let body;
    if (url.pathname.endsWith("/graphql")) body = { data: { project: null } };
    else if (url.pathname.includes("get-by-name")) body = { experiment: url.searchParams.get("experiment_name") === "Missing" ? null : { experiment_id: "1", name: "Study" } };
    else if (url.pathname.includes("experiments/search")) body = { experiments: [{ experiment_id: "1", name: "Study" }] };
    else body = { runs: [{ info: { run_id: url.pathname.startsWith("/a/") ? "connection-a" : "connection-b", experiment_id: "1", status: "FINISHED", start_time: 1000, end_time: 2000 }, data: { params: [], metrics: [], tags: [] } }] };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body));
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  t.after(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const config = { baseUrl: `${baseUrl}/a`, experimentName: "Study", experimentId: "", tokenEnv: "MLFLOW_TRACKING_TOKEN" };
  await request("/api/tools-environment/tools/mlflow", { method: "PATCH", body: config });
  assert.equal((await request("/api/research/experiments/mlflow/catalog")).data.runs[0].runId, "connection-a");
  await request("/api/tools-environment/tools/mlflow", { method: "PATCH", body: { ...config, baseUrl: `${baseUrl}/b` } });
  assert.equal((await request("/api/research/experiments/mlflow/catalog")).data.runs[0].runId, "connection-b");
  await request("/api/tools-environment/tools/mlflow", { method: "PATCH", body: { ...config, experimentName: "Missing" } });
  const missingExperiment = await request("/api/research/experiments/mlflow/catalog");
  assert.equal(missingExperiment.status, 200);
  assert.deepEqual(missingExperiment.data.runs, []);
  await request("/api/tools-environment/tools/wandb", { method: "PATCH", body: { baseUrl, entity: "team", project: "missing", tokenEnv: "WANDB_API_KEY" } });
  const missingProject = await request("/api/tools-environment/check", { method: "POST", body: { toolId: "wandb" } });
  assert.equal(missingProject.data.tools.find(item => item.id === "wandb").status, "unavailable");
});
