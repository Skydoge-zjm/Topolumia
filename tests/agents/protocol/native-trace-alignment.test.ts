import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { ClaudeTrace } from "../../../src/adapters/agents/claude/claude-trace.js";
import { compactTraceEvents } from "../../../src/domain/agents/agent-trace.js";
import { claudeTokenCounts, tokenCountDelta } from "../../../src/domain/agents/agent-usage.js";

test("all ten native protocol audit scenarios satisfy the shared conversation contract", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.resolve("scripts/diagnostics/audit-native-traces.mjs"), "--assert-fixed"],
    { cwd: process.cwd(), timeout: 45_000, maxBuffer: 512_000, windowsHide: true });
  const report = JSON.parse(stdout);
  assert.equal(report.findings.length, 10);
  assert.ok(report.findings.every(finding => !finding.reproduced), JSON.stringify(report.findings.filter(finding => finding.reproduced)));
});

test("Claude cut-off tool input is incomplete and can never be shown as a successful tool result", () => {
  const events = [];
  const trace = new ClaudeTrace((type, payload) => events.push({ type, payload }), "turn");
  const stream = event => trace.consume({ type: "stream_event", event });
  stream({ type: "message_start", message: { id: "message" } });
  stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name: "Read" } });
  stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":' } });
  stream({ type: "message_stop" }); trace.finish("interrupted");
  assert.equal(events.filter(event => event.type === "tool.failed").length, 1);
  assert.equal(events.find(event => event.type === "tool.failed").payload.completion, "incomplete");
  assert.ok(!events.some(event => event.type === "tool.completed"));
});

test("Claude authoritative late block repairs a cut stream using the original block identity", () => {
  const events = [];
  const trace = new ClaudeTrace((type, payload) => events.push({ type, payload }), "turn");
  trace.consume({ type: "stream_event", event: { type: "message_start", message: { id: "message" } } });
  trace.consume({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial" } } });
  trace.consume({ type: "stream_event", event: { type: "message_stop" } });
  trace.consume({ type: "assistant", uuid: "final", message: { id: "message", content: [{ type: "text", text: "Full authoritative text" }] } });
  const blocks = events.filter(event => event.type.startsWith("assistant.message."));
  assert.equal(new Set(blocks.map(event => event.payload.blockId)).size, 1);
  assert.equal(blocks.at(-1).payload.text, "Full authoritative text");
});

test("native frames and token fragments never become durable trace rows", () => {
  const result = compactTraceEvents([
    { id: "raw", cursor: 1, sessionId: "s", type: "native.trace", payload: { frame: { text: "discard" } }, occurredAt: "" },
    { id: "delta", cursor: 2, sessionId: "s", type: "assistant.message.delta", payload: { messageId: "m", delta: "partial" }, occurredAt: "" },
    { id: "final", cursor: 3, sessionId: "s", type: "assistant.message.completed", payload: { messageId: "m", text: "Full output" }, occurredAt: "" },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "assistant.message.completed");
  assert.equal(result[0].payload.text, "Full output");
  assert.equal(result[0].payload.delta, undefined);
});

test("session counters derive turn usage only from a known monotonic baseline", () => {
  const previous = claudeTokenCounts({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 });
  const total = claudeTokenCounts({ input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 200, cache_creation_input_tokens: 40 });
  assert.deepEqual(tokenCountDelta(total, previous), previous);
  assert.equal(tokenCountDelta(total), undefined);
  assert.equal(tokenCountDelta(previous, total), undefined);
});

test("an output-limit result marks the final native block incomplete without altering prior complete blocks", () => {
  const events = [];
  const trace = new ClaudeTrace((type, payload) => events.push({ type, payload }), "turn");
  for (const [id, text] of [["one", "Preface"], ["two", "Truncated answer"]]) trace.consume({ type: "assistant", uuid: id,
    message: { id, content: [{ type: "text", text }] } });
  trace.finish("incomplete");
  const last = events.filter(event => event.type === "assistant.message.completed").at(-1);
  assert.equal(last.payload.text, "Truncated answer");
  assert.equal(last.payload.completion, "incomplete");
  assert.equal(events[0].payload.completion, "completed");
});

test("parallel Claude tasks sharing a tool call keep their own agent identities and names", () => {
  const events = [];
  const trace = new ClaudeTrace((type, payload) => events.push({ type, payload }), "turn");
  for (const [id, name] of [["a", "Research A"], ["b", "Research B"]]) trace.consume({ type: "system", subtype: "task_started", task_id: id, tool_use_id: "shared", description: name });
  for (const id of ["a", "b"]) trace.consume({ type: "assistant", uuid: id, agent_id: id, parent_tool_use_id: "shared",
    message: { id, content: [{ type: "text", text: id }] } });
  const messages = events.filter(event => event.type === "assistant.message.completed");
  assert.deepEqual(messages.map(event => [event.payload.agentId, event.payload.agentName]), [["a", "Research A"], ["b", "Research B"]]);
});
