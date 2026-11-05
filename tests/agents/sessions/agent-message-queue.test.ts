import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as tick } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentSessionGateway } from "../../../src/services/agents/agent-session-gateway.js";

function controlled(historyFile = null) {
  const calls = [];
  let emit;
  const gateway = new AgentSessionGateway({ historyFile, profileRegistry: { createAdapter: async (_id, options) => {
    emit = options.onEvent;
    return { profile: { provider: "fixture" }, start: async () => ({ nativeSessionId: "native", capabilities: { session: { resume: true } } }),
      prompt: input => new Promise((resolve, reject) => { calls.push({ input, resolve, reject }); }),
      cancel: () => calls.at(-1)?.resolve({ stopReason: "cancelled" }), close: async () => calls.at(-1)?.resolve({ stopReason: "cancelled" }) };
  } } });
  return { gateway, calls, emit: event => emit(event) };
}

test("messages queued during execution or approval run once in FIFO order with their own model settings", async t => {
  const f = controlled(); t.after(() => f.gateway.closeAll());
  const session = await f.gateway.create({ profileId: "fixture" });
  const first = f.gateway.startTurn(session.id, { text: "First" }); await tick(0);
  f.emit({ type: "approval.requested", turnId: first.id, payload: { requestId: "permission" } });
  const second = f.gateway.startTurn(session.id, { text: "Second", model: "queued-model", reasoningEffort: "high" });
  f.gateway.startTurn(session.id, { text: "Third", reasoningEffort: "" });
  assert.equal(second.status, "queued");
  assert.equal(f.calls.length, 1);
  assert.equal(f.gateway.snapshot(session.id).turns.length, 1);
  assert.equal(f.gateway.snapshot(session.id).queuedMessages.length, 2);
  for (let index = 0; index < 3; index++) { f.calls[index].resolve({ stopReason: "end_turn" }); await tick(0); }
  assert.deepEqual(f.calls.map(call => call.input.content[0].text), ["First", "Second", "Third"]);
  assert.equal(f.calls[1].input.model, "queued-model");
  assert.equal(f.calls[1].input.reasoningEffort, "high");
  assert.equal(f.calls[2].input.reasoningEffort, null);
  const done = f.gateway.snapshot(session.id);
  assert.equal(done.status, "ready");
  assert.equal(done.queuedMessages.length, 0);
  assert.deepEqual(done.conversationEvents.filter(event => event.type === "user.message").map(event => event.payload.text), ["First", "Second", "Third"]);
  assert.ok(!done.events.some(event => event.type === "session.queue.updated"));
});

test("image-only queued messages preserve attachments, native image parts and retry identity", async t => {
  const f = controlled(); t.after(() => f.gateway.closeAll());
  const s = await f.gateway.create({ profileId: "fixture" });
  f.gateway.startTurn(s.id, { text: "Working" }); await tick(0);
  const image = { id: "image-123", name: "figure.png", mediaType: "image/png", sizeBytes: 100, path: "E:/images/figure.png" };
  const input = { text: "", attachments: [image], clientMessageId: "image-message-123" };
  const queued = f.gateway.startTurn(s.id, input);
  assert.equal(queued.status, "queued");
  assert.equal(f.gateway.startTurn(s.id, input).duplicate, true);
  assert.throws(() => f.gateway.startTurn(s.id, { ...input, attachments: [{ ...image, id: "different" }] }), { code: "AGENT_MESSAGE_ID_CONFLICT" });
  f.gateway.editQueuedMessage(s.id, queued.id, { text: "" });
  f.calls[0].resolve({ stopReason: "end_turn" }); await tick(0);
  assert.deepEqual(f.calls[1].input.content[1], { type: "image", path: image.path, mimeType: image.mediaType, name: image.name });
  const message = f.gateway.snapshot(s.id).conversationEvents.filter(event => event.type === "user.message").at(-1);
  assert.deepEqual(message.payload.attachments, [{ id: image.id, name: image.name, mediaType: image.mediaType, sizeBytes: 100 }]);
  f.calls[1].resolve({ stopReason: "end_turn" }); await tick(0);
});

test("stop pauses dispatch, queued messages can be removed and explicit continuation resumes the retained message", async t => {
  const f = controlled(); t.after(() => f.gateway.closeAll());
  const session = await f.gateway.create({ profileId: "fixture" });
  f.gateway.startTurn(session.id, { text: "Running" }); await tick(0);
  const keep = f.gateway.startTurn(session.id, { text: "Keep" });
  const remove = f.gateway.startTurn(session.id, { text: "Remove" });
  f.gateway.cancel(session.id); await tick(0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.gateway.snapshot(session.id).queuePaused, true);
  f.gateway.removeQueuedMessage(session.id, remove.id);
  assert.deepEqual(f.gateway.snapshot(session.id).queuedMessages.map(message => message.id), [keep.id]);
  f.gateway.resumeQueue(session.id); await tick(0);
  assert.equal(f.calls[1].input.content[0].text, "Keep");
  f.calls[1].resolve({ stopReason: "end_turn" }); await tick(0);
  assert.equal(f.gateway.snapshot(session.id).turns.length, 2);
});

test("a failed turn pauses its queue and a new ready-state submission stays behind existing messages", async t => {
  const f = controlled(); t.after(() => f.gateway.closeAll());
  const session = await f.gateway.create({ profileId: "fixture" });
  f.gateway.startTurn(session.id, { text: "Fail" }); await tick(0);
  f.gateway.startTurn(session.id, { text: "Earlier queued" });
  f.calls[0].reject(new Error("Provider busy")); await tick(0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.gateway.snapshot(session.id).queuePaused, true);
  f.gateway.startTurn(session.id, { text: "Later submitted" }); await tick(0);
  assert.equal(f.calls[1].input.content[0].text, "Earlier queued");
  f.calls[1].resolve({ stopReason: "end_turn" }); await tick(0);
  assert.equal(f.calls[2].input.content[0].text, "Later submitted");
});

test("pending messages survive restart without being executed until the restored queue is explicitly resumed", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "topolumia-message-queue-"));
  let restored;
  t.after(async () => { await restored?.gateway.closeAll(); await rm(directory, { recursive: true, force: true }); });
  const historyFile = path.join(directory, "history.json");
  const original = controlled(historyFile);
  const session = await original.gateway.create({ profileId: "fixture" });
  original.gateway.startTurn(session.id, { text: "Running" }); await tick(0);
  original.gateway.startTurn(session.id, { text: "Persisted pending" });
  await original.gateway.closeAll();
  restored = controlled(historyFile);
  await restored.gateway.initialize();
  assert.equal(restored.gateway.snapshot(session.id).queuePaused, true);
  assert.equal(restored.gateway.snapshot(session.id).queuedMessages[0].text, "Persisted pending");
  await restored.gateway.resume(session.id); await tick(0);
  assert.equal(restored.calls.length, 0);
  restored.gateway.resumeQueue(session.id); await tick(0);
  assert.equal(restored.calls[0].input.content[0].text, "Persisted pending");
});

test("queue admission validates messages and bounds pending work", async t => {
  const f = controlled(); t.after(() => f.gateway.closeAll());
  const session = await f.gateway.create({ profileId: "fixture" });
  f.gateway.startTurn(session.id, { text: "Running" }); await tick(0);
  assert.throws(() => f.gateway.startTurn(session.id, { text: " " }), { code: "AGENT_TURN_INPUT_INVALID" });
  for (let index = 0; index < 50; index++) f.gateway.startTurn(session.id, { text: `Pending ${index}` });
  assert.throws(() => f.gateway.startTurn(session.id, { text: "Too many" }), { code: "AGENT_QUEUE_FULL" });
  assert.equal(f.gateway.snapshot(session.id).queuedMessages.length, 50);
});
