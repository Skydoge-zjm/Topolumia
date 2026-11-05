import { AgentHistoryStore } from "../../../src/services/agents/agent-history-store.js";
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { AgentSessionGateway } from "../../../src/services/agents/agent-session-gateway.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function fixture(t, overrides = {}, gatewayOptions = {}) {
  let emit;
  let finish;
  let fail;
  let starts = [];
  const adapter = { profile: { provider: "fixture" }, closed: false,
    start: async (input) => { starts.push(input); return { nativeSessionId: "native", capabilities: {} }; },
    prompt: () => new Promise((resolve, reject) => { finish = resolve; fail = reject; }),
    cancel: () => {}, close: async () => {}, resolvePermission: async () => {}, ...overrides };
  const gateway = new AgentSessionGateway({ ...gatewayOptions, profileRegistry: { createAdapter: async (_profile, options) => { emit = options.onEvent; return adapter; } } });
  t.after(() => gateway.closeAll());
  const session = await gateway.create({ profileId: "fixture" });
  const turn = gateway.startTurn(session.id, { text: "Check" });
  await delay(0);
  const approval = () => emit({ type: "approval.requested", turnId: turn.id, payload: { requestId: "permission", options: [
    { optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] } });
  return { gateway, session, turn, adapter, starts, approval, emit: (event) => emit(event), finish: (result) => finish(result), fail: (error) => fail(error) };
}

test("approval completion cannot revive an already completed turn", async t => {
  const f = await fixture(t);
  f.approval();
  f.adapter.resolvePermission = async () => { f.finish({ stopReason: "end_turn" }); await delay(0); };
  await f.gateway.resolveApproval(f.session.id, "permission", { decision: "allow" }, { permissions: ["*"] });
  assert.equal(f.gateway.snapshot(f.session.id).status, "ready");
  assert.equal(f.gateway.snapshot(f.session.id).turns[0].status, "completed");
});

test("invalid or contradictory approval decisions never reach the native driver", async t => {
  const f = await fixture(t);
  f.approval();
  await assert.rejects(f.gateway.resolveApproval(f.session.id, "permission", {}, { permissions: ["*"] }), { code: "AGENT_APPROVAL_DECISION_INVALID" });
  await assert.rejects(f.gateway.resolveApproval(f.session.id, "permission", { decision: "reject", optionId: "yes" }, { permissions: ["*"] }), { code: "AGENT_APPROVAL_OPTION_INVALID" });
});

test("gateway never silently selects a session or persistent grant", async t => {
  const f = await fixture(t);
  const called = []; f.adapter.resolvePermission = async (...args) => called.push(args);
  f.emit({ type: "approval.requested", turnId: f.turn.id, payload: { requestId: "broad", options: [
    { optionId: "session", kind: "allow_session", scope: "session" }, { optionId: "rules", kind: "allow_always", scope: "persistent" }] } });
  await assert.rejects(f.gateway.resolveApproval(f.session.id, "broad", { decision: "allow" }, { permissions: ["*"] }), { code: "AGENT_APPROVAL_OPTION_INVALID" });
  assert.equal(called.length, 0);
  await f.gateway.resolveApproval(f.session.id, "broad", { decision: "allow", optionId: "session" }, { permissions: ["*"] });
  assert.equal(called[0][1], "session");
  assert.equal(f.gateway.snapshot(f.session.id).events.find(e => e.type === "approval.resolved").payload.selectedScope, "session");
});

test("native approval acknowledgements win HTTP races and leave other requests pending", async t => {
  const f = await fixture(t); f.approval();
  f.emit({ type: "approval.requested", turnId: f.turn.id, payload: { requestId: "other", options: [{ optionId: "once", kind: "allow_once" }] } });
  f.adapter.resolvePermission = async () => {
    f.emit({ type: "approval.resolved", turnId: f.turn.id, payload: { requestId: "permission", decision: "allow", optionId: "yes" } });
    throw new Error("HTTP response lost after native ACK");
  };
  await f.gateway.resolveApproval(f.session.id, "permission", { decision: "allow" }, { permissions: ["*"] });
  assert.equal(f.gateway.snapshot(f.session.id).status, "awaiting_permission");
  assert.equal(f.gateway.snapshot(f.session.id).pendingApprovals.length, 1);
  assert.equal(f.gateway.snapshot(f.session.id).conversationEvents.filter(e => e.type === "approval.resolved" && e.payload.requestId === "permission").length, 1);
  f.emit({ type: "approval.resolved", payload: { requestId: "other", decision: "external" } });
  assert.equal(f.gateway.snapshot(f.session.id).status, "running");
  await assert.rejects(f.gateway.resolveApproval(f.session.id, "other", { decision: "allow" }, { permissions: ["*"] }), { code: "AGENT_APPROVAL_NOT_FOUND" });
});

test("gateway permits only atomic subsets of the original Codex permission request", async t => {
  const f = await fixture(t); f.gateway.sessions.get(f.session.id).provider = "codex";
  let selection; f.adapter.resolvePermission = async (_id, _option, _cancel, value) => { selection = value; };
  const payload = { requestId: "subset", category: "permissions", permissions: { network: { enabled: true } }, options: [{ optionId: "turn", kind: "allow_once", scope: "turn" }] };
  f.emit({ type: "approval.requested", turnId: f.turn.id, payload });
  for (const permissionKeys of [[], ["fileSystem"], ["unknown"], "network", [{ network: "*" }]]) await assert.rejects(f.gateway.resolveApproval(f.session.id, "subset", { decision: "allow", permissionKeys }, { permissions: ["*"] }), { code: "AGENT_APPROVAL_PERMISSIONS_INVALID" });
  await f.gateway.resolveApproval(f.session.id, "subset", { decision: "allow", permissionKeys: ["network"] }, { permissions: ["*"] });
  assert.deepEqual(selection, { permissionKeys: ["network"] });
});

test("stopping through an approval pauses the FIFO before the native turn can finish", async t => {
  const f = await fixture(t);
  f.emit({ type: "approval.requested", turnId: f.turn.id, payload: { requestId: "stop", options: [{ optionId: "cancel", kind: "cancel", scope: "turn" }] } });
  f.gateway.startTurn(f.session.id, { text: "Queued work" });
  f.adapter.cancel = () => f.finish({ stopReason: "cancelled" });
  await f.gateway.resolveApproval(f.session.id, "stop", { decision: "cancel", optionId: "cancel" }, { permissions: ["*"] }); await delay(0);
  const s = f.gateway.snapshot(f.session.id);
  assert.equal(s.turns.length, 1); assert.equal(s.queuePaused, true); assert.equal(s.queuedMessages.length, 1);
  assert.equal(s.turns[0].status, "cancelled");
  assert.equal(s.events.find(e => e.type === "approval.resolved").payload.decision, "cancel");
});

test("double approval clicks are rejected while a transport failure remains retryable", async t => {
  const f = await fixture(t); f.approval(); let release;
  f.adapter.resolvePermission = () => new Promise((_resolve, reject) => { release = reject; });
  const first = f.gateway.resolveApproval(f.session.id, "permission", { decision: "allow" }, { permissions: ["*"] });
  await assert.rejects(f.gateway.resolveApproval(f.session.id, "permission", { decision: "allow" }, { permissions: ["*"] }), { code: "AGENT_APPROVAL_RESOLVING" });
  release(new Error("offline")); await assert.rejects(first, /offline/);
  f.adapter.resolvePermission = async () => {};
  await f.gateway.resolveApproval(f.session.id, "permission", { decision: "reject" }, { permissions: ["*"] });
  f.finish({}); await delay(0);
  f.approval(); assert.equal(f.gateway.snapshot(f.session.id).pendingApprovals.length, 0);
  assert.equal(f.gateway.snapshot(f.session.id).status, "ready");
});

test("failed turns clear pending approvals and report a reusable session", async t => {
  const f = await fixture(t);
  f.approval(); f.fail(new Error("provider unavailable")); await delay(0);
  const detail = f.gateway.snapshot(f.session.id);
  assert.equal(detail.status, "ready");
  assert.deepEqual(detail.pendingApprovals, []);
  assert.equal(detail.events.at(-1).payload.sessionStatus, "ready");
});

test("closing a session blocks new turns and keeps the completed turn terminal", async t => {
  const f = await fixture(t);
  f.adapter.cancel = () => { f.finish({ stopReason: "cancelled" }); };
  f.adapter.close = async () => { await delay(10); f.adapter.closed = true; };
  const closing = f.gateway.close(f.session.id);
  await delay(0);
  assert.throws(() => f.gateway.startTurn(f.session.id, { text: "Must not run" }), { code: "AGENT_SESSION_NOT_READY" });
  await closing;
  assert.equal(f.gateway.snapshot(f.session.id).status, "closed");
  assert.equal(f.gateway.snapshot(f.session.id).turns[0].status, "cancelled");
});

test("a final message snapshot repairs partial streamed text", async t => {
  const f = await fixture(t);
  f.emit({ type: "assistant.message.delta", turnId: f.turn.id, payload: { messageId: "message", delta: "Partial" } });
  f.emit({ type: "assistant.message.completed", turnId: f.turn.id, payload: { messageId: "message", text: "Partial and recovered suffix" } });
  assert.equal(f.gateway.snapshot(f.session.id).turns[0].assistantText, "Partial and recovered suffix");
});

test("subagent blocks preserve provenance without changing the parent turn answer", async t => {
  const f = await fixture(t);
  f.emit({ type: "assistant.message.completed", turnId: f.turn.id, payload: { blockId: "child", agentId: "agent-child", parentToolUseId: "call", text: "Child output" } });
  f.emit({ type: "assistant.message.completed", turnId: f.turn.id, payload: { blockId: "parent", text: "Parent output" } });
  const detail = f.gateway.snapshot(f.session.id);
  assert.equal(detail.turns[0].assistantText, "Parent output");
  assert.equal(detail.turns[0].assistantMessages.find(message => message.blockId === "child").agentId, "agent-child");
  assert.equal(detail.conversationEvents.filter(event => event.type === "assistant.message.completed").length, 2);
});

test("deleted blocks cannot return through stale snapshots, while native restores update turn text", async t => {
  const f = await fixture(t);
  const emit = (type, payload) => f.emit({ type, payload, turnId: f.turn.id });
  emit("assistant.message.completed", { blockId: "block", text: "Old" });
  emit("content.removed", { targetId: "block" });
  emit("assistant.message.completed", { blockId: "block", text: "Old" });
  assert.equal(f.gateway.snapshot(f.session.id).turns[0].assistantText, "");
  emit("assistant.message.completed", { blockId: "block", text: "Restored", restored: true });
  assert.equal(f.gateway.snapshot(f.session.id).turns[0].assistantText, "Restored");
  emit("tool.started", { toolCallId: "call", nativeItemId: "tool-part" });
  emit("content.removed", { targetId: "tool-part" });
  emit("tool.started", { toolCallId: "call", nativeItemId: "tool-part" });
  assert.equal(f.gateway.snapshot(f.session.id).events.filter(event => event.type === "tool.started").length, 1);
});

test("usage keeps its scope and cache counts after raw trace rollover and a backend restart", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-usage-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const historyFile = path.join(root, "history.json");
  const f = await fixture(t, {}, { historyFile, maxEventsPerSession: 5 });
  const usage = { scope: "session", tokenUsage: { total: { inputTokens: 130, outputTokens: 2, totalTokens: 132, cachedInputTokens: 100, cacheWriteInputTokens: 20 } } };
  f.emit({ type: "usage.updated", turnId: f.turn.id, payload: usage });
  for (let i = 0; i < 20; i++) f.emit({ type: "assistant.message.completed", turnId: f.turn.id, payload: { messageId: `step-${i}`, text: `Step ${i}` } });
  f.finish({ stopReason: "end_turn" }); await delay(0);
  assert.ok(!f.gateway.snapshot(f.session.id).events.some(event => event.type === "usage.updated"));
  assert.deepEqual(f.gateway.snapshot(f.session.id).usage, usage);
  await f.gateway.closeAll();
  const restored = new AgentSessionGateway({ historyFile }); await restored.initialize();
  assert.deepEqual(restored.snapshot(f.session.id).usage, usage);
  await restored.closeAll();
});

test("trace rollover never evicts the conversation during streaming, persistence, restart or sync", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-long-conversation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const historyFile = path.join(root, "history.json");
  const f = await fixture(t, {}, { historyFile, maxEventsPerSession: 12 });
  const cursors = [];
  const unsubscribe = f.gateway.subscribe(f.session.id, e => cursors.push(e.cursor));
  f.emit({ type: "assistant.message.completed", turnId: f.turn.id, payload: { messageId: "early", text: "Earlier reply" } });
  f.emit({ type: "tool.started", turnId: f.turn.id, payload: { toolCallId: "read", title: "Read" } });
  f.emit({ type: "tool.completed", turnId: f.turn.id, payload: { toolCallId: "read", rawOutput: "Verified evidence" } });
  for (let i = 0; i < 1_500; i++) f.emit({ type: "assistant.message.delta", turnId: f.turn.id, payload: { messageId: "final", delta: "文" } });
  const streaming = f.gateway.snapshot(f.session.id);
  assert.ok(streaming.events.length <= 5);
  assert.equal(streaming.eventRetention.droppedEvents, 0);
  assert.ok(!streaming.events.some(event => event.type.endsWith(".delta") || event.type === "tool.updated"));
  assert.equal(streaming.conversationEvents.find(e => e.type === "user.message").payload.text, "Check");
  assert.equal(streaming.conversationEvents.find(e => e.type === "assistant.message.delta").payload.delta, "文".repeat(1_500));
  const replay = [];
  const stopReplay = f.gateway.subscribe(f.session.id, event => replay.push(event), 5);
  assert.equal(replay.find(event => event.type === "assistant.message.snapshot")?.payload.text, "文".repeat(1_500));
  stopReplay();
  f.finish({ stopReason: "end_turn" }); await delay(0);
  unsubscribe();
  assert.ok(cursors.every((cursor, i) => i === 0 || cursor === cursors[i - 1] + 1));
  await f.gateway.closeAll();
  const savedStore = new AgentHistoryStore(historyFile); await savedStore.load();
  const saved = savedStore.get(f.session.id); savedStore.close();
  assert.ok(saved.events.every(event => !event.type.endsWith(".delta") && event.type !== "tool.updated" && event.type !== "native.trace"));
  assert.ok(saved.conversationEvents.every(event => event.type !== "tool.updated"));
  const restored = new AgentSessionGateway({ historyFile, maxEventsPerSession: 5 });
  await restored.initialize();
  const detail = restored.snapshot(f.session.id);
  assert.ok(detail.events.length <= 5);
  assert.deepEqual(detail.conversationEvents.filter(e => e.type === "assistant.message.completed").map(e => e.payload.text), ["Earlier reply", "文".repeat(1_500)]);
  assert.equal(detail.conversationEvents.filter(e => e.type === "tool.started").length, 1);
  assert.equal(detail.conversationEvents.filter(e => e.type === "tool.completed").length, 1);
  const synced = await restored.sync(f.session.id);
  assert.deepEqual(synced.session.conversationEvents, detail.conversationEvents);
  await restored.closeAll();
});

test("runtime credentials are redacted from tool traces and public session snapshots", async t => {
  const f = await fixture(t);
  const credential = "rw_agent_fixture_private_credential";
  f.emit({ type: "tool.completed", turnId: f.turn.id, payload: { item: { output: credential, environment: { TOPOLUMIA_SESSION: credential } } } });
  assert.ok(!JSON.stringify(f.gateway.snapshot(f.session.id)).includes(credential));
});

test("an error stop reason is a failed turn rather than successful completion", async t => {
  const f = await fixture(t);
  f.finish({ stopReason: "error" }); await delay(0);
  assert.equal(f.gateway.snapshot(f.session.id).turns[0].status, "failed");
});

test("concurrent continuation preserves MCP guidance and research identity with one replacement runtime", async t => {
  const f = await fixture(t);
  f.finish({ stopReason: "end_turn" }); await delay(0);
  await f.gateway.close(f.session.id);
  const [first, second] = await Promise.all([1, 2].map(() => f.gateway.resume(f.session.id, { developerInstructions: "Topolumia MCP" })));
  assert.equal(first.id, second.id);
  assert.equal(first.id, f.session.id);
  assert.equal(f.gateway.list().length, 1);
  assert.equal(first.turns.length, 1);
  assert.ok(first.conversationEvents.some(event => event.type === "user.message" && event.payload.text === "Check"));
  assert.equal(f.starts.length, 2);
  assert.equal(f.starts[1].developerInstructions, "Topolumia MCP");
  assert.equal(first.researchSessionId, f.session.researchSessionId);
  assert.notEqual(first.runtimeInstanceId, f.session.runtimeInstanceId);
  await f.gateway.close(first.id);
  assert.equal(f.gateway.snapshot(first.id).status, "closed");
});

test("resetting reasoning to default clears the previous explicit effort", async t => {
  const f = await fixture(t);
  f.finish({ stopReason: "end_turn" }); await delay(0);
  f.gateway.startTurn(f.session.id, { text: "First", reasoningEffort: "high" }); await delay(0);
  f.finish({ stopReason: "end_turn" }); await delay(0);
  const turn = f.gateway.startTurn(f.session.id, { text: "Default", reasoningEffort: "" });
  assert.equal(turn.reasoningEffort, null);
});

test("native Codex history repair maps local turns and does not duplicate the user message", async t => {
  const f = await fixture(t, { readSnapshot: async () => ({ turns: [{ id: "native-turn", items: [
    { type: "userMessage", id: "native-user", content: [{ text: "Check" }] },
    { type: "agentMessage", id: "native-answer", text: "Recovered answer" },
  ] }] }) });
  f.emit({ type: "turn.native-linked", turnId: f.turn.id, payload: { nativeTurnId: "native-turn" } });
  const internal = f.gateway.sessions.get(f.session.id);
  internal.capabilities = { session: { sync: true } };
  await f.gateway.sync(f.session.id);
  await f.gateway.sync(f.session.id);
  const detail = f.gateway.snapshot(f.session.id);
  assert.equal(detail.events.filter(event => event.type === "user.message").length, 1);
  assert.equal(detail.events.filter(event => event.type === "assistant.message.completed").length, 1);
  assert.equal(detail.turns[0].assistantText, "Recovered answer");
});

test("native reasoning snapshots repair paragraphs in the local turn and remain idempotent on sync", async t => {
  const f = await fixture(t, { readSnapshot: async () => ({ turns: [{ id: "native-turn", items: [
    { type: "reasoning", id: "native-reasoning", summary: ["First paragraph", "Second paragraph"] },
    { type: "reasoning", id: "empty-reasoning", summary: [] },
  ] }] }) });
  f.emit({ type: "turn.native-linked", turnId: f.turn.id, payload: { nativeTurnId: "native-turn" } });
  f.emit({ type: "reasoning.summary.delta", turnId: f.turn.id, payload: { messageId: "native-reasoning", nativeItemId: "native-reasoning", channel: "summary", summaryIndex: 0, delta: "First" } });
  f.gateway.sessions.get(f.session.id).capabilities = { session: { sync: true } };
  await f.gateway.sync(f.session.id);
  await f.gateway.sync(f.session.id);
  const detail = f.gateway.snapshot(f.session.id);
  const reasoning = detail.conversationEvents.filter(e => e.type.startsWith("reasoning."));
  assert.deepEqual(reasoning.map(e => e.payload.text), ["First paragraph", "Second paragraph"]);
  assert.ok(reasoning.every(e => e.turnId === f.turn.id));
  assert.equal(detail.events.filter(e => e.type === "reasoning.summary.completed").length, 2);
});

test("a slow native snapshot cannot overwrite newer streamed content", async t => {
  let release;
  const f = await fixture(t, { readSnapshot: () => new Promise(resolve => { release = resolve; }) });
  f.emit({ type: "turn.native-linked", turnId: f.turn.id, payload: { nativeTurnId: "native-turn" } });
  f.emit({ type: "assistant.message.delta", turnId: f.turn.id, payload: { messageId: "message", nativeItemId: "message", delta: "Old" } });
  f.gateway.sessions.get(f.session.id).capabilities = { session: { sync: true } };
  const syncing = f.gateway.sync(f.session.id);
  f.emit({ type: "assistant.message.completed", turnId: f.turn.id, payload: { messageId: "message", nativeItemId: "message", text: "New authoritative live answer" } });
  release({ turns: [{ id: "native-turn", status: "completed", items: [{ id: "message", type: "agentMessage", text: "Old" }] }] });
  await syncing;
  assert.equal(f.gateway.snapshot(f.session.id).turns[0].assistantText, "New authoritative live answer");
});

test("native history replay never counts a completed tool as a second tool invocation", async t => {
  const final = { toolCallId: "call", nativeItemId: "part", nativeMessageId: "message", status: "completed", item: { id: "call", status: "completed", output: "Verified" } };
  const f = await fixture(t, { readSnapshot: async () => ({ format: "agent-native-events.v1", events: [
    { type: "tool.started", payload: { ...final, status: "running", nativeParentId: "user" } },
    { type: "tool.completed", payload: { ...final, nativeParentId: "user" } },
  ] }) });
  const observed = []; f.gateway.onResearchEvent = event => observed.push(event);
  f.emit({ type: "turn.native-linked", turnId: f.turn.id, payload: { nativeMessageId: "user" } });
  f.emit({ type: "tool.started", turnId: f.turn.id, payload: { ...final, item: { id: "call", status: "running" }, status: "running" } });
  f.emit({ type: "tool.completed", turnId: f.turn.id, payload: final });
  f.gateway.sessions.get(f.session.id).capabilities = { session: { sync: true } };
  await f.gateway.sync(f.session.id);
  const detail = f.gateway.snapshot(f.session.id);
  assert.equal(detail.conversationEvents.filter(event => event.type === "tool.started").length, 1);
  assert.equal(detail.events.filter(event => event.type === "tool.completed").length, 1);
  assert.equal(observed.filter(event => event.type === "toolCall").length, 1);
});
