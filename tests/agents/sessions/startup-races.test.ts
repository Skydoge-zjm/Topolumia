import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as tick } from "node:timers/promises";
import { AgentSessionGateway } from "../../../src/services/agents/agent-session-gateway.js";

function deferred() {
  let resolve;
  const promise = new Promise<any>(done => { resolve = done; });
  return { promise, resolve: value => resolve(value) };
}

for (const phase of ["factory", "start"]) for (const shutdown of [false, true]) {
  test(`${shutdown ? "shutdown" : "close"} drains a delayed ${phase} without reviving the session`, async () => {
    const gate = deferred(), entered = deferred();
    let starts = 0;
    const adapter = {
      profile: { provider: "fixture" }, closed: false,
      async start() { starts++; if (phase === "start") { entered.resolve(null); await gate.promise; } return { nativeSessionId: "fixture", capabilities: {} }; },
      async close() { this.closed = true; },
    };
    const gateway = new AgentSessionGateway({ profileRegistry: { async createAdapter() { if (phase === "factory") { entered.resolve(null); await gate.promise; } return adapter; } } });
    const creating = gateway.create({ profileId: "fixture" });
    const rejected = assert.rejects(creating, { code: "AGENT_SESSION_START_CANCELLED" });
    await entered.promise;
    const id = gateway.list({ summary: true })[0].id;
    const closing = shutdown ? gateway.closeAll() : gateway.close(id);
    await tick(0);
    gate.resolve(null);
    await Promise.all([closing, rejected]);
    assert.equal(starts, phase === "factory" ? 0 : 1);
    assert.equal(adapter.closed, true);
    assert.equal(gateway.snapshot(id).status, shutdown ? "detached" : "closed");
    await gateway.closeAll();
  });
}

test("continuation during startup shares the runtime and still validates ownership", async () => {
  const gate = deferred();
  let factories = 0;
  const gateway = new AgentSessionGateway({ profileRegistry: { async createAdapter() { factories++; await gate.promise; return { profile: { provider: "fixture" }, start: async () => ({ capabilities: {} }), close: async () => {} }; } } });
  const creating = gateway.create({ profileId: "fixture", ownerUserId: "owner" });
  await tick(0);
  const id = gateway.list({ summary: true })[0].id;
  await assert.rejects(gateway.resume(id, { ownerUserId: "other" }), { code: "AGENT_SESSION_OWNER_MISMATCH" });
  const resumed = gateway.resume(id, { ownerUserId: "owner" });
  gate.resolve(null);
  const [first, second] = await Promise.all([creating, resumed]);
  assert.equal(first.runtimeInstanceId, second.runtimeInstanceId);
  assert.equal(factories, 1);
  await gateway.closeAll();
});
