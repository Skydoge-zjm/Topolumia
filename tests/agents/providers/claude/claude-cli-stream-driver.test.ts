import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compactConversationEvents } from "../../../../src/domain/agents/agent-conversation.js";
import { ClaudeCliStreamDriver } from "../../../../src/adapters/agents/claude/claude-cli-stream-driver.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const claudeFixture = path.join(root, "fixtures", "native", "claude-cli.js");

async function permissionFixture(t, timeout = 2000) {
  const events = [];
  const driver = new ClaudeCliStreamDriver({ id: "claude-approval", label: "Claude Code", provider: "claude", command: process.execPath, launcherArgs: [claudeFixture], model: "gpt-6-luna" }, { requestTimeoutMs: timeout, onEvent: event => events.push(event) });
  t.after(() => driver.close()); await driver.start({ cwd: root });
  const wait = async (count = 1) => { for (let n = 0; n < 250; n++) { const a = events.filter(e => e.type === "approval.requested"); if (a.length >= count) return a; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("Missing native permission"); };
  return { driver, events, wait };
}

test("Claude duplex approval waits beyond execution timeout and carries session-only grants into the next CLI process", async t => {
  const f = await permissionFixture(t, 1000);
  const result = f.driver.prompt({ turnId: "approval", content: [{ type: "text", text: "approval-check" }] });
  const [a] = await f.wait();
  await new Promise(resolve => setTimeout(resolve, 1150));
  await f.driver.resolvePermission(a.payload.requestId, "allow_session");
  assert.equal((await result).stopReason, "end_turn");
  assert.ok(f.events.some(e => e.type === "assistant.message.completed" && e.payload.text.includes('"behavior":"allow"')));
  await f.driver.prompt({ turnId: "next", content: [{ type: "text", text: "approval-settings" }] });
  const settings = JSON.parse(f.events.filter(e => e.type === "assistant.message.completed").at(-1).payload.text);
  assert.deepEqual(settings.settings.permissions.allow, ["Bash(python experiment.py --dry-run)"]);
  assert.equal(settings.permissionMode, "default");
});

test("Claude handles parallel permission IDs, native withdrawal and stop without hanging", async t => {
  const f = await permissionFixture(t);
  const parallel = f.driver.prompt({ turnId: "parallel", content: [{ type: "text", text: "approval-parallel" }] });
  const requests = await f.wait(2);
  await f.driver.resolvePermission(requests[0].payload.requestId, "allow_once");
  assert.equal(f.driver.permissionHost.pending.size, 1);
  await f.driver.resolvePermission(requests[1].payload.requestId, "reject_once");
  assert.equal((await parallel).stopReason, "end_turn");
  const withdrawn = f.driver.prompt({ turnId: "withdraw", content: [{ type: "text", text: "approval-withdraw" }] });
  const third = (await f.wait(3))[2]; await withdrawn;
  assert.ok(f.events.some(e => e.type === "approval.resolved" && e.payload.requestId === third.payload.requestId && e.payload.decision === "expired"));
  const stopped = f.driver.prompt({ turnId: "stop", content: [{ type: "text", text: "approval-check" }] });
  await f.wait(4); f.driver.cancel(); assert.equal((await stopped).stopReason, "cancelled");
});

test("Claude's explicitly approved edit mode survives per-turn processes without writing settings", async t => {
  const f = await permissionFixture(t);
  const result = f.driver.prompt({ turnId: "mode", content: [{ type: "text", text: "approval-edits" }] });
  const [a] = await f.wait(); await f.driver.resolvePermission(a.payload.requestId, "allow_session_edits"); await result;
  await f.driver.prompt({ turnId: "next", content: [{ type: "text", text: "approval-settings" }] });
  const settings = JSON.parse(f.events.filter(e => e.type === "assistant.message.completed").at(-1).payload.text);
  assert.equal(settings.permissionMode, "acceptEdits"); assert.equal(settings.settings, null);
});

test("Claude receives MCP configuration and guidance without shell credentials on every native turn", async t => {
  const events = [];
  const driver = new ClaudeCliStreamDriver({ id: "claude", label: "Claude", provider: "claude", command: process.execPath, launcherArgs: [claudeFixture], env: { CLAUDE_FIXTURE_CHECK_BINDING: "1" } }, { requestTimeoutMs: 2000, onEvent: event => events.push(event) });
  t.after(() => driver.close());
  await driver.start({ cwd: root, developerInstructions: "Topolumia MCP", researchMcp: { name: "topolumia", command: process.execPath, args: [], cwd: root, env: { TOPOLUMIA_SESSION: "fixture-only" } } });
  for (let i = 0; i < 2; i++) await driver.prompt({ turnId: `claude-${i}`, content: [{ type: "text", text: "Check binding" }] });
  assert.equal(events.filter(event => event.type === "assistant.message.completed" && event.payload.text === "MCP=ready; shellCredentials=absent; guidance=ready").length, 2);
});

test("Claude uses the profile model by default and honors explicit per-turn overrides", async t => {
  const events = [];
  const driver = new ClaudeCliStreamDriver({ id: "claude-model", label: "Claude", provider: "claude", command: process.execPath,
    launcherArgs: [claudeFixture], model: "gpt-6-luna", reasoningEffort: "low" }, { requestTimeoutMs: 2000, onEvent: event => events.push(event) });
  t.after(() => driver.close());
  await driver.start({ cwd: root });
  await driver.prompt({ turnId: "default", content: [{ type: "text", text: "model-bind" }] });
  await driver.prompt({ turnId: "override", model: "explicit-model", reasoningEffort: "high", content: [{ type: "text", text: "model-bind" }] });
  const actual = events.filter(event => event.type === "assistant.message.completed").map(event => JSON.parse(event.payload.text));
  assert.deepEqual(actual, [{ model: "gpt-6-luna", effort: "low" }, { model: "explicit-model", effort: "high" }]);
});

test("Claude CLI stream driver consumes official stream-json shaped messages and resumes", async () => {
  const events = [];
  const driver = new ClaudeCliStreamDriver({
    id: "fixture-claude",
    label: "Fixture Claude",
    provider: "claude",
    command: "node",
    launcherArgs: [claudeFixture],
    allowedTools: ["Read"],
  }, { env: { TOPOLUMIA_URL: "http://fixture", TOPOLUMIA_PROJECT_ID: "fixture", TOPOLUMIA_SESSION: "fixture-only" }, requestTimeoutMs: 2_000, onEvent: (event) => events.push(event) });
  const started = await driver.start({ cwd: root });
  assert.match(started.nativeSessionId, /^[0-9a-f-]{36}$/);
  const first = await driver.prompt({ turnId: "turn-1", content: [{ type: "text", text: "检查当前实验" }] });
  assert.equal(first.stopReason, "end_turn");
  assert.ok(events.some((event) => event.type === "provider.event" && event.payload.kind === "init"));
  assert.ok(events.some((event) => event.type === "assistant.message.delta"));
  assert.ok(events.some((event) => event.type === "tool.started"));
  assert.ok(events.some((event) => event.type === "tool.completed"));
  const second = await driver.prompt({ turnId: "turn-2", content: [{ type: "text", text: "继续" }] });
  assert.equal(second.stopReason, "end_turn");
  await driver.close();
});

test("Claude CLI stream driver keeps a stable message boundary when stream deltas omit message ids", async () => {
  const events = [];
  const driver = new ClaudeCliStreamDriver({
    id: "fixture-claude-no-message-id",
    label: "Fixture Claude",
    provider: "claude",
    command: process.execPath,
    launcherArgs: [claudeFixture],
    env: { CLAUDE_FIXTURE_OMIT_MESSAGE_ID: "1" },
    allowedTools: ["Read"],
  }, { env: { TOPOLUMIA_URL: "http://fixture", TOPOLUMIA_PROJECT_ID: "fixture", TOPOLUMIA_SESSION: "fixture-only" }, requestTimeoutMs: 2_000, onEvent: (event) => events.push(event) });
  await driver.start({ cwd: root });
  const result = await driver.prompt({ turnId: "turn-no-message-id", content: [{ type: "text", text: "检查当前实验" }] });
  assert.equal(result.stopReason, "end_turn");
  const assistantDeltas = events.filter((event) => event.type === "assistant.message.delta");
  assert.ok(assistantDeltas.length > 0);
  assert.equal(new Set(assistantDeltas.map((event) => event.payload.messageId)).size, 1);
  const reasoningDeltas = events.filter((event) => event.type === "reasoning.summary.delta");
  assert.ok(reasoningDeltas.length > 0);
  assert.equal(new Set(reasoningDeltas.map((event) => event.payload.messageId)).size, 1);
  await driver.close();
});

test("Claude associates streamed JSON parameters with the correct parallel tool blocks", async () => {
  const events = [];
  const driver = new ClaudeCliStreamDriver({ id: "fixture-claude-tools", label: "Fixture Claude", provider: "claude",
    command: process.execPath, launcherArgs: [claudeFixture] }, { requestTimeoutMs: 5_000, onEvent: event => events.push(event) });
  await driver.start({ cwd: root });
  try {
    for (const turnId of ["one", "two"]) {
      await driver.prompt({ turnId, content: [{ type: "text", text: "long-stream" }] });
      const tools = events.filter(e => e.turnId === turnId && e.type.startsWith("tool."));
      assert.deepEqual(tools.filter(e => e.type === "tool.started").map(e => e.payload.toolCallId), ["read-a", "read-b"]);
      assert.deepEqual(tools.filter(e => e.type === "tool.updated" && e.payload.delta).map(e => e.payload.toolCallId), ["read-a", "read-b"]);
      assert.equal(tools.filter(e => e.type === "tool.completed").length, 2);
      assert.ok(tools.every(e => ["read-a", "read-b"].includes(e.payload.toolCallId)));
    }
  } finally { await driver.close(); }
});

test("Claude preserves native thinking blocks and replaces streamed text with final partial snapshots once", async t => {
  const events = [];
  const driver = new ClaudeCliStreamDriver({ id: "claude-reasoning", label: "Fixture Claude", provider: "claude",
    command: process.execPath, launcherArgs: [claudeFixture] }, { requestTimeoutMs: 5_000, onEvent: event => events.push(event) });
  t.after(() => driver.close());
  await driver.start({ cwd: root });
  await driver.prompt({ turnId: "reasoning-turn", content: [{ type: "text", text: "reasoning-blocks" }] });
  const complete = events.filter(e => e.type === "reasoning.summary.completed");
  const unique = new Set(complete.map(e => e.payload.reasoningId));
  assert.equal(unique.size, 4);
  const projected = compactConversationEvents(events.filter(e => e.type.startsWith("reasoning.")).map((e, i) => ({ ...e, id: `e${i}`, cursor: i, sessionId: "s", occurredAt: "" })));
  assert.deepEqual(projected.map(e => e.payload.text), ["**Check source****Check version**", "**Repeated native phase**", "**Repeated native phase**", "**Snapshot-only phase**"]);
  assert.deepEqual(projected.slice(0, 3).map(e => e.payload.blockIndex), [0, 2, 3]);
});

