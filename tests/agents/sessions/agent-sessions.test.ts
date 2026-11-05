import { installTopologyFixture } from "../../helpers/topology-fixture.js";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig, bundledRoot } from "../../../src/config.js";
import { startMvpServer } from "../../../src/server.js";

let app;
let sessionId;

before(async () => {
  const config = await loadConfig();
  config.agentSessions.profiles.push({
    id: "research-fixture-acp", label: "Research Demo · ACP", provider: "fixture", source: "bundled",
    command: process.execPath, args: [path.join(bundledRoot, "fixtures/acp/research-agent.js")],
  });
  app = await startMvpServer({ port: 0, config });
  installTopologyFixture(app);
});

after(async () => {
  if (sessionId) await request(`/api/agent-sessions/${sessionId}/close`, { method: "POST", body: "{}" }).catch(() => {});
  if (app?.server) await new Promise((resolve) => app.server.close(resolve));
});

async function request(path, options = {}) {
  const response = await fetch(`${app.url}${path}`, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers ?? {}) },
  });
  const payload = await response.json();
  return { response, payload };
}

async function waitForSession(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await request(`/api/agent-sessions/${sessionId}`);
    if (predicate(current.payload)) return current.payload;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for Agent session state");
}

test("ACP profiles expose one deterministic fixture and capability-negotiated providers", async () => {
  const { response, payload } = await request("/api/agent-profiles");
  assert.equal(response.status, 200);
  assert.equal(payload.schemaVersion, "agent-profiles.v1");
  const fixture = payload.profiles.find((profile) => profile.id === "research-fixture-acp");
  assert.equal(fixture.availability, "ready");
  assert.equal(fixture.transport, "acp-stdio");
  assert.ok(payload.profiles.some((profile) => profile.id === "codex-acp"));
  assert.ok(payload.profiles.some((profile) => profile.id === "opencode-acp"));
});

test("ACP fixture session streams messages and tool events into the platform journal", async () => {
  const sync = await request("/api/sync", { method: "POST", body: "{}" });
  const sourceRef = sync.payload.mlflow.runs.find((run) => run.group === "G1").ref;
  const created = await request("/api/agent-sessions", {
    method: "POST",
    body: JSON.stringify({
      profileId: "research-fixture-acp",
      title: "检查 G1 感知收益归因",
      locale: "zh",
      nodeIds: ["hypothesis:conditioning-main-effect", "experiment:g1"],
      sourceRefs: [sourceRef],
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.status, "ready");
  assert.equal(created.payload.capabilities.promptCapabilities.embeddedContext, true);
  sessionId = created.payload.id;
  const liveEvents = [];
  const stopLive = app.agentSessionGateway.subscribe(sessionId, event => liveEvents.push(event));

  const turn = await request(`/api/agent-sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({ text: "先核对 G1 与 G0 的 LPIPS 差异，并说明目前不能得出什么结论。" }),
  });
  assert.equal(turn.response.status, 202);
  const completed = await waitForSession((session) => session.turns.at(-1)?.status === "completed");
  assert.match(completed.turns.at(-1).assistantText, /不能接受/);
  stopLive();
  assert.ok(liveEvents.some(event => event.type === "assistant.message.delta"));
  assert.ok(!completed.events.some(event => event.type.endsWith(".delta") || event.type === "tool.updated" || event.type === "native.trace"));
  assert.ok(completed.events.some((event) => event.type === "assistant.message.completed"));
  assert.ok(completed.conversationEvents.some((event) => event.type === "tool.started"));
  assert.ok(completed.events.some((event) => event.type === "tool.completed"));

  const localSync = await request(`/api/agent-sessions/${sessionId}/sync`, { method: "POST", body: JSON.stringify({ reason: "test" }) });
  assert.equal(localSync.response.status, 200);
  assert.equal(localSync.payload.status, "legacy_local_snapshot");
  assert.equal(localSync.payload.session.sync.status, "legacy_local_snapshot");

  const researchState = await request("/api/state");
  assert.ok(researchState.payload.agentEvents.some((event) => event.sessionId === sessionId && event.type === "agentMessage"));
  assert.ok(researchState.payload.agentEvents.some((event) => event.sessionId === sessionId && event.type === "toolResult"));
});

test("permission request pauses a turn and resumes after an explicit decision", async () => {
  const started = await request(`/api/agent-sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({ text: "请运行只读指标检查；需要审批时先问我。" }),
  });
  assert.equal(started.response.status, 202);
  const waiting = await waitForSession((session) => session.status === "awaiting_permission");
  const approval = waiting.pendingApprovals[0];
  assert.ok(approval.requestId);
  assert.ok(approval.options.some((option) => option.kind === "allow_once"));

  const resolved = await request(`/api/agent-sessions/${sessionId}/approvals/${approval.requestId}`, {
    method: "POST",
    body: JSON.stringify({ decision: "allow" }),
  });
  assert.equal(resolved.response.status, 200);
  assert.equal(resolved.payload.optionId, "allow-once");
  const completed = await waitForSession((session) => session.turns.at(-1)?.status === "completed");
  assert.ok(completed.events.some((event) => event.type === "approval.resolved"));
  assert.ok(completed.events.some((event) => event.type === "tool.completed" && event.payload.toolCallId?.startsWith("tool_exec_")));
});

test("cancel ends the active ACP prompt without closing the platform conversation", async () => {
  const started = await request(`/api/agent-sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({ text: "慢速检查当前 Working Set，稍后我会取消。" }),
  });
  assert.equal(started.response.status, 202);
  const cancelled = await request(`/api/agent-sessions/${sessionId}/cancel`, { method: "POST", body: "{}" });
  assert.equal(cancelled.response.status, 202);
  const settled = await waitForSession((session) => session.turns.at(-1)?.status === "cancelled");
  assert.equal(settled.status, "ready");
  assert.ok(settled.events.some((event) => event.type === "turn.cancelled"));
});

test("session history and identity survive resuming with a new runtime binding", async () => {
  const closed = await request(`/api/agent-sessions/${sessionId}/close`, { method: "POST", body: "{}" });
  assert.equal(closed.response.status, 200);
  assert.equal(closed.payload.status, "closed");

  const listed = await request("/api/agent-sessions");
  const historical = listed.payload.sessions.find((session) => session.id === sessionId);
  assert.ok(historical);
  assert.equal(historical.historyStatus, "persisted");

  const resumed = await request(`/api/agent-sessions/${sessionId}/resume`, {
    method: "POST",
    body: JSON.stringify({ locale: "zh" }),
  });
  assert.equal(resumed.response.status, 200);
  assert.equal(resumed.payload.status, "ready");
  assert.equal(resumed.payload.id, sessionId);
  assert.equal(resumed.payload.turns.length, historical.turns.length);
  assert.equal(resumed.payload.researchSessionId, historical.researchSessionId);
  assert.notEqual(resumed.payload.runtimeInstanceId, historical.runtimeInstanceId);
  assert.equal(resumed.payload.context.handoff, undefined);
  assert.equal((await request("/api/agent-sessions")).payload.sessions.length, listed.payload.sessions.length);
  sessionId = resumed.payload.id;
});
