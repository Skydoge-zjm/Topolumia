import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startMvpServer } from "../../../src/server.js";
import { NativeAgentConfigStore } from "../../../src/services/agents/configuration/native-config-store.js";
import {
  parseNativeConfig,
  codexConfigurationArgs,
} from "../../../src/services/agents/configuration/native-format.js";
import { claudeSettingsFile } from "../../../src/adapters/agents/shared/native-config.js";
import { CodexAppServerDriver } from "../../../src/adapters/agents/codex/codex-app-server-driver.js";
import { ClaudeCliStreamDriver } from "../../../src/adapters/agents/claude/claude-cli-stream-driver.js";
import { OpenCodeServer } from "../../../src/adapters/agents/opencode/opencode-server.js";

async function fixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "topolumia-native-config-"),
  );
  const app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: path.join(root, "db.sqlite"),
    userSettingsFile: path.join(root, "settings.json"),
    config: {
      sourceRefresh: { enabled: false },
      agentSessions: {
        profiles: ["codex", "claude", "opencode"].map((provider) => ({
          id: provider,
          label: provider,
          provider,
          command: process.execPath,
          versionArgs: ["--version"],
          model: "gpt-6-luna",
        })),
      },
    },
  });
  const user = app.collaboration.bootstrapAdmin({
    username: "config-admin",
    password: "Native-Configuration-2026!",
  });
  const actor = app.collaboration.actorForUser(user.id, app.config.project.id),
    token = app.collaboration.login(
      "config-admin",
      "Native-Configuration-2026!",
    ).token;
  const request = async (
    provider,
    {
      method = "GET",
      body,
      project = app.config.project.id,
      session = token,
    } = {},
  ) => {
    const response = await fetch(
      app.url + `/api/agent-configuration/profiles/${provider}/native-config`,
      {
        method,
        headers: {
          "content-type": "application/json",
          "x-rw-project-id": project,
          "x-rw-session": session,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => {
    for (const runtime of app.runtimes.values()) {
      await runtime.agentSessionGateway.closeAll();
      await runtime.toolEnvironment.catalog.close();
      await runtime.toolEnvironment.research.close();
    }
    await app.sshEnvironments.close();
    await app.sshConnections.close();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, app, actor, request, token };
}
test("native config files use each provider's format and preserve all text and custom fields", async (t) => {
  const f = await fixture(t);
  const contents = {
    codex:
      '# Keep this comment\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n[model_providers.lab]\nbase_url = "https://lab.example/v1"\nenv_key = "LAB_API_KEY"\n[future_options]\nenabled = true\n',
    claude: JSON.stringify(
      {
        model: "gpt-6-luna",
        env: { ANTHROPIC_API_KEY: "private-native-api-key" },
        hooks: { PreToolUse: [] },
        permissions: { allow: ["Read"], deny: ["Read(.env)"] },
        futureOption: { enabled: true },
      },
      null,
      2,
    ),
    opencode:
      '// Keep JSONC comment\n{"model":"lab/gpt-6-luna","provider":{"lab":{"options":{"apiKey":"private-provider-key"}}},"permission":{"bash":"ask"},"futureOption":true,}\n',
  };
  for (const [provider, content] of Object.entries(contents)) {
    const first = await f.request(provider);
    assert.equal(first.status, 200);
    assert.ok(
      first.data.path.startsWith(path.dirname(f.app.userSettings.filePath)),
    );
    assert.ok(Object.keys(first.data.schema.properties).length > 40);
    const result = await f.request(provider, {
      method: "PUT",
      body: { content, expectedRevision: first.data.revision },
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.content, content);
    assert.equal(await readFile(result.data.path, "utf8"), content);
    const profile = f.app.agentProfileRegistry.profiles.get(provider);
    assert.equal(
      profile.model,
      provider === "opencode" ? "lab/gpt-6-luna" : "gpt-6-luna",
    );
    const snapshot = await f.app.nativeConfigs.snapshot(profile);
    assert.equal(await readFile(snapshot.nativeConfigFile, "utf8"), content);
    assert.ok(snapshot.nativeConfigFile.includes("snapshots"));
    const conflict = await f.request(provider, {
      method: "PUT",
      body: { content: content + " ", expectedRevision: first.data.revision },
    });
    assert.equal(conflict.status, 409);
  }
  assert.doesNotMatch(
    JSON.stringify(f.app.agentConfiguration.inventory()),
    /private-native|private-provider|apiKey|ANTHROPIC_API_KEY/,
  );
  const store = new NativeAgentConfigStore(f.app.nativeConfigs.root);
  await store.initialize([...f.app.agentProfileRegistry.profiles.values()]);
  assert.equal((await store.read("claude")).content, contents.claude);
});
test("malformed documents never replace the saved config and externally broken documents remain repairable", async (t) => {
  const f = await fixture(t),
    before = (await f.request("codex")).data;
  for (const content of [
    'model = "unterminated',
    "model = 42",
    'model = "x"\n[__proto__]\nx=1',
    "model = nan",
  ]) {
    assert.equal(
      (
        await f.request("codex", {
          method: "PUT",
          body: { content, expectedRevision: before.revision },
        })
      ).status,
      422,
    );
    assert.equal(await readFile(before.path, "utf8"), before.content);
  }
  await writeFile(before.path, 'model = "broken');
  const broken = (await f.request("codex")).data;
  assert.equal(broken.valid, false);
  assert.equal(typeof broken.content, "string");
  assert.equal(
    (
      await f.request("codex", {
        method: "PUT",
        body: { content: before.content, expectedRevision: broken.revision },
      })
    ).status,
    200,
  );
});
test("config document access requires management permission and is isolated between project data roots", async (t) => {
  const f = await fixture(t),
    original = (await f.request("codex")).data;
  const guest = f.app.collaboration.createUser(
      {
        username: "config-reader",
        password: "Config-Reader-2026!",
        displayName: "Reader",
      },
      f.actor,
    ),
    now = new Date().toISOString();
  f.app.collaboration.db
    .prepare(
      "INSERT INTO memberships(project_id,user_id,role,status,created_at,updated_at) VALUES(?,?,'guest','active',?,?)",
    )
    .run(f.app.config.project.id, guest.id, now, now);
  const guestToken = f.app.collaboration.login(
    "config-reader",
    "Config-Reader-2026!",
  ).token;
  assert.equal((await f.request("codex", { session: guestToken })).status, 403);
  const project = f.app.collaboration.createProject(
    { id: "config-other-project", name: "Other" },
    f.actor,
  );
  const other = (await f.request("codex", { project: project.id })).data;
  assert.notEqual(other.path, original.path);
  const agentToken = f.app.collaboration.issueAgentCredential(
    f.actor,
    f.app.config.project.id,
    "config-agent",
  );
  assert.equal((await f.request("codex", { session: agentToken })).status, 403);
});
test("snapshots retain their values across saves and TOML startup overrides round trip nested values", async (t) => {
  const f = await fixture(t),
    before = await f.app.nativeConfigs.document("codex");
  const first = await f.app.nativeConfigs.snapshot(
    f.app.agentProfileRegistry.profiles.get("codex"),
  );
  await f.app.agentConfiguration.saveConfigurationDocument("codex", {
    content:
      'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n[features]\nweb_search = false\n',
    expectedRevision: before.revision,
  });
  assert.equal(first.nativeConfig.model_reasoning_effort, "low");
  assert.equal(
    parseNativeConfig("codex", await readFile(first.nativeConfigFile, "utf8"))
      .model_reasoning_effort,
    "low",
  );
  const config = {
    model: "gpt-6-luna",
    features: { search: false },
    mcp_servers: {
      papers: {
        command: "E:\\folder with spaces\\python.exe",
        args: ["-m", "papers"],
        env: { SPECIAL: 'line\n"quoted"' },
      },
    },
  };
  const args = codexConfigurationArgs(config),
    reconstructed = parseNativeConfig(
      "codex",
      args.filter((_, index) => index % 2 === 1).join("\n"),
    );
  assert.deepEqual(JSON.parse(JSON.stringify(reconstructed)), config);
});
test("Codex startup and thread configuration preserve custom settings and merge required research bindings", async (t) => {
  const f = await fixture(t),
    doc = await f.app.nativeConfigs.document("codex");
  await f.app.nativeConfigs.save(
    "codex",
    'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\napproval_policy = "never"\nsandbox_mode = "read-only"\ndeveloper_instructions = "Custom research guidance"\n[mcp_servers.papers]\ncommand = "papers"\n[mcp_servers.topolumia]\nurl = "https://old.invalid"\n',
    doc.revision,
  );
  const fixtureFile = fileURLToPath(
    new URL("../../../fixtures/native/codex-app-server.js", import.meta.url),
  );
  const profile = await f.app.nativeConfigs.snapshot({
    id: "codex",
    provider: "codex",
    label: "Codex",
    command: process.execPath,
    args: [fixtureFile],
  });
  const driver = new CodexAppServerDriver(profile);
  const messages = [],
    original = driver.start.bind(driver);
  // Observe the actual JSON-RPC transport sent to a subprocess.
  const { JsonlProcess } =
    await import("../../../src/adapters/agents/shared/jsonl-process.js");
  const request = JsonlProcess.prototype.request;
  JsonlProcess.prototype.request = function (method, params, ...args) {
    if (["thread/start", "thread/resume"].includes(method))
      messages.push({ method, params });
    return request.call(this, method, params, ...args);
  };
  t.after(() => {
    JsonlProcess.prototype.request = request;
  });
  try {
    await original({
      cwd: f.root,
      developerInstructions: "Topolumia research instructions",
      researchMcp: {
        name: "topolumia",
        command: "node",
        args: ["mcp.js"],
        env: { TOPOLUMIA_SESSION: "fixture" },
        cwd: f.root,
      },
    });
    assert.ok(driver.process.args.includes("-c"));
    assert.ok(driver.process.args.includes('model_reasoning_effort="high"'));
    const params = messages[0].params;
    assert.equal(params.approvalPolicy, "never");
    assert.equal(params.sandbox, "read-only");
    assert.equal(params.config.mcp_servers.papers.command, "papers");
    assert.equal(params.config.mcp_servers.topolumia.url, undefined);
    assert.match(params.developerInstructions, /Custom research guidance/);
    assert.match(
      params.developerInstructions,
      /Topolumia research instructions/,
    );
  } finally {
    await driver.close();
    JsonlProcess.prototype.request = request;
  }
});
test("Claude receives one settings file and session grants retain every original setting", async (t) => {
  const f = await fixture(t),
    doc = await f.app.nativeConfigs.document("claude");
  const config = {
    model: "gpt-6-luna",
    effortLevel: "high",
    env: { CUSTOM_PROVIDER: "lab" },
    hooks: { PreToolUse: [] },
    permissions: {
      allow: ["Read"],
      deny: ["Read(.env)"],
      ask: ["Bash(rm *)"],
      defaultMode: "acceptEdits",
    },
  };
  await f.app.nativeConfigs.save(
    "claude",
    JSON.stringify(config),
    doc.revision,
  );
  const fixtureFile = fileURLToPath(
    new URL("../../../fixtures/native/claude-cli.js", import.meta.url),
  );
  const profile = await f.app.nativeConfigs.snapshot({
    id: "claude",
    provider: "claude",
    label: "Claude",
    command: process.execPath,
    launcherArgs: [fixtureFile],
  });
  const settings = await claudeSettingsFile(
    profile,
    new Set(["Bash(python train.py)"]),
  );
  const derived = JSON.parse(await readFile(settings, "utf8"));
  assert.deepEqual(derived.permissions.allow, [
    "Read",
    "Bash(python train.py)",
  ]);
  assert.deepEqual(derived.permissions.deny, config.permissions.deny);
  assert.deepEqual(derived.hooks, config.hooks);
  assert.deepEqual(derived.env, config.env);
  const events = [],
    driver = new ClaudeCliStreamDriver(profile, {
      requestTimeoutMs: 4000,
      onEvent: (event) => events.push(event),
    });
  try {
    await driver.start({ cwd: f.root });
    await driver.prompt({
      turnId: "config",
      content: [{ type: "text", text: "approval-settings" }],
    });
    const output = JSON.parse(
      events
        .filter((event) => event.type === "assistant.message.completed")
        .at(-1).payload.text,
    );
    assert.equal(output.settingsCount, 1);
    assert.equal(output.settingsFile, profile.nativeConfigFile);
    assert.deepEqual(output.settings, config);
    assert.equal(output.permissionMode, "acceptEdits");
  } finally {
    await driver.close();
  }
});
test("OpenCode receives a native file and complete inline config without losing custom models, permissions or options", async (t) => {
  const f = await fixture(t),
    doc = await f.app.nativeConfigs.document("opencode");
  const config = {
    model: "lab/gpt-6-luna",
    permission: { bash: "ask" },
    provider: {
      lab: {
        options: {
          baseURL: "https://lab.example/v1",
          apiKey: "fixture-config-secret",
        },
      },
    },
    share: "manual",
    autoupdate: true,
  };
  await f.app.nativeConfigs.save(
    "opencode",
    JSON.stringify(config),
    doc.revision,
  );
  const profile = await f.app.nativeConfigs.snapshot({
    id: "opencode",
    provider: "opencode",
    label: "OpenCode",
    command: process.execPath,
    args: [
      fileURLToPath(
        new URL(
          "../../../fixtures/native/opencode-config-server.js",
          import.meta.url,
        ),
      ),
    ],
  });
  const server = new OpenCodeServer();
  try {
    const client = await server.start(profile, f.root);
    const result = (await client.config.get()).data;
    assert.equal(result.fixtureConfigPath, profile.nativeConfigFile);
    assert.deepEqual(result.fixtureInline, config);
    assert.equal(result.share, "manual");
    assert.equal(result.autoupdate, true);
    assert.deepEqual(result.permission, config.permission);
    assert.deepEqual(result.provider, config.provider);
  } finally {
    await server.close();
  }
});
