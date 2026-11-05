import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compactConversationEvents } from "../../../../src/domain/agents/agent-conversation.js";
import { CodexAppServerDriver, CodexAppServerReader } from "../../../../src/adapters/agents/codex/codex-app-server-driver.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const codexFixture = path.join(root, "fixtures", "native", "codex-app-server.js");

async function waitFor(events, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = events.find(predicate);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for Codex app-server event");
}

test("Codex app-server driver speaks app-server JSONL and maps tool events", async () => {
  const events = [];
  const driver = new CodexAppServerDriver({
    id: "fixture-codex",
    label: "Fixture Codex",
    provider: "codex",
    command: "node",
    args: [codexFixture],
    model: "gpt-5.6-luna",
  }, { env: { TOPOLUMIA_URL: "http://fixture", TOPOLUMIA_PROJECT_ID: "fixture", TOPOLUMIA_SESSION: "fixture-only" }, requestTimeoutMs: 2_000, onEvent: (event) => events.push(event) });
  const started = await driver.start({ cwd: root });
  assert.equal(started.nativeSessionId, "fixture-codex-thread");
  const result = await driver.prompt({ turnId: "turn-1", content: [{ type: "text", text: "检查当前实验" }] });
  assert.equal(result.stopReason, "end_turn");
  assert.ok(events.some((event) => event.type === "assistant.message.delta"));
  assert.ok(events.some((event) => event.type === "assistant.message.completed" && event.payload.messageId === "fixture-agent-message"));
  assert.ok(events.some((event) => event.type === "tool.started"));
  assert.ok(events.some((event) => event.type === "tool.updated"));
  assert.ok(events.some((event) => event.type === "tool.completed"));
  assert.ok(events.some((event) => event.type === "reasoning.summary.delta"));
  assert.ok(events.some((event) => event.type === "plan.updated"));
  assert.ok(events.some((event) => event.type === "usage.updated"));
  assert.ok(events.some((event) => event.type === "tool.updated" && /PSNR=31\.4/.test(event.payload.delta)));
  await driver.close();
});

test("Codex app-server reader loads a persisted thread checkpoint without a live session", async () => {
  const reader = new CodexAppServerReader({
    id: "fixture-codex",
    label: "Fixture Codex",
    provider: "codex",
    command: "node",
    args: [codexFixture],
  }, { requestTimeoutMs: 2_000 });
  const snapshot = await reader.readThread({ threadId: "fixture-codex-thread" });
  assert.equal(snapshot.thread.thread.id, "fixture-codex-thread");
  assert.ok(snapshot.turns.data.some((turn) => turn.items?.some((item) => item.type === "commandExecution")));
  assert.ok(snapshot.items.data.some((entry) => entry.item?.type === "commandExecution"));
});

test("Codex app-server driver injects MCP configuration without shell research credentials", async () => {
  const events = [];
  const driver = new CodexAppServerDriver({
    id: "fixture-codex",
    label: "Fixture Codex",
    provider: "codex",
    command: "node",
    args: [codexFixture],
    model: "gpt-5.6-luna",
  }, { requestTimeoutMs: 2_000, onEvent: (event) => events.push(event) });
  await driver.start({
    cwd: root,
    developerInstructions: "Topolumia MCP research",
    researchMcp: { name: "topolumia", command: process.execPath, args: [], cwd: root, env: { TOPOLUMIA_SESSION: "fixture-only" } },
  });
  const result = await driver.prompt({ turnId: "turn-cli", content: [{ type: "text", text: "检查当前实验" }] });
  assert.equal(result.stopReason, "end_turn");
  assert.ok(events.some((event) => event.type === "assistant.message.delta" && /MCP=ready; shellCredentials=absent; guidance=ready/.test(event.payload.delta)));
  await driver.close();
});

test("Codex app-server driver surfaces and resolves an approval request", async () => {
  const events = [];
  const driver = new CodexAppServerDriver({
    id: "fixture-codex",
    label: "Fixture Codex",
    provider: "codex",
    command: "node",
    args: [codexFixture],
    model: "gpt-5.6-luna",
  }, { env: { TOPOLUMIA_URL: "http://fixture", TOPOLUMIA_PROJECT_ID: "fixture", TOPOLUMIA_SESSION: "fixture-only" }, requestTimeoutMs: 2_000, onEvent: (event) => events.push(event) });
  await driver.start({ cwd: root });
  const prompt = driver.prompt({ turnId: "turn-approval", content: [{ type: "text", text: "approve this read-only check" }] });
  const approval = await waitFor(events, (event) => event.type === "approval.requested");
  assert.match(approval.payload.requestId, /^codex_approval_/);
  await driver.resolvePermission(approval.payload.requestId, "allow_once");
  const result = await prompt;
  assert.equal(result.stopReason, "end_turn");
  await driver.close();
});

for (const kind of ["permissions", "restricted", "withdraw"]) test(`Codex native approval ${kind} preserves scope and lifecycle`, async t => {
  const events = [];
  const driver = new CodexAppServerDriver({ id: "codex-permissions", label: "Codex", provider: "codex", command: process.execPath, args: [codexFixture], model: "gpt-6-luna" },
    { env: { CODEX_FIXTURE_APPROVAL_KIND: kind }, requestTimeoutMs: 2000, onEvent: e => events.push(e) });
  t.after(() => driver.close()); await driver.start({ cwd: root });
  const result = driver.prompt({ turnId: "approval", content: [{ type: "text", text: "approve" }] });
  const a = (await waitFor(events, e => e.type === "approval.requested")).payload;
  if (kind === "withdraw") {
    await result;
    assert.ok(events.some(e => e.type === "approval.resolved" && e.payload.requestId === a.requestId && e.payload.decision === "external"));
    await assert.rejects(driver.resolvePermission(a.requestId, "allow_once"), { code: "AGENT_APPROVAL_NOT_FOUND" }); return;
  }
  if (kind === "restricted") {
    assert.ok(!a.options.some(o => o.kind.startsWith("allow")));
    await assert.rejects(driver.resolvePermission(a.requestId, "allow_once"), { code: "AGENT_APPROVAL_OPTION_INVALID" });
    await driver.resolvePermission(a.requestId, "reject_once");
  } else {
    await assert.rejects(driver.resolvePermission(a.requestId, "allow_once", false, { permissionKeys: ["anything"] }), { code: "AGENT_APPROVAL_PERMISSION_INVALID" });
    await driver.resolvePermission(a.requestId, "allow_session", false, { permissionKeys: ["network"] });
  }
  await result;
  const answer = events.find(e => e.type === "assistant.message.delta").payload.delta;
  assert.deepEqual(JSON.parse(answer), kind === "restricted" ? { decision: "decline" } : { permissions: { network: { enabled: true } }, scope: "session" });
});

test("Codex cancels by native turn id and rebinds MCP on resume", async t => {
  const events = [];
  const driver = new CodexAppServerDriver({ id: "codex", label: "Codex", provider: "codex", command: process.execPath, args: [codexFixture] }, { requestTimeoutMs: 2000, onEvent: event => events.push(event) });
  t.after(() => driver.close());
  await driver.start({ cwd: root, resumeThreadId: "fixture-codex-thread", developerInstructions: "Topolumia MCP", researchMcp: { name: "topolumia", command: process.execPath, args: [], cwd: root, env: { TOPOLUMIA_SESSION: "fixture-only" } } });
  await driver.prompt({ turnId: "local-first", content: [{ type: "text", text: "Check binding" }] });
  assert.ok(events.some(event => event.payload.delta?.includes("MCP=ready; shellCredentials=absent; guidance=ready")));
  const pending = driver.prompt({ turnId: "local-id-is-not-native", content: [{ type: "text", text: "approve" }] });
  await waitFor(events, event => event.type === "approval.requested");
  driver.cancel();
  assert.equal((await pending).stopReason, "cancelled");
});

test("Codex closes its owned runtime when a native interrupt fails during approval", async t => {
  const events = [];
  const driver = new CodexAppServerDriver({ id: "codex-stop", label: "Codex", provider: "codex", command: process.execPath, args: [codexFixture] },
    { env: { CODEX_FIXTURE_INTERRUPT_FAIL: "1" }, requestTimeoutMs: 2000, onEvent: e => events.push(e) });
  t.after(() => driver.close()); await driver.start({ cwd: root });
  const result = driver.prompt({ turnId: "stop", content: [{ type: "text", text: "approve" }] });
  await waitFor(events, e => e.type === "approval.requested"); driver.cancel();
  assert.equal((await result).stopReason, "cancelled"); assert.equal(driver.closed, true); assert.equal(driver.process.closed, true);
  assert.ok(events.some(e => e.type === "approval.resolved" && e.payload.decision === "cancelled"));
});

test("Codex preserves summary paragraph indices and publishes authoritative final summaries", async t => {
  const events = [];
  const driver = new CodexAppServerDriver({ id: "codex-reasoning", label: "Fixture Codex", provider: "codex",
    command: process.execPath, args: [codexFixture] }, { requestTimeoutMs: 5_000, onEvent: event => events.push(event) });
  t.after(() => driver.close());
  await driver.start({ cwd: root });
  await driver.prompt({ turnId: "reasoning-turn", content: [{ type: "text", text: "reasoning-blocks" }] });
  const projected = compactConversationEvents(events.filter(e => e.type.startsWith("reasoning.")).map((e, i) => ({ ...e, id: `e${i}`, cursor: i, sessionId: "s", occurredAt: "" })));
  assert.equal(projected.length, 2);
  assert.deepEqual(projected.map(e => e.payload.summaryIndex), [0, 1]);
  assert.equal(projected[1].payload.text, "Second paragraph repaired");
});

