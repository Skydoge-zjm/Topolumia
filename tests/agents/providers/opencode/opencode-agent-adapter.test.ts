import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { OpenCodeAgentAdapter } from "../../../../src/adapters/agents/opencode/opencode-agent-adapter.js";
import { readOpenCodeCatalog, resolveOpenCodeModelId } from "../../../../src/adapters/agents/opencode/opencode-server.js";
import { AgentProfileRegistry } from "../../../../src/services/agents/agent-profile-registry.js";
import { AgentSessionGateway } from "../../../../src/services/agents/agent-session-gateway.js";

async function fixture(t) {
  const clients = new Set<http.ServerResponse>();
  const messages = [];
  const calls = [];
  const sessionID = "ses_fixture";
  let status = "idle";
  let callback: () => void = () => {};
  let permissionReply;
  let failureStatus = 0;
  let abortFailure = 0;
  let deferredPrompt = false, releasePrompt = () => {};
  let nativeEventSequence = 0;
  const model = { id: "model/with-slash", name: "Configured model", status: "active", capabilities: { input: { text: true } }, variants: { low: {}, high: {}, hidden: { disabled: true } } };
  function send(type, properties) { const packet = { id: `evt_${++nativeEventSequence}`, type,
    properties: { sessionID, ...(type === "message.part.updated" ? { time: Date.now() } : {}), ...properties } };
    for (const c of clients) c.write(`data: ${JSON.stringify(packet)}\n\n`); }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ method: req.method, path: url.pathname, directory: url.searchParams.get("directory") ?? decodeURIComponent(String(req.headers["x-opencode-directory"] ?? "")), body });
    const json = (data, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      clients.add(res); res.write('data: {"type":"server.connected","properties":{}}\n\n');
      req.on("close", () => clients.delete(res)); return;
    }
    if (url.pathname === "/config/providers") return json({ providers: [{ id: "custom", name: "My provider", key: "secret-not-for-browser", models: { [model.id]: model } }], default: { custom: model.id } });
    if (url.pathname === "/config") return json({ model: `custom/${model.id}` });
    if (url.pathname === "/permission") return json([]);
    if (url.pathname === "/session" && req.method === "POST") return json({ id: sessionID, directory: process.cwd() });
    if (url.pathname === "/session/status") return json(status === "idle" ? {} : { [sessionID]: { type: status } });
    if (url.pathname === `/session/${sessionID}`) return json({ id: sessionID, directory: process.cwd() });
    if (url.pathname === `/session/${sessionID}/message` && req.method === "GET") return json(messages);
    if (url.pathname === `/session/${sessionID}/prompt_async`) {
      if (failureStatus) return json({ error: "fixture failure" }, failureStatus);
      status = "busy";
      messages.push({ info: { id: body.messageID, sessionID, role: "user", time: { created: Date.now() } }, parts: body.parts });
      const respond = () => { res.writeHead(204); res.end(); };
      if (deferredPrompt) releasePrompt = respond; else respond(); return;
    }
    if (url.pathname === `/session/${sessionID}/abort`) { if (abortFailure) return json({ error: "abort failed" }, abortFailure); status = "idle"; return json(true); }
    if (url.pathname.startsWith("/permission/")) { permissionReply = body.reply; json(true); callback(); return; }
    if (url.pathname.endsWith("missing")) return json({ name: "NotFoundError" }, 404);
    json({ error: "unknown fixture endpoint" }, 404);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, directory: process.cwd(), throwOnError: true });
  const adapter = new OpenCodeAgentAdapter({ id: "open", label: "OpenCode", provider: "opencode", command: "fixture", args: ["serve"] }, {
    requestTimeoutMs: 5_000,
    serverFactory: () => ({ start: async () => client, close: async () => {} }) as never,
    onEvent: (e) => events.push(e),
  });
  const events = [];
  t.after(async () => { await adapter.close(); for (const c of clients) c.end(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const started = await adapter.start({ cwd: process.cwd(), developerInstructions: "Topolumia skill" });
  const waitPrompt = async () => { await assert.doesNotReject(async () => { for (let i = 0; i < 100; i++) { if (status === "busy") return; await delay(5); } throw new Error("prompt not received"); }); };
  const assistant = (id: string) => {
    const info = { id, sessionID, role: "assistant", parentID: messages.at(-1).info.id, time: { created: Date.now() }, tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 };
    const record = { info, parts: [] }; messages.push(record); send("message.updated", { info }); return record;
  };
  const part = (record, value) => { const full = { sessionID, messageID: record.info.id, ...value }; const i = record.parts.findIndex(p => p.id === full.id); if (i < 0) record.parts.push(full); else record.parts[i] = full; send("message.part.updated", { part: full }); };
  const finish = (record) => { record.info.time.completed = Date.now(); send("message.updated", { info: record.info }); status = "idle"; send("session.status", { status: { type: "idle" } }); };
  return { adapter, client, events, calls, started, send, waitPrompt, assistant, part, finish, messages, clients, setStatus: v => { status = v; }, fail: v => { failureStatus = v; }, failAbort: v => { abortFailure = v; }, deferPrompt: () => { deferredPrompt = true; }, releasePrompt: () => releasePrompt(), reply: () => permissionReply, onReply: fn => { callback = fn; } };
}

test("OpenCode registry chooses its native adapter, not ACP", async () => {
  const registry = new AgentProfileRegistry({ agentSessions: { profiles: [{ id: "opencode-acp", label: "OpenCode", provider: "opencode", driver: "opencode-server", command: process.execPath }] } });
  const adapter = await registry.createAdapter("opencode-acp");
  assert.ok(adapter instanceof OpenCodeAgentAdapter);
  await adapter.close();
});

test("official SDK discovers only configured models and exposes supported variants without secrets", async t => {
  const f = await fixture(t);
  const catalog = await readOpenCodeCatalog(f.client);
  assert.deepEqual(catalog.models, [{ id: "custom/model/with-slash", label: "Configured model · My provider", reasoningEfforts: ["low", "high"] }]);
  assert.equal(catalog.model, "custom/model/with-slash");
  assert.ok(!JSON.stringify(catalog).includes("secret"));
  assert.ok(f.calls.every(call => call.directory === process.cwd()));
  assert.equal((await readOpenCodeCatalog(f.client, "model/with-slash")).model, "custom/model/with-slash");
  await assert.rejects(readOpenCodeCatalog(f.client, "gpt-6-luna"), { code: "OPENCODE_MODEL_UNAVAILABLE" });
});

test("OpenCode short model names require a unique configured provider and never select another model", () => {
  const models = ["first/gpt-6-luna", "second/gpt-6-luna", "second/other"].map(id => ({ id, label: id, reasoningEfforts: [] }));
  assert.equal(resolveOpenCodeModelId(models.slice(0, 1), "gpt-6-luna"), "first/gpt-6-luna");
  assert.equal(resolveOpenCodeModelId(models, "second/gpt-6-luna"), "second/gpt-6-luna");
  assert.throws(() => resolveOpenCodeModelId(models, "gpt-6-luna"), { code: "OPENCODE_MODEL_AMBIGUOUS" });
  assert.throws(() => resolveOpenCodeModelId(models, "missing"), { code: "OPENCODE_MODEL_UNAVAILABLE" });
});

test("OpenCode sends the resolved provider and complete model ID to the native runtime", async t => {
  const f = await fixture(t);
  const result = f.adapter.prompt({ turnId: "short-model", model: "model/with-slash", content: [{ type: "text", text: "hello" }] });
  await f.waitPrompt();
  const sent = f.calls.find(call => call.path.endsWith("/prompt_async"));
  assert.deepEqual(sent.body.model, { providerID: "custom", modelID: "model/with-slash" });
  const a = f.assistant("resolved-model");
  f.part(a, { id: "resolved-answer", type: "text", text: "ok", time: { start: 1, end: 2 } }); f.finish(a);
  assert.equal((await result).stopReason, "end_turn");
});

test("OpenCode sends image bytes as native file parts alongside text", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-opencode-image-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "figure.png");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=";
  await writeFile(file, Buffer.from(png, "base64"));
  const f = await fixture(t);
  const result = f.adapter.prompt({ turnId: "image-input", content: [{ type: "text", text: "Read this figure" }, { type: "image", path: file, mimeType: "image/png", name: "figure.png" }] });
  await f.waitPrompt();
  const parts = f.calls.find(call => call.path.endsWith("/prompt_async")).body.parts;
  assert.deepEqual(parts, [{ type: "text", text: "Read this figure" }, { type: "file", mime: "image/png", filename: "figure.png", url: `data:image/png;base64,${png}` }]);
  const a = f.assistant("image-answer");
  f.part(a, { id: "answer", type: "text", text: "Figure checked.", time: { start: 1, end: 2 } });
  f.finish(a); await result;
});

test("native message/part IDs preserve commentary → command → answer across multiple turns", async t => {
  const f = await fixture(t);
  for (let n = 1; n <= 2; n++) {
    const result = f.adapter.prompt({ turnId: `turn${n}`, content: [{ type: "text", text: "Run a check" }], reasoningEffort: "high" });
    await f.waitPrompt();
    const a = f.assistant(`answer${n}`);
    f.part(a, { id: `before${n}`, type: "text", text: "I will check.", time: { start: 1, end: 2 } });
    const tool = { id: `tool${n}`, type: "tool", callID: `call${n}`, tool: "bash", state: { status: "running", input: { command: "echo ok" }, time: { start: 2 } } };
    for (let i = 0; i < 40; i++) f.part(a, tool);
    f.part(a, { ...tool, state: { ...tool.state, status: "completed", title: "check", output: "ok", metadata: {}, time: { start: 2, end: 3 } } });
    f.part(a, { id: `after${n}`, type: "text", text: "", time: { start: 4 } });
    f.send("message.part.delta", { messageID: a.info.id, partID: `after${n}`, field: "text", delta: "Checked." });
    f.part(a, { id: `after${n}`, type: "text", text: "Checked.", time: { start: 4, end: 5 } });
    f.finish(a);
    assert.deepEqual(await result, { stopReason: "end_turn" });
    const events = f.events.filter(e => e.turnId === `turn${n}`);
    assert.equal(events.filter(e => e.type === "tool.started").length, 1);
    assert.equal(events.filter(e => e.type === "tool.completed").length, 1);
    assert.equal(events.filter(e => e.type === "tool.updated").length, 0);
    assert.deepEqual(events.filter(e => ["assistant.message.completed", "tool.started", "tool.completed"].includes(e.type)).map(e => [e.type, e.payload.messageId ?? e.payload.toolCallId]), [
      ["assistant.message.completed", `before${n}`], ["tool.started", `call${n}`], ["tool.completed", `call${n}`], ["assistant.message.completed", `after${n}`],
    ]);
    assert.equal(events.filter(e => e.type === "assistant.message.delta").map(e => e.payload.delta).join(""), "I will check.Checked.");
  }
  const requests = f.calls.filter(c => c.path.endsWith("prompt_async"));
  assert.equal(requests[0].body.model.providerID, "custom");
  assert.equal(requests[0].body.model.modelID, "model/with-slash");
  assert.equal(requests[0].body.system, "Topolumia skill");
  const snapshot = await f.adapter.readSnapshot();
  assert.equal(snapshot.format, "agent-native-events.v1");
  assert.equal(snapshot.events.filter(e => e.type === "assistant.message.completed").length, 4);
});

for (const reply of ["once", "always", "reject"]) test(`native permission ${reply} resumes the same pending turn`, async t => {
  const f = await fixture(t);
  const result = f.adapter.prompt({ turnId: reply, content: [{ type: "text", text: "Check" }] });
  await f.waitPrompt();
  const requested = onceEvent(f.events, "approval.requested");
  f.send("permission.asked", { id: "perm1", permission: "bash", patterns: ["echo ok"], metadata: {}, always: reply === "always" ? ["echo *"] : [] });
  const approval = await requested;
  assert.notEqual(approval.payload.requestId, "perm1");
  if (reply === "always") assert.equal(approval.payload.options.find(o => o.optionId === "always").scope, "session");
  f.onReply(() => { const a = f.assistant(`approved-${reply}`); f.part(a, { id: "final", type: "text", text: "done", time: { start: 1, end: 2 } }); f.finish(a); });
  await f.adapter.resolvePermission(approval.payload.requestId, reply);
  assert.equal(f.reply(), reply);
  assert.equal((await result).stopReason, "end_turn");
});

test("OpenCode external permission replies settle only the matching request", async t => {
  const f = await fixture(t);
  const result = f.adapter.prompt({ turnId: "permissions", content: [] }); await f.waitPrompt();
  f.send("permission.asked", { id: "first", permission: "bash", patterns: ["python experiment.py"], always: [], metadata: {} });
  const first = await onceEvent(f.events, "approval.requested");
  f.send("permission.replied", { requestID: "first", reply: "once" });
  const resolved = await onceEvent(f.events, "approval.resolved");
  assert.equal(resolved.payload.requestId, first.payload.requestId); assert.equal(resolved.payload.decision, "allow");
  await assert.rejects(f.adapter.resolvePermission(first.payload.requestId, "once"), { code: "AGENT_APPROVAL_NOT_FOUND" });
  f.send("permission.asked", { id: "second", permission: "edit", patterns: ["results.csv"], always: [], metadata: {} });
  for (let i = 0; i < 100 && f.events.filter(e => e.type === "approval.requested").length < 2; i++) await delay(10);
  const second = f.events.filter(e => e.type === "approval.requested")[1];
  f.adapter.cancel(); assert.equal((await result).stopReason, "cancelled");
  assert.ok(f.events.some(e => e.type === "approval.resolved" && e.payload.requestId === second.payload.requestId && e.payload.decision === "cancelled"));
  const created = f.calls.find(c => c.path === "/session" && c.method === "POST");
  assert.equal(created.body.permission[0].action, "ask");
});

test("cancellation aborts native work and the adapter accepts a subsequent turn", async t => {
  const f = await fixture(t);
  const result = f.adapter.prompt({ turnId: "cancel", content: [{ type: "text", text: "wait" }] });
  await f.waitPrompt(); f.adapter.cancel();
  assert.equal((await result).stopReason, "cancelled");
  const next = f.adapter.prompt({ turnId: "next", content: [{ type: "text", text: "hello" }] });
  await f.waitPrompt(); const a = f.assistant("after-cancel"); f.part(a, { id: "ok", type: "text", text: "ok", time: { start: 1, end: 2 } }); f.finish(a);
  assert.equal((await next).stopReason, "end_turn");
  assert.ok(f.calls.some(c => c.path.endsWith("/abort")));
});

test("invalid models/variants fail before execution; HTTP errors reject rather than hang", async t => {
  const f = await fixture(t);
  await assert.rejects(f.adapter.prompt({ turnId: "bad-model", model: "codex/gpt", content: [] }), { code: "OPENCODE_MODEL_UNAVAILABLE" });
  await assert.rejects(f.adapter.prompt({ turnId: "bad-variant", reasoningEffort: "ultra", content: [] }), { code: "OPENCODE_VARIANT_UNAVAILABLE" });
  f.fail(500);
  await assert.rejects(f.adapter.prompt({ turnId: "http-failure", content: [] }), { code: "OPENCODE_REQUEST_FAILED" });
});

test("OpenCode retires its owned server after abort failure instead of accepting overlapping work", async t => {
  const f = await fixture(t);
  const result = f.adapter.prompt({ turnId: "abort-failure", content: [] }); await f.waitPrompt();
  f.failAbort(500); f.adapter.cancel();
  await assert.rejects(result, { code: "OPENCODE_REQUEST_FAILED" }); assert.equal(f.adapter.closed, true);
  await assert.rejects(f.adapter.prompt({ turnId: "unsafe-overlap", content: [] }), { code: "OPENCODE_NOT_READY" });
});

test("OpenCode early cancellation waits for prompt acceptance and sends exactly one abort", async t => {
  const f = await fixture(t); f.deferPrompt();
  const result = f.adapter.prompt({ turnId: "early-stop", content: [] }); await f.waitPrompt();
  f.adapter.cancel(); f.adapter.cancel(); await delay(20);
  assert.equal(f.calls.filter(c => c.path.endsWith("/abort")).length, 0);
  f.releasePrompt(); assert.equal((await result).stopReason, "cancelled");
  assert.equal(f.calls.filter(c => c.path.endsWith("/abort")).length, 1);
});

test("an interrupted SSE connection recovers completed output from native history once", async t => {
  const f = await fixture(t);
  const result = f.adapter.prompt({ turnId: "reconnect", content: [{ type: "text", text: "hello" }] });
  await f.waitPrompt();
  for (const c of f.clients) c.end(); f.clients.clear();
  const a = f.assistant("offline-message"); f.part(a, { id: "offline-final", type: "text", text: "Recovered", time: { start: 1, end: 2 } }); f.finish(a);
  assert.equal((await result).stopReason, "end_turn");
  assert.equal(f.events.filter(e => e.type === "assistant.message.completed" && e.payload.text === "Recovered").length, 1);
});

test("native quota waits fail promptly with a useful error", async t => {
  const f = await fixture(t);
  const result = f.adapter.prompt({ turnId: "quota", content: [] });
  await f.waitPrompt();
  f.send("session.status", { status: { type: "retry", attempt: 1, message: "Free usage exceeded", action: { reason: "free_tier_limit" }, next: Date.now() + 60_000_000 } });
  await assert.rejects(result, { code: "OPENCODE_PROVIDER_LIMIT", message: "OpenCode：Free usage exceeded" });
});

test("an idle status snapshot before assistant output cannot finish a new turn", async t => {
  const f = await fixture(t);
  let settled = false;
  const result = f.adapter.prompt({ turnId: "early-idle", content: [] });
  void result.then(() => { settled = true; });
  await f.waitPrompt(); f.setStatus("idle");
  await delay(30);
  assert.equal(settled, false);
  const a = f.assistant("real-answer"); f.part(a, { id: "answer", type: "text", text: "Actual output", time: { start: 1, end: 2 } }); f.finish(a);
  assert.equal((await result).stopReason, "end_turn");
  assert.equal(f.events.filter(e => e.type === "assistant.message.completed").length, 1);
});

test("gateway sync preserves canonical event order without duplicating the user or assistant", async t => {
  const f = await fixture(t);
  f.adapter.start = async () => f.started;
  const registry = { createAdapter: async (_id, options) => { f.adapter.onEvent = options.onEvent; return f.adapter; } };
  const gateway = new AgentSessionGateway({ profileRegistry: registry });
  t.after(() => gateway.closeAll());
  const session = await gateway.create({ profileId: "open", cwd: process.cwd() });
  assert.equal(session.model, "custom/model/with-slash");
  gateway.startTurn(session.id, { text: "Hello" });
  await f.waitPrompt();
  const a = f.assistant("gateway-message");
  f.part(a, { id: "gateway-text", type: "text", text: "Hello back", time: { start: 1, end: 2 } }); f.finish(a);
  for (let i = 0; i < 100 && gateway.snapshot(session.id).status !== "ready"; i++) await delay(10);
  await gateway.sync(session.id); await gateway.sync(session.id);
  const detail = gateway.snapshot(session.id);
  assert.equal(detail.events.filter(e => e.type === "user.message").length, 1);
  assert.equal(detail.events.filter(e => e.type === "assistant.message.completed").length, 1);
  assert.equal(detail.turns[0].assistantText, "Hello back");
});

async function onceEvent(events, type) {
  for (let i = 0; i < 100; i++) { const event = events.find(e => e.type === type); if (event) return event; await delay(10); }
  throw new Error(`Missing event: ${type}`);
}
