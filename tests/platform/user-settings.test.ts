import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { startMvpServer } from "../../src/server.js";
import {
  UserSettingsStore,
  applyUserSettings,
  defaultUserSettings,
} from "../../src/services/platform/user-settings-store.js";

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "research-workbench-settings-"));
  const config = await loadConfig({
    project: { root, name: "Settings test" },
    userSettings: { file: path.join(root, "runtime", "user-settings.json") },
  });
  return { root, config };
}

test("tool settings persist when the project has no Agent profiles", async () => {
  const { root, config } = await makeFixture();
  config.agentSessions.profiles = [];
  try {
    const store = new UserSettingsStore({ filePath: config.userSettings.file, config });
    await store.initialize();
    await store.update({ sources: { mlflow: { baseUrl: "http://localhost:5000", experimentName: "records" } } });
    const restored = new UserSettingsStore({ filePath: config.userSettings.file, config });
    await restored.initialize();
    assert.equal(restored.settings.sources.mlflow.baseUrl, "http://localhost:5000");
    assert.equal(restored.settings.sources.mlflow.experimentName, "records");
    assert.equal(restored.settings.agent.defaultProfileId, "");
    await assert.rejects(store.update({ agent: { defaultProfileId: "missing" } }), { code: "USER_SETTINGS_INVALID" });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("user settings expose runtime tuning and survive a new store instance", async () => {
  const { root, config } = await makeFixture();
  try {
    const store = new UserSettingsStore({ filePath: config.userSettings.file, config });
    await store.initialize();
    const defaults = defaultUserSettings(config);
    assert.equal(defaults.agent.profileModels["codex-acp"], "gpt-6-luna");
    assert.equal(defaults.sources.mlflow.maxRuns, 300);
    assert.equal(defaults.git.timeoutSeconds, 5);
    assert.equal(defaults.agent.sandbox, "workspace-write");
    assert.equal(defaults.agent.approvalPolicy, "on-request");
    assert.equal(defaults.curator.automation.enabled, false);
    assert.equal(defaults.curator.automation.backgroundMode, "suggested");
    assert.ok(store.snapshot({ schema: true }).schema.editable.curator.includes("automation.backgroundMode"));

    const updated = await store.update({
      agent: { profileModels: { "codex-acp": "gpt-5.6-mini" }, reasoningEffort: "medium", sandbox: "workspace-write", approvalPolicy: "on-request" },
      curator: { automation: { enabled: true, minPendingEvents: 5, cooldownSeconds: 0, backgroundMode: "background" } },
      sourceRefresh: { enabled: false, foregroundThresholdSeconds: 5 },
      sources: {
        mlflow: { baseUrl: "http://localhost:5000", experimentName: "sr", maxRuns: 40 },
        tensorboard: { logdir: "logs/tensorboard", pythonCommand: "python-custom" },
      },
      git: { timeoutSeconds: 12, maxOutputMb: 2 },
    });
    assert.equal(updated.settings.agent.profileModels["codex-acp"], "gpt-5.6-mini");
    assert.equal(updated.settings.sources.mlflow.maxRuns, 40);
    assert.equal(updated.settings.sourceRefresh.enabled, false);
    assert.equal(updated.settings.curator.automation.enabled, true);
    assert.equal(updated.settings.curator.automation.cooldownSeconds, 0);
    assert.equal(updated.settings.agent.sandbox, "workspace-write");
    assert.equal(updated.settings.agent.approvalPolicy, "on-request");

    applyUserSettings(config, updated.settings);
    assert.equal(config.agentSessions.profiles.find(profile => profile.provider === "codex").model, "gpt-5.6-mini");
    assert.equal(config.agentSessions.profiles.find(profile => profile.provider === "codex").reasoningEffort, "medium");
    assert.equal(config.sourceRefresh.enabled, false);
    assert.equal(config.mlflow.maxRuns, 40);
    assert.equal(config.tensorboard.logdir, path.join(root, "logs", "tensorboard"));
    assert.equal(config.tensorboard.pythonCommand, "python-custom");
    assert.equal(config.git.timeoutMs, 12_000);
    assert.equal(config.agentSessions.profiles.find((profile) => profile.provider === "codex").sandbox, "workspace-write");
    assert.equal(config.agentSessions.profiles.find((profile) => profile.provider === "claude").permissionMode, "default");
    assert.equal(config.agentSessions.profiles.find((profile) => profile.provider === "opencode").approvalPolicy, "on-request");

    const restored = new UserSettingsStore({ filePath: config.userSettings.file, config });
    await restored.initialize();
    assert.equal(restored.settings.agent.profileModels["codex-acp"], "gpt-5.6-mini");
    assert.equal(restored.settings.curator.automation.backgroundMode, "background");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("user settings reject unsafe endpoints and paths", async () => {
  const { root, config } = await makeFixture();
  try {
    const store = new UserSettingsStore({ filePath: config.userSettings.file, config });
    await store.initialize();
    await assert.rejects(
      store.update({ sources: { mlflow: { baseUrl: "http://user:secret@example.test" } } }),
      (error) => error.code === "USER_SETTINGS_INVALID",
    );
    await assert.rejects(
      store.update({ sources: { filesystem: { roots: ["../../outside"] } } }),
      (error) => error.code === "USER_SETTINGS_PATH_OUTSIDE_PROJECT",
    );
    await assert.rejects(
      store.update({ agent: { maxSessions: 0 } }),
      (error) => error.code === "USER_SETTINGS_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("settings API applies a patch without requiring a config-file edit", async () => {
  const { root, config } = await makeFixture();
  let app;
  try {
    app = await startMvpServer({
      port: 0,
      config,
      userSettingsFile: path.join(root, "runtime", "api-settings.json"),
    });
    const get = await fetch(`${app.url}/api/settings`);
    assert.equal(get.status, 200);
    const initial = await get.json();
    const patch = await fetch(`${app.url}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { agent: { profileModels: { "codex-acp": "gpt-5.6-mini" }, reasoningEffort: "high" } } }),
    });
    assert.equal(patch.status, 200);
    const updated = await patch.json();
    assert.equal(updated.settings.agent.profileModels["codex-acp"], "gpt-5.6-mini");
    assert.equal(updated.settings.agent.reasoningEffort, "high");
    assert.equal(app.config.agentSessions.profiles.find(profile => profile.provider === "codex").model, "gpt-5.6-mini");
    assert.equal(app.config.agentSessions.profiles.find((profile) => profile.provider === "codex").reasoningEffort, "high");
    assert.equal(initial.settings.sources.mlflow.experimentName, "diffusion-sr-reproduction");
  } finally {
    app?.sourceRefresh?.stop();
    await app?.agentSessionGateway?.closeAll?.();
    await app?.agentMedia?.close();
    await app?.researchCommands?.assets.close();
    await app?.toolEnvironment?.catalog.close();
    await app?.toolEnvironment?.research.close();
    await app?.sshEnvironments?.close();
    await app?.sshConnections?.close();
    if (app?.server) await new Promise((resolve) => app.server.close(resolve));
    app?.collaboration?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
