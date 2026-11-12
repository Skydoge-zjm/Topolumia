import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openCodeDriver, openCodeVersionProfile, assertOpenCodeBinding } from "../../../../src/adapters/agents/opencode/opencode-runtime.js";
import { ManagedWrapperRegistry } from "../../../../src/services/agents/managed-wrapper-registry.js";

test("legacy driver names stay V1 and native bindings reject profile reassignment", () => {
  assert.equal(openCodeDriver("opencode-server"), "opencode-server-v1");
  assert.equal(openCodeDriver("opencode-server-v2"), "opencode-server-v2");
  assert.throws(() => assertOpenCodeBinding({ driver: "opencode-server-v2" } as never, "opencode-server"), { code: "AGENT_RESUME_DRIVER_MISMATCH" });
});

test("both driver profiles reject unknown, older and future CLI versions without cross-version fallback", async () => {
  const registry = new ManagedWrapperRegistry({ root: "unused" });
  for (const [driver, version, expected] of [
    ["opencode-server", "1.19.0", "ready"], ["opencode-server-v1", "2.2.7", "incompatible"],
    ["opencode-server-v2", "1.19.0", "incompatible"], ["opencode-server-v2", "2.2.6", "incompatible"],
    ["opencode-server-v2", "2.2.7", "ready"], ["opencode-server-v2", "3.0.0", "incompatible"],
    ["opencode-server-v2", "unknown", "incompatible"],
  ]) {
    const profile = openCodeVersionProfile({ id: `${driver}-${version}`, driver, provider: "opencode", label: driver, command: process.execPath, versionArgs: ["-e", `console.log('${version}')`] });
    assert.equal((await registry.probe(profile)).availability, expected, `${driver} ${version}`);
  }
});

test("version directories have no cross-imports or opposite SDK dependencies", async () => {
  const root = fileURLToPath(new URL("../../../../src/adapters/agents/opencode/", import.meta.url));
  for (const version of ["v1", "v2"]) for (const entry of await readdir(path.join(root, version))) {
    if (!/\.(ts|js)$/.test(entry)) continue;
    const text = await readFile(path.join(root, version, entry), "utf8");
    assert.ok(!text.includes(version === "v1" ? '../v2/' : '../v1/'), entry);
    if (version === "v2") assert.ok(!text.includes('@opencode-ai/sdk'), entry);
    else assert.ok(!/from ["']@opencode\/client/.test(text), entry);
  }
});
