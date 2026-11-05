import test from "node:test";
import assert from "node:assert/strict";
import { compactTraceEvents } from "../../../src/domain/agents/agent-trace.js";
import { compactConversationEvents } from "../../../src/domain/agents/agent-conversation.js";

const event = (cursor, type, payload = {}, turnId = "turn") => ({ id: `e${cursor}`, cursor, sessionId: "s", turnId, type, payload, occurredAt: "" });

test("thousands of streamed fragments produce one final trace output with no delta payload", () => {
  const events = Array.from({ length: 1500 }, (_, index) => event(index + 1, "assistant.message.delta", { messageId: "m", delta: "文" }));
  events.push(event(1501, "assistant.message.completed", { messageId: "m", text: "Final authoritative output" }));
  const trace = compactTraceEvents(events);
  assert.equal(trace.length, 1);
  assert.equal(trace[0].type, "assistant.message.completed");
  assert.equal(trace[0].payload.text, "Final authoritative output");
  assert.equal(trace[0].payload.delta, undefined);
  assert.equal(trace[0].cursor, 1501);
});

test("final tool records preserve the command, complete input and authoritative result once", () => {
  const trace = compactTraceEvents([
    event(1, "tool.started", { toolCallId: "call", title: "Read", kind: "Read", rawInput: {} }),
    event(2, "tool.updated", { toolCallId: "call", deltaField: "input", delta: '{"file":' }),
    event(3, "tool.updated", { toolCallId: "call", rawInput: { file: "research.md" }, updateKind: "snapshot" }),
    event(4, "tool.completed", { toolCallId: "call", kind: "tool_result", rawOutput: "Verified source" }),
  ]);
  assert.equal(trace.length, 1);
  assert.equal(trace[0].type, "tool.completed");
  assert.equal(trace[0].payload.kind, "Read");
  assert.deepEqual(trace[0].payload.rawInput, { file: "research.md" });
  assert.equal(trace[0].payload.rawOutput, "Verified source");
  assert.equal(trace[0].payload.delta, undefined);
});

test("the authoritative final command output repairs a missing streamed suffix", () => {
  const conversation = compactConversationEvents([
    event(1, "tool.started", { toolCallId: "call", item: { command: "evaluate" } }),
    event(2, "tool.updated", { toolCallId: "call", delta: "Partial" }),
    event(3, "tool.completed", { toolCallId: "call", item: { aggregatedOutput: "Full authoritative output" } }),
  ]);
  const trace = compactTraceEvents(conversation);
  assert.equal(trace[0].payload.rawOutput, "Full authoritative output");
  assert.ok(conversation.every(record => record.type !== "tool.updated"));
});

test("a reconnect snapshot replaces old pending tool fragments instead of replaying them twice", () => {
  const conversation = compactConversationEvents([
    event(1, "tool.started", { toolCallId: "call", title: "Run" }),
    event(2, "tool.updated", { toolCallId: "call", delta: "old" }),
    event(3, "tool.updated", { toolCallId: "call", rawOutput: "old and complete", updateKind: "snapshot" }),
  ]);
  const trace = compactTraceEvents(conversation);
  assert.equal(trace[0].payload.rawOutput, "old and complete");
  assert.ok(!conversation.some(record => record.payload.delta !== undefined));
});

test("terminal state finalizes unfinished output and tool input without inventing success", () => {
  const trace = compactTraceEvents([
    event(1, "reasoning.summary.delta", { messageId: "r", delta: "Partial reasoning" }),
    event(2, "tool.started", { toolCallId: "call", title: "Read" }),
    event(3, "turn.cancelled"),
  ]);
  assert.equal(trace[0].type, "reasoning.summary.completed");
  assert.equal(trace[0].payload.completion, "interrupted");
  assert.equal(trace[1].type, "tool.failed");
  assert.equal(trace[1].payload.completion, "interrupted");
});

test("final trace keeps distinct turns and actors while discarding native transport frames", () => {
  const trace = compactTraceEvents([
    event(1, "native.trace", { frame: "discard" }),
    event(2, "assistant.message.completed", { messageId: "m", text: "Main" }),
    event(3, "assistant.message.completed", { messageId: "m", agentId: "child", text: "Child" }),
    event(4, "assistant.message.completed", { messageId: "m", text: "Next" }, "next"),
  ]);
  assert.deepEqual(trace.map(record => record.payload.text), ["Main", "Child", "Next"]);
});
