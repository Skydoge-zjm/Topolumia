import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { NativeAgentConfigStore } from "../../../src/services/agents/configuration/native-config-store.js";
import { parseNativeConfig, nativeProfile } from "../../../src/services/agents/configuration/native-format.js";

test("V1 and V2 retain separate files, schemas, snapshots and defaults across store restarts", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-config-isolation-")); t.after(() => rm(root, { recursive: true, force: true }));
  const v1 = { id: "opencode-acp", provider: "opencode", label: "V1", driver: "opencode-server-v1", command: "opencode", model: "lab/old" };
  const v2 = { ...v1, id: "opencode-v2", label: "V2", driver: "opencode-server-v2", model: "lab/new" };
  const store = new NativeAgentConfigStore(root); await store.initialize([v1, v2]);
  const first = await store.document("opencode"), second = await store.document("opencode-v2");
  assert.equal(first.path, path.join(root, "opencode", "opencode.jsonc"));
  assert.equal(second.path, path.join(root, "opencode-v2", "opencode.jsonc"));
  assert.equal(second.provider, "opencode"); assert.equal(second.configKey, "opencode-v2");
  const oldBytes = await readFile(first.path, "utf8"), v1Snapshot = await store.snapshot(v1);
  const content = '// V2 rules\n{"model":"lab/newer#high","permissions":[{"action":"shell","resource":"rm *","effect":"deny"}],"providers":{"lab":{"settings":{"baseURL":"https://fixture.invalid"}}}}';
  await store.save("opencode-v2", content, second.revision);
  assert.equal(await readFile(first.path, "utf8"), oldBytes);
  assert.equal(await readFile(v1Snapshot.nativeConfigFile, "utf8"), oldBytes);
  const restarted = new NativeAgentConfigStore(root); await restarted.initialize([v1, v2]);
  assert.equal((await restarted.snapshot(v1)).model, "lab/old");
  const next = await restarted.snapshot(v2); assert.equal(next.model, "lab/newer"); assert.equal(next.reasoningEffort, "high");
  assert.equal(await readFile(next.nativeConfigFile, "utf8"), content);
  assert.ok(JSON.stringify(second.schema).includes("Permission.Ruleset"));
});

test("V2 accepts its object model and rejects malformed permission arrays without changing saved data", () => {
  const config = parseNativeConfig("opencode-v2", '{"model":{"providerID":"lab","model":"reasoner","variant":"high"},"permissions":[]}');
  const profile = nativeProfile({ id: "v2", label: "V2", provider: "opencode", driver: "opencode-server-v2", command: "opencode" }, config);
  assert.equal(profile.model, "lab/reasoner"); assert.equal(profile.reasoningEffort, "high");
  assert.throws(() => parseNativeConfig("opencode-v2", '{"permissions":{"bash":"ask"}}'), { code: "AGENT_NATIVE_CONFIG_INVALID" });
});
