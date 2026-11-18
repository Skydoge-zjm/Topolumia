import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenCodeV2Fixture } from "../../../../../fixtures/native/opencode/v2/server.js";
import { OpenCodeV2AgentAdapter } from "../../../../../src/adapters/agents/opencode/v2/opencode-agent-adapter.js";
import { AgentSessionGateway } from "../../../../../src/services/agents/agent-session-gateway.js";

async function fixture(t, autoRespond = true, configure = _fixture => {}, profile = {}) {
  const f = await createOpenCodeV2Fixture({ autoRespond });
  configure(f);
  const events = [];
  const adapter = new OpenCodeV2AgentAdapter({ id: "v2", provider: "opencode", label: "OpenCode 2", command: "fixture", ...profile }, {
    serverFactory: () => ({ start: async () => f.client, close: async () => {}, version: "2.2.7" }) as never,
    onEvent: event => events.push(event),
  });
  t.after(async () => { await adapter.close(); await f.close(); });
  await adapter.start({ cwd: process.cwd(), developerInstructions: "Topolumia research guidance", researchMcp: { name: "topolumia", command: "node", args: ["mcp.js"], cwd: process.cwd(), env: { TOPOLUMIA_SESSION: "private-test-token" } } });
  return { ...f, adapter, events };
}

async function until(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for fixture input"); await delay(5); }
}

test("V2 undo and redo traverse the native revert cursor one user turn at a time", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) await f.adapter.prompt({ turnId: `turn-${i}`, content: [{ type: "text", text: `Task ${i}` }] });
  const native = f.sessions.get(f.adapter.nativeSessionId);
  const users = native.messages.filter(message => message.type === "user");
  for (const index of [2, 1, 0]) {
    await f.adapter.executeCommand({ name: "undo" });
    assert.equal(native.info.revert.messageID, users[index].id);
  }
  await assert.rejects(f.adapter.executeCommand({ name: "undo" }), { code: "AGENT_COMMAND_INVALID" });
  for (const index of [1, 2]) {
    await f.adapter.executeCommand({ name: "redo" });
    assert.equal(native.info.revert.messageID, users[index].id);
  }
  await f.adapter.executeCommand({ name: "redo" }); assert.equal(native.info.revert, undefined);
  await assert.rejects(f.adapter.executeCommand({ name: "redo" }), { code: "AGENT_COMMAND_INVALID" });
  const stages = f.calls.filter(call => call.path.endsWith("/revert/stage"));
  assert.deepEqual(stages.map(call => call.body.messageID), [users[2].id, users[1].id, users[0].id, users[1].id, users[2].id]);
  assert.ok(stages.every(call => call.body.files === true));
  assert.equal(native.messages.filter(message => message.type === "user").length, 3);
});

test("V2 does not revert files when the native cursor cannot be found in history", async t => {
  const f = await fixture(t);
  f.sessions.get(f.adapter.nativeSessionId).info.revert = { messageID: "missing-message" };
  for (const name of ["undo", "redo"]) await assert.rejects(f.adapter.executeCommand({ name }), { code: "AGENT_COMMAND_INVALID", status: 409 });
  assert.ok(!f.calls.some(call => call.path.includes("/revert")));
});

test("V2 project commands apply the selected model and effort before native admission", { timeout: 10_000 }, async t => {
  const f = await fixture(t, true, native => {
    const list = native.client.model.list.bind(native.client.model);
    native.client.model.list = async input => { const result = await list(input); return { ...result, data: [...result.data, { ...native.model, id: "alternate", name: "Alternate" }] }; };
  }, { reasoningEffort: "low" });
  await f.adapter.listCommands();
  await f.adapter.executeCommand({ name: "check", arguments: "Check project", id: "selected-model", model: "fixture/alternate", reasoningEffort: "high" });
  const model = f.calls.find(call => call.path.endsWith("/model") && call.method === "POST");
  const command = f.calls.find(call => call.path.endsWith("/command") && call.method === "POST");
  assert.deepEqual(model.body.model, { providerID: "fixture", id: "alternate", variant: "high" });
  assert.ok(f.calls.indexOf(model) < f.calls.indexOf(command));
  assert.deepEqual(f.sessions.get(f.adapter.nativeSessionId).model, model.body.model);
});

test("V2 command model validation rejects invalid settings without admitting work", async t => {
  const f = await fixture(t); await f.adapter.listCommands();
  await assert.rejects(f.adapter.executeCommand({ name: "check", model: "missing" }), { code: "OPENCODE_MODEL_UNAVAILABLE" });
  await assert.rejects(f.adapter.executeCommand({ name: "check", reasoningEffort: "ultra" }), { code: "OPENCODE_VARIANT_UNAVAILABLE" });
  assert.ok(!f.calls.some(call => call.method === "POST" && ["/model", "/command", "/compact"].some(suffix => call.path.endsWith(suffix))));
  assert.equal(f.adapter.closed, false);
  assert.equal((await f.adapter.executeCommand({ name: "check", arguments: "Valid retry" })).stopReason, "end_turn");
});

test("V2 fork switches native identity and event delivery together", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await f.adapter.prompt({ turnId: "before-fork", content: [{ type: "text", text: "Original task" }] });
  const original = f.adapter.nativeSessionId;
  const fork = await f.adapter.executeCommand({ name: "fork" });
  assert.notEqual(fork.nativeSessionId, original);
  assert.equal(f.adapter.nativeSessionId, fork.nativeSessionId);
  assert.equal(f.sessions.get(fork.nativeSessionId).info.parentID, original);
  await f.adapter.prompt({ turnId: "after-fork", content: [{ type: "text", text: "Continue" }] });
  const replies = f.events.filter(event => event.type === "assistant.message.completed" && event.turnId === "after-fork");
  assert.equal(replies.length, 2); assert.ok(replies.every(event => event.payload.nativeSessionId === fork.nativeSessionId));
});

test("V2 fork history failure retains the gateway identity and requires a recoverable runtime restart", { timeout: 10_000 }, async t => {
  const f = await createOpenCodeV2Fixture({ autoRespond: true });
  const adapters = [];
  const gateway = new AgentSessionGateway({ profileRegistry: { descriptors: async () => [], createAdapter: async (_profile, options) => {
    const adapter = new OpenCodeV2AgentAdapter({ id: "v2", provider: "opencode", driver: "opencode-server-v2", label: "V2", command: "fixture" }, {
      ...options, serverFactory: () => ({ start: async () => f.client, close: async () => {}, version: "2.2.7" }) as never,
    });
    adapters.push(adapter); return adapter;
  } } });
  t.after(async () => { await gateway.closeAll(); await f.close(); });
  const session = await gateway.create({ profileId: "v2", cwd: process.cwd() });
  f.failForkHistory(500);
  const command = gateway.executeCommand(session.id, { name: "fork", id: "failed-fork" });
  await until(() => gateway.snapshot(session.id).turns.find(turn => turn.id === command.id)?.completedAt);
  const failed = gateway.snapshot(session.id);
  assert.equal(failed.status, "failed"); assert.equal(failed.nativeSessionId, session.nativeSessionId);
  assert.equal(adapters[0].nativeSessionId, session.nativeSessionId); assert.equal(adapters[0].closed, true);
  assert.throws(() => gateway.startTurn(session.id, { text: "Must resume" }), { code: "AGENT_SESSION_NOT_READY" });
  const resumed = await gateway.resume(session.id, { cwd: process.cwd() });
  assert.equal(resumed.nativeSessionId, session.nativeSessionId);
  gateway.startTurn(session.id, { text: "Recovered task" });
  await until(() => gateway.snapshot(session.id).status === "ready");
  assert.match(gateway.snapshot(session.id).turns.at(-1).assistantText, /OpenCode 2 verified/);
});

test("V2 fork stream failure does not publish a partially prepared native identity", { timeout: 10_000 }, async t => {
  const f = await fixture(t); const original = f.adapter.nativeSessionId;
  f.client.event.subscribe = async function* () { throw new Error("Fork event stream unavailable"); };
  await assert.rejects(f.adapter.executeCommand({ name: "fork" }), /Fork event stream unavailable/);
  assert.equal(f.adapter.closed, true); assert.equal(f.adapter.nativeSessionId, original);
  await until(() => f.streams.size === 0);
});

test("V2 closing during fork preparation prevents a late session switch", { timeout: 10_000 }, async t => {
  const f = await fixture(t); const original = f.adapter.nativeSessionId;
  let release;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fork = f.client.session.fork.bind(f.client.session);
  f.client.session.fork = async input => { const created = await fork(input); await gate; return created; };
  t.after(() => release());
  const pending = f.adapter.executeCommand({ name: "fork" });
  await until(() => f.calls.some(call => call.path.endsWith("/fork")));
  await f.adapter.close(); release();
  await assert.rejects(pending, { code: "OPENCODE_V2_CLOSED" });
  assert.equal(f.adapter.nativeSessionId, original);
  assert.equal(f.calls.filter(call => call.path === "/api/event").length, 1);
});

test("V2 compaction admission and summary completion do not finish the command before execution is idle", { timeout: 10_000 }, async t => {
  const f = await fixture(t, false);
  let completed = false;
  const pending = f.adapter.executeCommand({ name: "compact", id: "compact" }).finally(() => { completed = true; });
  await until(() => f.calls.some(call => call.path.endsWith("/compact")));
  await delay(20);
  assert.equal(completed, false);
  const sessionID = f.adapter.nativeSessionId;
  const linked = f.events.find(event => event.type === "turn.native-linked" && event.turnId === "compact");
  assert.equal(linked.payload.nativeMessageId, f.calls.find(call => call.path.endsWith("/compact")).body.id);
  await assert.rejects(f.adapter.prompt({ turnId: "overlap", content: [] }), { code: "AGENT_TURN_ACTIVE" });
  f.finishCompaction(sessionID); await delay(20);
  assert.equal(completed, false);
  f.endExecution(sessionID);
  assert.equal((await pending).stopReason, "end_turn");
});

test("V2 compaction reports asynchronous failure instead of an admission success", { timeout: 10_000 }, async t => {
  const f = await fixture(t, false);
  const pending = f.adapter.executeCommand({ name: "compact", id: "compact-failure" });
  await until(() => f.calls.some(call => call.path.endsWith("/compact")));
  f.finishCompaction(f.adapter.nativeSessionId, "Compaction failed"); f.endExecution(f.adapter.nativeSessionId);
  await assert.rejects(pending, /Compaction failed/);
});

test("V2 compaction completion before the admission response is recovered from native history", { timeout: 10_000 }, async t => {
  const f = await fixture(t, false); f.deferPrompt();
  const pending = f.adapter.executeCommand({ name: "compact", id: "compact-early" });
  await until(() => f.calls.some(call => call.path.endsWith("/compact")));
  f.finishCompaction(f.adapter.nativeSessionId); f.endExecution(f.adapter.nativeSessionId);
  f.releasePrompt();
  assert.equal((await pending).stopReason, "end_turn");
});

test("V2 compaction cancellation removes its input before interrupting execution", { timeout: 10_000 }, async t => {
  const f = await fixture(t, false);
  const pending = f.adapter.executeCommand({ name: "compact", id: "compact-cancel" });
  await until(() => f.calls.some(call => call.path.endsWith("/compact"))); await delay(20);
  f.adapter.cancel(); assert.equal((await pending).stopReason, "cancelled");
  const inputID = f.calls.find(call => call.path.endsWith("/compact")).body.id;
  const cancelled = f.calls.findIndex(call => call.method === "DELETE" && call.path.endsWith(`/inbox/${inputID}`));
  assert.ok(cancelled >= 0 && cancelled < f.calls.findIndex(call => call.path.endsWith("/interrupt")));
});

test("V2 project commands bind native replies to their own local turn", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await f.adapter.prompt({ turnId: "previous", content: [{ type: "text", text: "Earlier task" }] });
  await f.adapter.listCommands();
  await f.adapter.executeCommand({ name: "check", arguments: "Check project", id: "project-command" });
  const command = f.calls.find(call => call.path.endsWith("/command") && call.method === "POST");
  assert.deepEqual(command.body, { name: "check", text: "Check project", delivery: "queue" });
  assert.equal(f.events.filter(event => event.type === "assistant.message.completed" && event.turnId === "project-command").length, 2);
  assert.equal(f.events.filter(event => event.type === "assistant.message.completed" && event.turnId === "previous").length, 2);
});

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
