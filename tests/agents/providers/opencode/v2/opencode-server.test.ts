import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { OpenCodeV2Server } from "../../../../../src/adapters/agents/opencode/v2/opencode-server.js";

test("V2 owns its authenticated process, configuration snapshot and separate native database", { timeout: 15_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-v2-server-"));
  const file = path.join(root, "opencode.jsonc"), server = new OpenCodeV2Server();
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const config = { providers: { custom: { settings: { baseURL: "https://fixture.invalid" } } }, permissions: [{ action: "shell", resource: "git push *", effect: "deny" }] };
  await writeFile(file, JSON.stringify(config));
  const fixture = fileURLToPath(new URL("../../../../../fixtures/native/opencode/v2/config-server.js", import.meta.url));
  await server.start({ id: "v2", label: "V2", provider: "opencode", command: process.execPath, args: [fixture], nativeConfigFile: file, nativeConfig: config as never, nativeConfigRoot: root }, root);
  assert.equal((await fetch(`${server.url}/api/info`)).status, 401);
  assert.equal(server.version, "2.2.7");
  await server.close();
  await assert.rejects(fetch(`${server.url}/api/info`, { signal: AbortSignal.timeout(1000) }));
});

test("V2 close during startup prevents a late server from spawning", async () => {
  const server = new OpenCodeV2Server();
  const starting = server.start({ id: "late", label: "V2", provider: "opencode", command: process.execPath, args: ["missing-fixture.js"] }, process.cwd());
  await server.close();
  await assert.rejects(starting, { code: "OPENCODE_V2_CLOSED" });
});
