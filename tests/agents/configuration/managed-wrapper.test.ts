import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedWrapperRegistry } from "../../../src/services/agents/managed-wrapper-registry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("managed wrapper resolves to an app-owned launcher and proxies ACP stdio", async () => {
  const registry = new ManagedWrapperRegistry({ root: path.join(root, "managed-wrappers") });
  const profile = {
    id: "fixture-managed",
    managedWrapper: "acp-runtime-proxy",
    command: "node",
    runtimeCommand: "node",
    runtimeArgs: [path.join(root, "fixtures", "acp", "research-agent.js")],
  };
  const probe = await registry.probe(profile, { refresh: true });
  assert.equal(probe.availability, "ready");
  assert.equal(probe.wrapper.mode, "bundled");
  assert.equal(probe.wrapper.installRequired, false);
  const invocation = registry.invocation(profile);
  assert.equal(invocation.command, process.execPath);
  assert.match(invocation.args[0], /acp-runtime-proxy\.js$/);

  const child = spawn(invocation.command, invocation.args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const messages = [];
  reader.on("line", (line) => {
    try { messages.push(JSON.parse(line)); } catch { /* protocol diagnostics belong on stderr */ }
  });
  const waitFor = async (id) => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const message = messages.find((item) => item.id === id);
      if (message) return message;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${id}`);
  };
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  const initialized = await waitFor(1);
  assert.equal(initialized.result.agentInfo.name, "research-fixture-acp");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } })}\n`);
  const created = await waitFor(2);
  assert.match(created.result.sessionId, /^fixture_/);
  child.kill();
  reader.close();
});
