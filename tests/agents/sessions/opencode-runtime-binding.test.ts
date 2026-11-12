import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentProfileRegistry } from "../../../src/services/agents/agent-profile-registry.js";
import { AgentSessionGateway } from "../../../src/services/agents/agent-session-gateway.js";

test("persisted OpenCode V1 sessions reject a reassigned V2 profile for resume and snapshot sync", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-runtime-binding-"));
  const profile = { id: "opencode-acp", provider: "opencode", label: "V1", driver: "opencode-server", command: process.execPath, versionArgs: ["-e", "console.log('1.19.0')"] };
  const registry = new AgentProfileRegistry({ agentSessions: { profiles: [profile], managedWrappersRoot: root } } as never);
  const create = registry.createAdapter.bind(registry);
  registry.createAdapter = async (...args) => {
    const adapter = await create(...args);
    adapter.start = async () => ({ nativeSessionId: "ses_old", capabilities: { session: { resume: true, sync: true } } });
    adapter.readSnapshot = async () => ({ format: "agent-native-events.v1", events: [] });
    return adapter;
  };
  const file = path.join(root, "history.sqlite");
  const first = new AgentSessionGateway({ profileRegistry: registry, historyFile: file }); await first.initialize();
  const created = await first.create({ profileId: profile.id });
  assert.equal(created.nativeDriver, "opencode-server-v1");
  await first.closeAll();
  registry.profiles.set(profile.id, { ...profile, driver: "opencode-server-v2" });
  const restored = new AgentSessionGateway({ profileRegistry: registry, historyFile: file });
  t.after(async () => { await restored.closeAll(); await rm(root, { recursive: true, force: true }); });
  await restored.initialize();
  assert.equal(restored.snapshot(created.id).nativeDriver, "opencode-server-v1");
  await assert.rejects(restored.resume(created.id), { code: "AGENT_RESUME_DRIVER_MISMATCH" });
  const synced = await restored.sync(created.id);
  assert.equal(synced.error?.code, "AGENT_RESUME_DRIVER_MISMATCH");
  assert.equal(restored.snapshot(created.id).nativeSessionId, "ses_old");
});
