import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../src/server.js";

async function fixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "topolumia-python-inspection-"),
  );
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
  const admin = app.collaboration.bootstrapAdmin({
    username: "admin",
    password: "Python-Inspection-Test!",
  });
  const token = app.collaboration.login(
    "admin",
    "Python-Inspection-Test!",
  ).token;
  const request = async (route, body, session = token) => {
    const response = await fetch(`${app.url}${route}`, {
      method:
        body === undefined
          ? "GET"
          : route.includes("/tools/") || route.endsWith("/python-environment")
            ? "PATCH"
            : "POST",
      headers: { "content-type": "application/json", "x-rw-session": session },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => {
    await app.toolEnvironment.research.close();
    await app.agentSessionGateway.closeAll();
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { app, request, admin };
}

test("Python selection validates, auto-detects components and discards data after a selection change", async (t) => {
  const { app, request, admin } = await fixture(t);
  const calls = [];
  app.toolEnvironment.commandRunner = async (command, args) => {
    calls.push({ command, args });
    const mode = args.at(-1);
    const python = {
      executable: command,
      version: "3.12.8",
      prefix: "/env/a",
      basePrefix: "/base",
      kind: "venv",
    };
    const result =
      mode === "identity" || mode === "packages"
        ? { status: "ready", python, packages: { torch: "2.8.0+cpu" }, executables: {} }
        : {
            status: mode === "torch" ? "ready" : "not_installed",
            version: mode === "torch" ? "2.8.0+cpu" : null,
            gpuAvailable: false,
            gpuTest: "unavailable",
          };
    return {
      ok: true,
      stdout: `TOPOLUMIA_PYTHON_PROBE:${JSON.stringify(result)}\n`,
      stderr: "",
    };
  };
  await request("/api/tools-environment/tools/python", {
    command: "/fixture/python-a",
  });
  const ordinary = await request("/api/tools-environment/check", {
    toolId: "python",
  });
  assert.equal(
    ordinary.data.environment.find((item) => item.id === "python").version,
    "3.12.8",
  );
  assert.ok(calls.some(call => call.args.at(-1) === "packages"));
  assert.equal(
    ordinary.data.environment.find((item) => item.id === "python")
      .pythonInspection,
    null,
  );
  const inspection = await request("/api/tools-environment/python/inspect", {});
  assert.equal(inspection.status, 200);
  const result = inspection.data.environment.find(
    (item) => item.id === "python",
  );
  assert.equal(result.status, "ready");
  assert.equal(result.pythonInspection.python.executable, "/fixture/python-a");
  assert.equal(result.pythonInspection.frameworks[0].gpuTest, "unavailable");
  assert.ok(calls.filter(call => ["identity", "packages", "torch", "jax", "tensorflow"].includes(call.args.at(-1))).every(call => call.command === "/fixture/python-a"));
  assert.equal(
    (
      await request("/api/tools-environment/python/inspect", {
        command: "custom-command",
      })
    ).status,
    422,
  );
  const updated = await request("/api/tools-environment/tools/python", {
    command: "/fixture/python-b",
  });
  assert.equal(
    updated.data.environment.find((item) => item.id === "python")
      .pythonInspection,
    null,
  );
  await request("/api/tools-environment/tools/uv", { command: "/fixture/uv" });
  assert.equal(app.userSettings.settings.tools.uv.command, "/fixture/uv");
  const reader = app.collaboration.createUser(
    {
      username: "reader",
      displayName: "Reader",
      password: "Python-Inspection-Reader!",
    },
    app.collaboration.actorForUser(admin.id, app.config.project.id),
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
    "Python-Inspection-Reader!",
  ).token;
  assert.equal(
    (await request("/api/tools-environment/python/inspect", {}, readerToken))
      .status,
    403,
  );
  assert.equal((await request("/api/tools-environment/python-environment", { kind: "default" }, readerToken)).status, 403);
  assert.equal((await request("/api/tools-environment/python-environment/check", {}, readerToken)).status, 403);
});

test("a late Python framework inspection cannot reappear under a different interpreter", async (t) => {
  const { app, request } = await fixture(t);
  app.toolEnvironment.commandRunner = async (command, args) => ({ ok: true, stdout: `TOPOLUMIA_PYTHON_PROBE:${JSON.stringify({ status: "ready", python: { executable: command, version: "3.12.0", prefix: "/new", kind: "venv" }, packages: {}, executables: {} })}\n`, stderr: "" });
  let release;
  let started;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  app.toolEnvironment.researchEnvironment.inspectPython = async () => {
    started();
    return new Promise((resolve) => {
      release = () =>
        resolve({
          python: {
            executable: "/old/python",
            version: "3.11.0",
            prefix: "/old",
            kind: "venv",
          },
          frameworks: [],
          checkedAt: new Date().toISOString(),
        });
    });
  };
  const pending = request("/api/tools-environment/python/inspect", {});
  await entered;
  await request("/api/tools-environment/tools/python", {
    command: "/new/python",
  });
  release();
  assert.equal(
    (await pending).data.environment.find((item) => item.id === "python")
      .pythonInspection,
    null,
  );
});

test("environment switching isolates pending results, TensorBoard runtime and Topolumia Node", async t => {
  const { app, request } = await fixture(t);
  const nodeVersion = process.versions.node;
  const originalParser = app.config.tensorboard.pythonCommand;
  const originalPath = process.env.PATH;
  let releaseOld;
  app.toolEnvironment.commandRunner = async (command, args) => {
    const mode = args.at(-1);
    if (!["identity", "packages"].includes(mode)) return { ok: false, stdout: "", stderr: "" };
    const packet = { status: "ready", python: { executable: command, prefix: "/test", version: command.includes("new") ? "3.13.0" : "3.11.0", kind: "venv" },
      packages: { wandb: command.includes("new") ? "0.20.0" : "0.18.0" }, executables: {} };
    if (command === "/old/python" && mode === "packages") await new Promise(resolve => { releaseOld = resolve; });
    return { ok: true, stdout: `TOPOLUMIA_PYTHON_PROBE:${JSON.stringify(packet)}\n`, stderr: "" };
  };
  assert.equal((await request("/api/tools-environment/python-environment", { kind: "custom", pythonCommand: "/old/python" })).status, 200);
  const oldRun = app.toolEnvironment.research.pending;
  assert.equal((await request("/api/tools-environment/python-environment", { kind: "custom", pythonCommand: "/new/python" })).status, 200);
  await app.toolEnvironment.research.pending;
  releaseOld();
  await oldRun;
  const inventory = (await request("/api/tools-environment")).data;
  assert.equal(inventory.researchEnvironment.selection.pythonCommand, "/new/python");
  assert.equal(inventory.tools.find(c => c.id === "wandb").version, "0.20.0");
  assert.equal(inventory.tools.find(c => c.id === "wandb").connection.status, "not_configured");
  assert.equal(inventory.environment.find(c => c.id === "node").version, nodeVersion);
  assert.equal(inventory.environment.find(c => c.id === "node").location, process.execPath);
  assert.equal(app.config.tensorboard.pythonCommand, originalParser);
  assert.equal(process.env.PATH, originalPath);
  const bad = await request("/api/tools-environment/python-environment", { kind: "custom", pythonCommand: "python", script: "extra" });
  assert.equal(bad.status, 422);
  assert.equal((await request("/api/tools-environment")).data.researchEnvironment.selection.pythonCommand, "/new/python");
});
