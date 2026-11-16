import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as tick } from "node:timers/promises";
import { AgentSessionGateway } from "../../../src/services/agents/agent-session-gateway.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function fixture() {
  const calls: unknown[] = [];
  const gateway = new AgentSessionGateway({
    profileRegistry: {
      descriptors: async () => [],
      createAdapter: async () => ({
        profile: { provider: "fixture" },
        start: async () => ({ nativeSessionId: "native", capabilities: {}, commands: [{ name: "compact", label: "/compact", description: "Compact", source: "builtin", execution: "native", risk: "session" }] }),
        prompt: async () => ({ stopReason: "end_turn" }),
        executeCommand: async input => { calls.push(input); return { stopReason: "end_turn", nativeSessionId: "native" }; },
        listCommands: async () => [],
        cancel: () => {}, close: async () => {}, resolvePermission: async () => {},
      }),
    },
  });
  return { gateway, calls };
}

test("commands use the adapter contract, publish command events, and reject unknown commands", async t => {
  const f = fixture();
  t.after(() => f.gateway.closeAll());
  const session = await f.gateway.create({ profileId: "fixture" });
  assert.deepEqual(f.gateway.listCommands(session.id).map(command => command.name), ["compact"]);
  const result = f.gateway.executeCommand(session.id, { name: "/compact", arguments: "focus", id: "command-client-1" });
  assert.equal(result.status, "running");
  await tick(0);
  assert.deepEqual(f.calls, [{ name: "compact", arguments: "focus", id: result.id }]);
  const events = f.gateway.snapshot(session.id).events.filter(event => event.type.startsWith("command."));
  assert.deepEqual(events.map(event => event.type), ["command.started", "command.completed"]);
  assert.equal(f.gateway.snapshot(session.id).status, "ready");
  assert.throws(() => f.gateway.executeCommand(session.id, { name: "/unknown" }), { code: "AGENT_COMMAND_UNSUPPORTED" });
});

test("commands queued behind a turn preserve FIFO order", async t => {
  let finish!: (value: { stopReason: string }) => void;
  const calls: string[] = [];
  const gateway = new AgentSessionGateway({
    profileRegistry: {
      descriptors: async () => [],
      createAdapter: async () => ({
        profile: { provider: "fixture" },
        start: async () => ({ nativeSessionId: "native", capabilities: {}, commands: [{ name: "compact", label: "/compact", description: "Compact", source: "builtin", execution: "native", risk: "session" }] }),
        prompt: async () => new Promise(resolve => { finish = resolve; }),
        executeCommand: async input => { calls.push(input.name); return { stopReason: "end_turn" }; },
        cancel: () => {}, close: async () => {}, resolvePermission: async () => {},
      }),
    },
  });
  t.after(() => gateway.closeAll());
  const session = await gateway.create({ profileId: "fixture" });
  gateway.startTurn(session.id, { text: "running" });
  await tick(0);
  const queued = gateway.executeCommand(session.id, { name: "compact", id: "queued-command-1" });
  assert.equal(queued.status, "queued");
  finish({ stopReason: "end_turn" });
  await tick(0);
  assert.deepEqual(calls, ["compact"]);
});

function controlled(options = {}, finishOnClose = true) {
  const calls = [];
  const permissions = [];
  let emit;
  const commands = ["compact", "rename"].map(name => ({ name, label: `/${name}`, description: name, source: "builtin", execution: "native", risk: "session" }));
  const gateway = new AgentSessionGateway({ ...options, profileRegistry: {
    descriptors: async () => [],
    createAdapter: async (_id, driverOptions) => {
      emit = driverOptions.onEvent;
      const adapter = { profile: { provider: "fixture" }, closed: false,
        start: async () => ({ nativeSessionId: "native", capabilities: { session: { resume: true } }, commands }),
        prompt: input => new Promise((resolve, reject) => calls.push({ kind: "message", input, resolve, reject })),
        executeCommand: input => new Promise((resolve, reject) => calls.push({ kind: "command", input, resolve, reject })),
        cancel: () => calls.at(-1)?.resolve({ stopReason: "cancelled" }),
        close: async () => { adapter.closed = true; if (finishOnClose) calls.at(-1)?.resolve({ stopReason: "cancelled" }); },
        resolvePermission: async (...input) => { permissions.push(input); },
      };
      return adapter;
    },
  } });
  return { gateway, calls, permissions, emit: event => emit(event) };
}

test("active and completed commands deduplicate by durable submission identity and reject conflicting reuse", async t => {
  const f = controlled({ maxEventsPerSession: 2 }); t.after(() => f.gateway.closeAll());
  const session = await f.gateway.create({ profileId: "fixture" });
  const input = { name: "compact", arguments: "focus", id: "same-command-123" };
  const first = f.gateway.executeCommand(session.id, input); await tick(0);
  assert.equal(f.gateway.executeCommand(session.id, input).id, first.id);
  assert.equal(f.gateway.executeCommand(session.id, input).duplicate, true);
  assert.throws(() => f.gateway.executeCommand(session.id, { ...input, arguments: "different" }), { code: "AGENT_MESSAGE_ID_CONFLICT" });
  assert.throws(() => f.gateway.startTurn(session.id, { text: "normal", clientMessageId: input.id }), { code: "AGENT_MESSAGE_ID_CONFLICT" });
  assert.equal(f.calls.length, 1); assert.equal(f.gateway.snapshot(session.id).queuedMessages.length, 0);
  f.calls[0].resolve({ stopReason: "end_turn" }); await tick(0);
  for (let i = 0; i < 4; i++) f.emit({ type: "usage.updated", payload: { value: i, nativeItemId: String(i) } });
  assert.ok(!f.gateway.snapshot(session.id).events.some(event => event.type === "command.completed"));
  assert.equal(f.gateway.executeCommand(session.id, input).duplicate, true);
  assert.equal(f.calls.length, 1);
});

test("command approvals retain permission checks and native output belongs to the command turn", async t => {
  const f = controlled(); t.after(() => f.gateway.closeAll());
  const session = await f.gateway.create({ profileId: "fixture" });
  const turn = f.gateway.executeCommand(session.id, { name: "compact", id: "command-approval-1" }); await tick(0);
  f.emit({ type: "approval.requested", turnId: turn.id, payload: { requestId: "approval", options: [{ optionId: "once", kind: "allow_once", scope: "once" }] } });
  assert.equal(f.gateway.snapshot(session.id).status, "awaiting_permission");
  assert.equal(f.permissions.length, 0);
  await assert.rejects(f.gateway.resolveApproval(session.id, "approval", { decision: "allow" }, { permissions: [] }), { code: "FORBIDDEN" });
  await f.gateway.resolveApproval(session.id, "approval", { decision: "allow" }, { permissions: ["*"] });
  f.emit({ type: "assistant.message.completed", turnId: turn.id, payload: { messageId: "answer", text: "Skill result" } });
  f.calls[0].resolve({ stopReason: "end_turn", nativeTurnId: "native-command" }); await tick(0);
  const done = f.gateway.snapshot(session.id);
  assert.equal(done.turns[0].assistantText, "Skill result");
  assert.equal(done.turns[0].nativeTurnId, "native-command");
  assert.equal(done.turns[0].status, "completed");
  assert.equal(done.pendingApprovals.length, 0);
  assert.equal(done.conversationEvents.find(event => event.type === "user.message").payload.text, "/compact");
});

test("edited queued commands execute their validated text and preserve the original retry identity", async t => {
  const f = controlled(); t.after(() => f.gateway.closeAll());
  const session = await f.gateway.create({ profileId: "fixture" });
  f.gateway.startTurn(session.id, { text: "Hold" }); await tick(0);
  const input = { name: "compact", arguments: "old", id: "edited-command-123" };
  const queued = f.gateway.executeCommand(session.id, input);
  f.gateway.editQueuedMessage(session.id, queued.id, { text: "/rename new title" });
  assert.throws(() => f.gateway.editQueuedMessage(session.id, queued.id, { text: "/unknown" }), { code: "AGENT_COMMAND_UNSUPPORTED" });
  assert.equal(f.gateway.executeCommand(session.id, input).duplicate, true);
  f.calls[0].resolve({ stopReason: "end_turn" }); await tick(0);
  assert.deepEqual(f.calls[1].input, { name: "rename", arguments: "new title", id: f.gateway.snapshot(session.id).activeTurnId });
  f.calls[1].resolve({ stopReason: "end_turn" }); await tick(0);
});

test("editing across command and message kinds dispatches only the displayed input", async t => {
  const f = controlled(); t.after(() => f.gateway.closeAll());
  const session = await f.gateway.create({ profileId: "fixture" });
  f.gateway.startTurn(session.id, { text: "Hold" }); await tick(0);
  const command = f.gateway.executeCommand(session.id, { name: "compact" });
  const message = f.gateway.startTurn(session.id, { text: "Prompt" });
  f.gateway.editQueuedMessage(session.id, command.id, { text: "Ordinary message" });
  f.gateway.editQueuedMessage(session.id, message.id, { text: "/compact edited" });
  f.calls[0].resolve({ stopReason: "end_turn" }); await tick(0);
  assert.equal(f.calls[1].kind, "message"); assert.equal(f.calls[1].input.content[0].text, "Ordinary message");
  f.calls[1].resolve({ stopReason: "end_turn" }); await tick(0);
  assert.equal(f.calls[2].kind, "command"); assert.equal(f.calls[2].input.arguments, "edited");
});

test("command cancellation pauses the queue and late completion cannot overwrite a replacement runtime", async t => {
  const f = controlled({}, false); t.after(() => f.gateway.closeAll());
  const session = await f.gateway.create({ profileId: "fixture" });
  f.gateway.executeCommand(session.id, { name: "compact" }); await tick(0);
  const late = f.calls[0];
  await f.gateway.close(session.id);
  await f.gateway.resume(session.id);
  const running = f.gateway.executeCommand(session.id, { name: "compact" }); await tick(0);
  late.reject(new Error("Late old runtime failure")); await tick(0);
  assert.equal(f.gateway.snapshot(session.id).activeTurnId, running.id);
  f.gateway.startTurn(session.id, { text: "Keep queued" });
  f.gateway.cancel(session.id); await tick(0);
  const cancelled = f.gateway.snapshot(session.id);
  assert.equal(cancelled.turns.at(-1).status, "cancelled");
  assert.equal(cancelled.queuePaused, true); assert.equal(cancelled.queuedMessages.length, 1);
  assert.equal(cancelled.conversationEvents.filter(event => event.type === "command.failed").length, 0);
});

test("commands survive history rollover and restart without re-executing acknowledged requests", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-command-history-"));
  const historyFile = path.join(root, "history.sqlite");
  const f = controlled({ historyFile, maxEventsPerSession: 1 });
  let restored;
  t.after(async () => { await f.gateway.closeAll(); await restored?.gateway.closeAll(); await rm(root, { recursive: true, force: true }); });
  const session = await f.gateway.create({ profileId: "fixture" });
  const input = { name: "compact", id: "persist-command-123" };
  f.gateway.executeCommand(session.id, input); await tick(0);
  await f.gateway.persist(session.id);
  restored = controlled({ historyFile, maxEventsPerSession: 1 }); await restored.gateway.initialize();
  const interrupted = restored.gateway.snapshot(session.id);
  assert.equal(interrupted.turns[0].status, "failed");
  assert.equal(interrupted.turns[0].stopReason, "server_restart");
  assert.ok(interrupted.conversationEvents.some(event => event.type === "command.failed"));
  assert.equal(restored.gateway.executeCommand(session.id, input).duplicate, true);
  assert.equal(restored.calls.length, 0);
});

test("the ordinary turn endpoint cannot bypass command validation", async t => {
  const f = controlled(); t.after(() => f.gateway.closeAll());
  const session = await f.gateway.create({ profileId: "fixture" });
  assert.throws(() => f.gateway.startTurn(session.id, { text: "/unknown" }), { code: "AGENT_COMMAND_UNSUPPORTED" });
  const turn = f.gateway.startTurn(session.id, { text: "/compact focus", clientMessageId: "ordinary-command-route" }); await tick(0);
  assert.equal(turn.kind, "command"); assert.equal(f.calls[0].kind, "command");
});
