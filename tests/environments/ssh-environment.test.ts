import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startMvpServer } from "../../src/server.js";
import { SshEnvironmentHub } from "../../src/ssh/ssh-environment-hub.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-ssh-api-"));
  const app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: path.join(root, "db.sqlite"),
    userSettingsFile: path.join(root, "settings.json"),
    config: { sourceRefresh: { enabled: false } },
  });
  app.collaboration.bootstrapAdmin({
    username: "admin",
    password: "SSH-Fixture-2026!",
  });
  const owner = app.collaboration.userByUsername("admin").id;
  const token = app.collaboration.login("admin", "SSH-Fixture-2026!").token;
  const request = async (
    route,
    {
      method = "GET",
      body,
      ssh,
      project = app.config.project.id,
      session = token,
    } = {},
  ) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "content-type": "application/json",
        "x-rw-session": session,
        "x-rw-project-id": project,
        ...(ssh ? { "x-rw-ssh-id": ssh } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => {
    await app.sshEnvironments.close();
    await app.sshConnections.close();
    await app.toolEnvironment.catalog.close();
    await app.toolEnvironment.research.close();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const profile = (
    await request("/api/ssh/connections", {
      method: "POST",
      body: { name: "Research host", mode: "alias", alias: "research" },
    })
  ).data;
  const sessions = app.sshConnections;
  const fake = {
    owner,
    profile: await sessions.profile(owner, profile.id),
    status: "connected",
    client: {},
    clients: [],
    channels: new Set(),
    proxies: [],
    info: {
      status: "ready",
      platform: "Linux",
      home: "/home/scientist",
      python: "/usr/bin/python3",
      user: "scientist",
      tools: {},
    },
  };
  sessions.sessions.set(sessions.sessionKey(owner, profile.id), fake);
  const calls = [];
  sessions.run = async (_owner, id, command, args, options) => {
    await sessions.connected(_owner, id);
    calls.push({ command, args, options });
    const output = (value) => ({
      ok: true,
      stdout: `TOPOLUMIA_REMOTE_PROBE:${JSON.stringify({ status: "ready", ...value })}`,
      stderr: "",
    });
    if (args[1] === "-" && args[2] === "info")
      return output({
        ...fake.info,
        tools: {
          conda: "/opt/conda/bin/conda",
          cuda: "/usr/local/cuda/bin/nvcc",
          nvidia: "/usr/bin/nvidia-smi",
        },
      });
    if (args[1] === "-" && args[2] === "directory")
      return output({ directory: JSON.parse(args[3]).directory });
    if (args[1] === "-" && args[2] === "discover") {
      const { source, directory } = JSON.parse(args[3]);
      return output({
        entries:
          source === "conda"
            ? [
                {
                  source,
                  name: "training",
                  prefix: "/opt/conda/envs/training",
                  pythonCommand: "/opt/conda/envs/training/bin/python",
                  manager: "conda",
                  hasPython: true,
                },
              ]
            : source === "venv" && directory
              ? [
                  {
                    source,
                    name: ".venv",
                    prefix: `${directory}/.venv`,
                    pythonCommand: `${directory}/.venv/bin/python`,
                    manager: "uv",
                    hasPython: true,
                  },
                ]
              : [],
      });
    }
    if (args[0] === "list")
      return {
        ok: true,
        stdout: JSON.stringify([
          { name: "torch", version: "2.9.0", channel: "private-token-channel" },
          { name: "numpy", version: "2.1.0", channel: "pypi" },
        ]),
        stderr: "",
      };
    const mode = args.at(-1),
      prefix = args.includes("--prefix")
        ? args[args.indexOf("--prefix") + 1]
        : "/usr";
    const python = {
      executable: `${prefix}/bin/python`,
      prefix,
      basePrefix: prefix,
      kind: "conda",
      version: "3.12.9",
    };
    return {
      ok: true,
      stdout: `TOPOLUMIA_PYTHON_PROBE:${JSON.stringify(mode === "packages" ? { status: "ready", python, packages: { wandb: "0.22.0" }, executables: {} } : { status: "ready", python })}`,
      stderr: "",
    };
  };
  return { app, request, owner, profile, fake, calls };
}

test("SSH HTTP keeps browse independent, scopes project directories, deduplicates views and binds only verified environments", async (t) => {
  const { app, request, profile, owner, calls, fake } = await fixture(t);
  const before = JSON.stringify(app.userSettings.settings);
  const runtime = app.runtimes.get(app.config.project.id);
  const [viewA, viewB] = await Promise.all([
    app.sshEnvironments.get(runtime, owner, profile.id),
    app.sshEnvironments.get(runtime, owner, profile.id),
  ]);
  assert.deepEqual(viewA, viewB);
  const catalog = await request(
    "/api/tools-environment/catalog/sources/conda",
    { ssh: profile.id },
  );
  assert.equal(catalog.status, 200);
  const env = catalog.data.sources.find((s) => s.id === "conda")
    .environments[0];
  assert.equal(env.prefix, "/opt/conda/envs/training");
  const inventory = (
    await request("/api/tools-environment", { ssh: profile.id })
  ).data;
  assert.equal(inventory.platform, "Linux");
  assert.equal(
    inventory.environment.find((i) => i.id === "node").version,
    process.versions.node,
  );
  assert.equal(JSON.stringify(app.userSettings.settings), before);
  const base = `/api/tools-environment/catalog/environments/${env.id}`;
  await request(base + "/check", { method: "POST", body: {}, ssh: profile.id });
  for (let i = 0; i < 100; i++) {
    if (
      (await request(base, { ssh: profile.id })).data.inspection.status !==
      "running"
    )
      break;
    await delay(5);
  }
  await request(base + "/packages/refresh", {
    method: "POST",
    body: {},
    ssh: profile.id,
  });
  let packages;
  for (let i = 0; i < 100; i++) {
    packages = await request(base + "/packages", { ssh: profile.id });
    if (packages.data.status !== "running") break;
    await delay(5);
  }
  assert.equal(packages.data.total, 2);
  assert.equal(
    JSON.stringify(packages).includes("private-token-channel"),
    false,
  );
  assert.equal(
    (
      await request(base + "/activate", {
        method: "POST",
        body: {},
        ssh: profile.id,
      })
    ).status,
    200,
  );
  assert.equal(app.userSettings.settings.researchLocation, "ssh");
  assert.equal(app.userSettings.settings.remoteEnvironment.ownerId, owner);
  assert.equal(
    calls.some((c) => c.command === "/opt/conda/bin/conda"),
    true,
  );
  fake.status = "disconnected";
  const offline = await request(base, { ssh: profile.id });
  assert.equal(offline.data.inspection.status, "completed");
  assert.equal(
    (await request("/api/ssh/connections")).data.current.connected,
    false,
  );
  fake.status = "connected";
  await request(`/api/ssh/connections/${profile.id}/project`, {
    method: "PATCH",
    body: { directory: "/home/scientist/project A" },
  });
  await request("/api/projects", {
    method: "POST",
    body: { id: "ssh-other", name: "Other project" },
  });
  assert.deepEqual(
    (
      await request(`/api/ssh/connections/${profile.id}/project`, {
        project: "ssh-other",
      })
    ).data,
    {},
  );
  const venv = await request("/api/tools-environment/catalog/sources/venv", {
    ssh: profile.id,
  });
  assert.equal(
    venv.data.sources.find((s) => s.id === "venv").environments[0].manager,
    "uv",
  );
});

test("Agent environment briefing reads the selected SSH snapshot without any remote commands or local fallback", async (t) => {
  const f = await fixture(t);
  const runtime = f.app.runtimes.get(f.app.config.project.id);
  const view = await f.app.sshEnvironments.get(runtime, f.owner, f.profile.id);
  await view.catalog.discover("conda");
  const entry = view.catalog.list("conda")[0];
  await view.catalog.check(entry.id);
  await view.catalog.workers.get(entry.id).worker.pending;
  await view.catalog.activate(entry.id);
  f.app.toolEnvironment.results.set("nvidia", { status: "ready", version: "LOCAL-ONLY-GPU" });
  const actor = f.app.collaboration.actorForUser(f.owner, f.app.config.project.id);
  const agent = f.app.collaboration.issueAgentCredential(actor, f.app.config.project.id, "environment-brief-runtime");
  const before = f.calls.length;
  const snapshot = await f.request("/api/research/environment", { session: agent });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.data.host.kind, "ssh");
  assert.equal(snapshot.data.data.host.alias, "research");
  assert.equal(snapshot.data.data.workingDirectory, "/home/scientist");
  assert.equal(snapshot.data.data.environment.python.executable, "/opt/conda/envs/training/bin/python");
  assert.equal(snapshot.data.data.execution.pythonPrefix.command, "/opt/conda/bin/conda");
  assert.equal(snapshot.data.data.components.find(item => item.id === "wandb").version, "0.22.0");
  assert.doesNotMatch(JSON.stringify(snapshot.data.data), /LOCAL-ONLY|password|keyPath|ciphertext|private-token/);
  assert.equal(f.calls.length, before);
  const reader = new SshEnvironmentHub(f.app.sshConnections);
  t.after(() => reader.close());
  const restored = await reader.contextSnapshot(runtime, f.owner);
  assert.equal(restored.inspection.status, "completed");
  assert.equal(restored.inspection.components.find(item => item.id === "wandb").version, "0.22.0");
  assert.equal(f.calls.length, before);
  f.fake.status = "disconnected";
  const offline = await f.request("/api/research/environment", { session: agent });
  assert.equal(offline.data.data.host.connected, false);
  assert.equal(offline.data.data.bindingVersion, snapshot.data.data.bindingVersion);
  assert.equal(offline.data.data.environment.python.executable, snapshot.data.data.environment.python.executable);
  await assert.rejects(reader.contextSnapshot(runtime, "another-owner"), { code: "SSH_ENVIRONMENT_OWNER_MISMATCH" });
  f.fake.profile.revision++;
  assert.equal((await f.request("/api/research/environment", { session: agent })).status, 409);
  assert.equal(f.calls.length, before);
});

test("SSH routes enforce project permissions and personal ownership and reject exec/settings bypasses", async (t) => {
  const { app, request, profile, owner } = await fixture(t);
  const actor = app.collaboration.actorForUser(owner, app.config.project.id);
  const reader = app.collaboration.createUser(
    { username: "reader", displayName: "Reader", password: "SSH-Reader-2026!" },
    actor,
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
  const session = app.collaboration.login("reader", "SSH-Reader-2026!").token;
  assert.deepEqual(
    (await request("/api/ssh/connections", { session })).data.connections,
    [],
  );
  assert.equal(
    (await request(`/api/ssh/connections/${profile.id}/project`, { session }))
      .status,
    404,
  );
  assert.equal(
    (
      await request("/api/tools-environment/catalog", {
        session,
        ssh: profile.id,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`/api/ssh/connections/${profile.id}/connect`, {
        session,
        method: "POST",
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/api/ssh/connections/${profile.id}/project`, {
        method: "PATCH",
        body: { directory: "/home/scientist", exec: "untrusted" },
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await request(`/api/ssh/connections/${profile.id}/exec`, {
        method: "POST",
        body: { command: "arbitrary" },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`/api/ssh/connections/${profile.id}/respond`, {
        method: "POST",
        body: { challengeId: profile.id, values: [], extra: "untrusted" },
      })
    ).status,
    422,
  );
  for (const body of [
    { researchLocation: "ssh" },
    { remoteEnvironment: { ownerId: owner } },
  ])
    assert.equal(
      (await request("/api/settings", { method: "PATCH", body })).status,
      422,
    );
  const credential = app.collaboration.issueAgentCredential(
    actor,
    app.config.project.id,
    "ssh-test-agent",
  );
  assert.equal(
    (await request("/api/ssh/connections", { session: credential })).status,
    403,
  );
});
