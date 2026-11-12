import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenCodeV2Fixture } from "../../../../../fixtures/native/opencode/v2/server.js";
import { OpenCodeV2AgentAdapter } from "../../../../../src/adapters/agents/opencode/v2/opencode-agent-adapter.js";

async function fixture(t, autoRespond = true) {
  const f = await createOpenCodeV2Fixture({ autoRespond });
  const events = [];
  const adapter = new OpenCodeV2AgentAdapter({ id: "v2", provider: "opencode", label: "OpenCode 2", command: "fixture" }, {
    serverFactory: () => ({ start: async () => f.client, close: async () => {}, version: "2.2.7" }) as never,
    onEvent: event => events.push(event),
  });
  t.after(async () => { await adapter.close(); await f.close(); });
  await adapter.start({ cwd: process.cwd(), developerInstructions: "Topolumia research guidance", researchMcp: { name: "topolumia", command: "node", args: ["mcp.js"], cwd: process.cwd(), env: { TOPOLUMIA_SESSION: "private-test-token" } } });
  return { ...f, adapter, events };
}

test("V2 sends model, instructions, MCP and image input through the official client across turns", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  for (let n = 1; n <= 2; n++) {
    const result = await f.adapter.prompt({ turnId: `turn${n}`, reasoningEffort: "high", content: [{ type: "text", text: "Check research" }] });
    assert.equal(result.stopReason, "end_turn");
    const events = f.events.filter(event => event.turnId === `turn${n}`);
    assert.deepEqual(events.filter(event => ["assistant.message.completed", "tool.completed"].includes(event.type)).map(event => event.type), ["assistant.message.completed", "tool.completed", "assistant.message.completed"]);
    assert.equal(events.filter(event => event.type === "reasoning.summary.completed").length, 1);
    assert.equal(events.filter(event => event.type === "tool.started").length, 1);
    assert.equal(events.filter(event => event.type === "usage.updated" && event.payload.scope === "step").length, 1);
    assert.equal(events.filter(event => event.type === "usage.updated" && event.payload.scope === "session").at(-1).payload.cost, n * 0.01);
  }
  const model = f.calls.find(call => call.path.endsWith("/model") && call.method === "POST");
  assert.deepEqual(model.body.model, { providerID: "fixture", id: "model/with-slash", variant: "high" });
  assert.ok(f.calls.some(call => call.path.endsWith("/instructions/entries/topolumia.research") && call.body.value === "Topolumia research guidance"));
  const mcp = f.calls.find(call => call.method === "PUT" && call.path.includes("/mcp/"));
  assert.equal(mcp.body.config.pool, false);
  assert.equal(mcp.body.config.environment.TOPOLUMIA_SESSION, "private-test-token");
  assert.ok(!JSON.stringify(f.events).includes("private-test-token"));
  const snapshot = await f.adapter.readSnapshot();
  assert.equal(snapshot.events.filter(event => event.type === "assistant.message.completed").length, 4);
  assert.ok(snapshot.events.filter(event => event.payload.scope !== "session").every(event => event.turnId));
  assert.equal(snapshot.events.find(event => event.payload.scope === "session").payload.cost, 0.02);
});

test("V2 rejects invalid model and variant before admitting a prompt", async t => {
  const f = await fixture(t);
  await assert.rejects(f.adapter.prompt({ turnId: "model", model: "missing", content: [] }), { code: "OPENCODE_MODEL_UNAVAILABLE" });
  await assert.rejects(f.adapter.prompt({ turnId: "variant", reasoningEffort: "ultra", content: [] }), { code: "OPENCODE_VARIANT_UNAVAILABLE" });
  assert.equal(f.calls.filter(call => call.path.endsWith("/prompt")).length, 0);
});

test("V2 early cancellation waits for admission, interrupts once and remains reusable", { timeout: 10_000 }, async t => {
  const f = await fixture(t, false); f.deferPrompt();
  const pending = f.adapter.prompt({ turnId: "cancel", content: [{ type: "text", text: "hold" }] });
  while (!f.calls.some(call => call.path.endsWith("/prompt"))) await delay(5);
  f.adapter.cancel(); f.adapter.cancel();
  assert.equal(f.calls.filter(call => call.path.endsWith("/interrupt")).length, 0);
  f.releasePrompt(); assert.equal((await pending).stopReason, "cancelled");
  assert.equal(f.calls.filter(call => call.path.endsWith("/interrupt")).length, 1);
  assert.ok(f.calls.findIndex(call => call.method === "DELETE" && call.path.includes("/inbox/")) < f.calls.findIndex(call => call.path.endsWith("/interrupt")));
  assert.equal(f.adapter.closed, false);
});

test("V2 closes its process after ambiguous prompt failure", { timeout: 10_000 }, async t => {
  const f = await fixture(t, false); f.failPrompt(409);
  await assert.rejects(f.adapter.prompt({ turnId: "failure", content: [] }), /fixture prompt failed/);
  assert.equal(f.adapter.closed, true);
});

test("V2 close interrupts accepted work before retiring the owned server", { timeout: 10000 }, async t => {
  const f = await fixture(t, false);
  const result = f.adapter.prompt({ turnId: "close", content: [{ type: "text", text: "hold" }] });
  while (!f.calls.some(call => call.path.endsWith("/prompt"))) await delay(5);
  await delay(20);
  await f.adapter.close();
  assert.equal((await result).stopReason, "cancelled");
  assert.ok(f.calls.some(call => call.path.endsWith("/interrupt")));
  assert.equal(f.adapter.closed, true);
});

test("V2 interrupt failure retires the server and rejects overlapping execution", { timeout: 10000 }, async t => {
  const f = await fixture(t, false);
  const result = f.adapter.prompt({ turnId: "interrupt", content: [{ type: "text", text: "hold" }] });
  while (!f.calls.some(call => call.path.endsWith("/prompt"))) await delay(5);
  await delay(20); f.failInterrupt(500); f.adapter.cancel();
  await assert.rejects(result);
  assert.equal(f.adapter.closed, true);
  await assert.rejects(f.adapter.prompt({ turnId: "overlap", content: [] }), { code: "OPENCODE_NOT_READY" });
});
