import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMvpServer } from "../../../src/server.js";

async function fixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "topolumia-agent-settings-"),
  );
  const databaseFile = path.join(root, "db.sqlite");
  const native = fileURLToPath(
    new URL("../../../fixtures/native/codex-app-server.js", import.meta.url),
  );
  const profiles = [
    {
      id: "codex-test",
      provider: "codex",
      label: "Codex",
      driver: "codex-app-server",
      args: [native],
    },
    { id: "claude-test", provider: "claude", label: "Claude Code" },
    {
      id: "opencode-test",
      provider: "opencode",
      label: "OpenCode",
      driver: "opencode-server",
    },
  ].map((profile) => ({
    ...profile,
    command: process.execPath,
    versionArgs: ["--version"],
    model: "gpt-6-luna",
    models: [{ id: "gpt-6-luna", label: "6 Luna" }],
  }));
  const app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: databaseFile,
    userSettingsFile: path.join(root, "settings.json"),
    config: {
      collaboration: { databaseFile },
      sourceRefresh: { enabled: false },
      agentSessions: { profiles },
    },
  });
  const admin = app.collaboration.bootstrapAdmin({
    username: "admin",
    password: "Agent-Settings-Audit-2026!",
  });
  const token = app.collaboration.login(
    "admin",
    "Agent-Settings-Audit-2026!",
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
    await app.agentSessionGateway.closeAll();
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { app, request, admin };
}

test("Agent configuration owns runtime and CLI checks independently of tool checks", async (t) => {
  const { app, request } = await fixture(t);
  let discoveries = 0;
  app.agentConfiguration.discoverModels = async () => {
    discoveries++;
    return {
      models: [{ id: "test/gpt-6-luna", label: "Luna", reasoningEfforts: [] }],
      model: "test/gpt-6-luna",
    };
  };
  const initial = await request("/api/agent-configuration");
  assert.equal(initial.status, 200);
  assert.equal(initial.data.agents.length, 3);
  assert.ok(
    initial.data.agents.every(
      (agent) =>
        agent.model === "gpt-6-luna" &&
        agent.status === "unchecked" &&
        agent.installed === null,
    ),
  );
  assert.equal(initial.data.integration.status, "unchecked");
  assert.equal(discoveries, 0);
  await request("/api/tools-environment/check", {
    method: "POST",
    body: { toolId: "node" },
  });
  assert.equal(discoveries, 0);
  assert.equal(
    (
      await request("/api/tools-environment/check", {
        method: "POST",
        body: { toolId: "research-cli" },
      })
    ).status,
    404,
  );
  const checked = await request("/api/agent-configuration/check", {
    method: "POST",
    body: {},
  });
  assert.ok(
    checked.data.agents.every(
      (agent) => agent.status === "ready" && agent.installed && agent.checkedAt,
    ),
  );
  assert.equal(checked.data.agents[2].resolvedModel, "test/gpt-6-luna");
  assert.equal(checked.data.integration.status, "ready");
  assert.equal(discoveries, 1);
  const selectedDefault = await request("/api/agent-configuration/profiles/claude-test", { method: "PATCH", body: { makeDefault: true } });
  assert.ok(selectedDefault.data.agents.every(agent => agent.status === "ready"));
  await request("/api/agent-configuration/profiles/codex-test", { method: "PATCH", body: { model: "fixture-other-model" } });
  const afterModel = (await request("/api/agent-configuration")).data;
  assert.equal(afterModel.agents[0].status, "unchecked");
  assert.ok(afterModel.agents.slice(1).every(agent => agent.status === "ready"));
  const toolInventory = await request("/api/tools-environment");
  assert.deepEqual(
    toolInventory.data.environment.map((item) => item.id),
    ["workspace", "node", "python", "conda", "uv", "nvidia", "cuda"],
  );
  assert.equal(
    toolInventory.data.environment.find((item) => item.id === "python").status,
    "unchecked",
  );
});

test("Agent defaults persist per project, appear in session settings, and leave existing tool diagnostics intact", async (t) => {
  const { app, request } = await fixture(t);
  await request("/api/tools-environment/check", {
    method: "POST",
    body: { toolId: "node" },
  });
  const configured = await request(
    "/api/agent-configuration/profiles/codex-test",
    { method: "PATCH", body: { model: "fixture-project-model" } },
  );
  assert.equal(configured.status, 200);
  assert.equal(configured.data.agents[0].model, "fixture-project-model");
  assert.equal(
    (await request("/api/tools-environment")).data.environment.find(
      (item) => item.id === "node",
    ).status,
    "ready",
  );
  const native = await request("/api/agent-sessions", {
    method: "POST",
    body: { profileId: "codex-test" },
  });
  assert.equal(native.status, 201);
  assert.equal(native.data.model, "fixture-project-model");
  const defaults = await request(
    "/api/agent-configuration/profiles/claude-test",
    { method: "PATCH", body: { makeDefault: true } },
  );
  assert.equal(
    defaults.data.agents.find((agent) => agent.isDefault).id,
    "claude-test",
  );
  const settings = (await request("/api/settings")).data.settings;
  assert.equal(settings.agent.defaultProfileId, "claude-test");
  assert.equal(
    settings.agent.profileModels["codex-test"],
    "fixture-project-model",
  );
  await request("/api/projects", {
    method: "POST",
    body: { id: "agent-project-b", name: "Project B" },
  });
  const other = await request("/api/agent-configuration", {
    project: "agent-project-b",
  });
  assert.equal(other.data.agents[0].model, "gpt-6-luna");
  assert.equal(
    other.data.agents.find((agent) => agent.isDefault).id,
    "codex-test",
  );
  const { UserSettingsStore } =
    await import("../../../src/services/platform/user-settings-store.js");
  const restored = new UserSettingsStore({
    filePath: app.userSettings.filePath,
    config: app.config,
  });
  await restored.initialize();
  assert.equal(
    restored.settings.agent.profileModels["codex-test"],
    "fixture-project-model",
  );
});

test("Agent configuration enforces permissions and rejects invalid defaults and unavailable OpenCode models", async (t) => {
  const { app, request, admin } = await fixture(t);
  assert.equal(
    (
      await request("/api/agent-configuration/profiles/missing", {
        method: "PATCH",
        body: { model: "gpt-6-luna" },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request("/api/agent-configuration/profiles/codex-test", {
        method: "PATCH",
        body: { command: "arbitrary-shell" },
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await request("/api/agent-configuration/profiles/codex-test", {
        method: "PATCH",
        body: { model: "bad model" },
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await request("/api/agent-configuration/check", {
        method: "POST",
        body: { integration: true, profileId: "codex-test" },
      })
    ).status,
    422,
  );
  app.agentConfiguration.discoverModels = async () => ({
    models: [{ id: "test/gpt-6-luna", label: "Luna", reasoningEfforts: [] }],
    model: "test/gpt-6-luna",
  });
  const badModel = await request(
    "/api/agent-configuration/profiles/opencode-test",
    { method: "PATCH", body: { model: "missing" } },
  );
  assert.equal(badModel.status, 422);
  const goodModel = await request(
    "/api/agent-configuration/profiles/opencode-test",
    { method: "PATCH", body: { model: "gpt-6-luna" } },
  );
  assert.equal(goodModel.data.agents[2].model, "test/gpt-6-luna");
  const reader = app.collaboration.createUser(
    {
      username: "reader",
      displayName: "Reader",
      password: "Agent-Config-Reader!",
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
  const session = app.collaboration.login(
    "reader",
    "Agent-Config-Reader!",
  ).token;
  assert.equal(
    (await request("/api/agent-configuration", { session })).status,
    200,
  );
  assert.equal(
    (
      await request("/api/agent-configuration/check", {
        method: "POST",
        session,
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/agent-configuration/profiles/codex-test", {
        method: "PATCH",
        session,
        body: { model: "gpt-6-luna" },
      })
    ).status,
    403,
  );
  const credential = app.collaboration.issueAgentCredential(
    app.collaboration.actorForUser(admin.id, app.config.project.id),
    app.config.project.id,
    "agent-config-test",
  );
  assert.equal(
    (await request("/api/agent-configuration", { session: credential })).status,
    403,
  );
});

test("late Agent probes cannot mark a changed model as verified", async (t) => {
  const { app, request } = await fixture(t);
  let release;
  let started;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  app.agentConfiguration.discoverModels = async () => {
    started();
    return new Promise((resolve) => {
      release = () =>
        resolve({
          models: [{ id: "test/gpt-6-luna", label: "Luna" }],
          model: "test/gpt-6-luna",
        });
    });
  };
  const pending = request("/api/agent-configuration/check", {
    method: "POST",
    body: { profileId: "opencode-test" },
  });
  await entered;
  await request("/api/agent-configuration/profiles/codex-test", {
    method: "PATCH",
    body: { model: "fixture-model" },
  });
  release();
  const result = await pending;
  assert.equal(
    result.data.agents.find((agent) => agent.id === "opencode-test").status,
    "unchecked",
  );
});
