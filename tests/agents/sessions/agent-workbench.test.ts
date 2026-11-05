import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentSessionGateway } from "../../../src/services/agents/agent-session-gateway.js";
import { agentResearchContext, saveAgentMessage } from "../../../src/services/agents/agent-workbench-service.js";
import { ResearchCommandService } from "../../../src/services/research/research-command-service.js";
import { ResearchState } from "../../../src/services/research/research-state.js";
import { TopologyService } from "../../../src/services/topology/topology-service.js";
import { startMvpServer } from "../../../src/server.js";

async function fixture(t, historyFile = null) {
  let emit, finish;
  const gateway = new AgentSessionGateway({ historyFile, profileRegistry: { createAdapter: async (_id, options) => {
    emit = options.onEvent;
    return { profile: { provider: "fixture" }, closed: false, start: async () => ({ nativeSessionId: "native", capabilities: { session: { resume: true } } }),
      prompt: () => new Promise(resolve => { finish = resolve; }), cancel: () => finish?.({ stopReason: "cancelled" }),
      resolvePermission: async () => {}, close: async () => finish?.({ stopReason: "cancelled" }) };
  } } });
  await gateway.initialize(); t.after(() => gateway.closeAll());
  return { gateway, emit: event => emit(event), finish: value => finish(value) };
}

test("session metadata persists without changing conversation identity or read order", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-metadata-"));
  const history = path.join(root, "history.json"), f = await fixture(t, history);
  const session = await f.gateway.create({ profileId: "fixture", title: "Original" });
  const turn = f.gateway.startTurn(session.id, { text: "Inspect evidence" }); await delay(0);
  f.emit({ type: "assistant.message.completed", turnId: turn.id, payload: { blockId: "answer", text: "Versioned evidence." } }); f.finish({}); await delay(0);
  const cursor = f.gateway.snapshot(session.id).latestMessageCursor;
  await f.gateway.updateSession(session.id, { title: "Named research", pinned: true, readCursor: cursor });
  await f.gateway.updateSession(session.id, { readCursor: 0 });
  assert.equal(f.gateway.snapshot(session.id).lastReadCursor, cursor);
  await f.gateway.updateSession(session.id, { archived: true });
  f.gateway.historyStore.updateLimits({ maxSessions: 1 });
  for (const title of ["New recent one", "New recent two"]) { const other = await f.gateway.create({ profileId: "fixture", title }); await f.gateway.close(other.id); }
  assert.throws(() => f.gateway.startTurn(session.id, { text: "Should not execute" }), { code: "AGENT_SESSION_ARCHIVED" });
  const restored = await fixture(t, history), value = restored.gateway.snapshot(session.id);
  assert.equal(value.id, session.id); assert.equal(value.title, "Named research"); assert.equal(value.pinned, true); assert.equal(value.archived, true);
  assert.equal(value.turns[0].id, turn.id); assert.equal(value.lastReadCursor, cursor);
  assert.equal(value.conversationEvents.filter(e => e.type === "user.message").length, 1);
  t.after(() => rm(root, { recursive: true, force: true }));
});

test("editing a queued message preserves its model and FIFO; submitting the same client ID is idempotent", async t => {
  const f = await fixture(t), s = await f.gateway.create({ profileId: "fixture" });
  const first = f.gateway.startTurn(s.id, { text: "First", clientMessageId: "client-first-123" }); await delay(0);
  assert.equal(f.gateway.startTurn(s.id, { text: "First", clientMessageId: "client-first-123" }).id, first.id);
  const queued = f.gateway.startTurn(s.id, { text: "Second", model: "gpt-6-luna", clientMessageId: "client-second-123" });
  const duplicate = f.gateway.startTurn(s.id, { text: "Second", clientMessageId: "client-second-123" }); assert.equal(duplicate.id, queued.id);
  f.gateway.editQueuedMessage(s.id, queued.id, { text: "Revised second" });
  assert.equal(f.gateway.startTurn(s.id, { text: "Second", clientMessageId: "client-second-123" }).id, queued.id);
  assert.equal(f.gateway.snapshot(s.id).queuedMessages[0].model, "gpt-6-luna");
  assert.throws(() => f.gateway.startTurn(s.id, { text: "Different", clientMessageId: "client-first-123" }), { code: "AGENT_MESSAGE_ID_CONFLICT" });
  assert.throws(() => f.gateway.editQueuedMessage(s.id, first.id, { text: "Too late" }), { code: "AGENT_QUEUE_MESSAGE_NOT_FOUND" });
  f.finish({}); await delay(5);
  assert.equal(f.gateway.snapshot(s.id).turns[1].input[0].text, "Revised second");
  assert.equal(f.gateway.snapshot(s.id).turns[1].clientMessageId, "client-second-123");
});

test("effective session permissions reset by replacing the runtime and preserve history", async t => {
  const f = await fixture(t), s = await f.gateway.create({ profileId: "fixture" });
  const turn = f.gateway.startTurn(s.id, { text: "Edit a file" }); await delay(0);
  f.emit({ type: "approval.requested", turnId: turn.id, payload: { requestId: "edit", options: [{ optionId: "edit-mode", kind: "allow_session", scope: "session", mode: "acceptEdits", label: "本会话自动允许编辑" }] } });
  await f.gateway.resolveApproval(s.id, "edit", { decision: "allow", optionId: "edit-mode" }, { permissions: ["*"] });
  assert.equal(f.gateway.snapshot(s.id).permissionGrants[0].mode, "acceptEdits");
  await assert.rejects(f.gateway.resetPermissions(s.id, {}), { code: "AGENT_SESSION_BUSY" });
  f.finish({}); await delay(0); const reset = await f.gateway.resetPermissions(s.id, { ownerUserId: null });
  assert.equal(reset.id, s.id); assert.notEqual(reset.runtimeInstanceId, s.runtimeInstanceId); assert.deepEqual(reset.permissionGrants, []);
  assert.equal(reset.turns.length, 1);
});

test("summary polling omits heavy payloads; search links to original message IDs", async t => {
  const f = await fixture(t), s = await f.gateway.create({ profileId: "fixture" });
  const turn = f.gateway.startTurn(s.id, { text: "Question" }); await delay(0);
  f.emit({ type: "assistant.message.completed", turnId: turn.id, payload: { blockId: "answer", text: "needle " + "evidence ".repeat(10_000) } });
  f.finish({}); await delay(0);
  const summary = f.gateway.list({ summary: true })[0];
  assert.equal(summary.turns, undefined); assert.equal(summary.context, undefined); assert.equal(summary.conversationEvents, undefined);
  assert.ok(JSON.stringify(summary).length < 1500);
  const found = f.gateway.searchMessages("needle"); assert.equal(found.matches[0].sessionId, s.id);
  assert.equal(found.matches[0].eventId, f.gateway.snapshot(s.id).conversationEvents.find(e => e.type === "assistant.message.completed").id);
});

test("session research context excludes other sessions; saving a message makes one reviewable full-text note", () => {
  const topologyService = new TopologyService({ demo: true }), state = new ResearchState(topologyService.build());
  const commands = new ResearchCommandService({ state, topologyService, projectId: "project", projectName: "Research" });
  const actor = { isServerAdmin: true, user: { id: "owner" }, permissions: ["*"], projectId: "project" };
  const text = "# Reproducible result\n\n" + "Measured evidence. ".repeat(200);
  const session = { id: "visible-session", title: "Investigation", researchSessionId: "research-session", conversationEvents: [{ id: "answer", turnId: "turn", type: "assistant.message.completed", payload: { text } }] };
  commands.store.put("receipts", "own", { id: "own", researchSessionId: "research-session", object: { kind: "node", id: "node:fixture" }, at: "2026-11-03" });
  commands.store.put("receipts", "other", { id: "other", researchSessionId: "other-session", object: { kind: "node", id: "node:other" }, at: "2026-11-03" });
  state.research.candidates = [];
  assert.deepEqual(agentResearchContext(session, commands).reads.map(read => read.id), ["own"]);
  const note = saveAgentMessage(session, commands, actor, ["answer"]);
  assert.equal(note.status, "pending"); assert.equal(note.provenance.sessionId, "research-session");
  const context = agentResearchContext(session, commands);
  assert.equal(context.candidates[0].turnId, "turn");
  assert.equal(context.candidates[0].summary.addedBlocks, 1);
  assert.equal(context.candidates[0].operations, undefined);
  assert.equal(note.operations.find(operation => operation.op === "addBlock").payload.body, text);
  assert.equal(saveAgentMessage(session, commands, actor, ["answer"]).id, note.id);
  assert.equal(commands.data().candidates.length, 1);
  assert.ok(!commands.formalTopology().nodes.some(node => node.id === note.allocation["node:" + note.operations[0].clientRef]));
  assert.throws(() => saveAgentMessage(session, commands, actor, ["missing"]), { code: "AGENT_NOTE_MESSAGE_UNAVAILABLE" });
  assert.throws(() => saveAgentMessage(session, commands, { ...actor, isServerAdmin: false, permissions: ["research.view"] }, ["answer"]), { code: "FORBIDDEN" });
});

test("new workbench mutation routes keep session ownership checks", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-workbench-api-"));
  const app = await startMvpServer({ port: 0, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: { sourceRefresh: { enabled: false } } });
  t.after(async () => { await app.agentSessionGateway.closeAll(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  // A lightweight owned record is enough to exercise real routing, project
  // permissions and identity checks, without starting a model runtime.
  const actor = (await (await fetch(`${app.url}/api/auth/me`)).json()).user;
  const id = "agent_session_route_fixture";
  app.agentSessionGateway.sessions.set(id, { id, ownerUserId: actor.id, title: "Route fixture", profileId: "fixture", status: "detached", createdAt: "", updatedAt: "", turns: [], queuedMessages: [], events: [], conversationEvents: [], pendingApprovals: new Map(), subscribers: new Set(), cursor: 0 });
  const request = (suffix, method, body = {}) => fetch(`${app.url}/api/agent-sessions/${id}${suffix}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await request("", "PATCH", { title: "Renamed" })).status, 200);
  app.agentSessionGateway.sessions.get(id).ownerUserId = "another-owner";
  for (const [suffix, method, body] of [["", "PATCH", { pinned: true }], ["/queue/q1", "PATCH", { text: "Overwrite" }], ["/notes", "POST", { eventIds: ["answer"] }], ["/permissions/reset", "POST", {}]]) {
    assert.equal((await request(suffix, method, body)).status, 403);
  }
});
