import test from "node:test";
import assert from "node:assert/strict";
import { appendConversationEvent, compactConversationEvents } from "../../../src/domain/agents/agent-conversation.js";
import { restoreConversationEvents } from "../../../src/services/agents/agent-conversation-history.js";

const event = (cursor, type, payload = {}, turnId = "turn") => ({ id: `e${cursor}`, cursor, type, payload, turnId, sessionId: "s", occurredAt: "" });

test("stream updates index historical messages once and preserve immutable branches", () => {
  let reads = 0;
  const history = Array.from({ length: 1000 }, (_, index) => {
    const value = event(index + 1, "assistant.message.completed", { messageId: "old-" + index, text: "History" }, "old-" + index);
    const payload = value.payload;
    Object.defineProperty(value, "payload", { get() { reads++; return payload; } });
    return value;
  });
  let current = history;
  for (let index = 0; index < 100; index++) current = appendConversationEvent(current, event(1001 + index, "assistant.message.delta", { messageId: "live", delta: "a" }));
  assert.equal(current.at(-1).payload.delta, "a".repeat(100));
  assert.ok(reads < 4000, `Streaming repeatedly inspected old message payloads (${reads})`);
  const completed = appendConversationEvent(current, event(1200, "assistant.message.completed", { messageId: "live", text: "Final" }));
  const branch = appendConversationEvent(current, event(1201, "assistant.message.delta", { messageId: "live", delta: "b" }));
  assert.equal(branch.at(-1).payload.delta, "a".repeat(100) + "b");
  assert.equal(completed.at(-1).payload.text, "Final");
  assert.equal(current.at(-1).payload.delta, "a".repeat(100));
});

test("conversation compacts thousands of deltas without losing messages, ordering or tool boundaries", () => {
  let events = [event(1, "user.message", { text: "Original input" })];
  for (let i = 2; i < 2_002; i++) events = appendConversationEvent(events, event(i, "assistant.message.delta", { messageId: "first", delta: "文" }));
  events = appendConversationEvent(events, event(2_002, "tool.started", { toolCallId: "read", title: "Read" }));
  events = appendConversationEvent(events, event(2_003, "tool.completed", { toolCallId: "read", rawOutput: "Verified" }));
  events = appendConversationEvent(events, event(2_004, "assistant.message.completed", { messageId: "first", text: "Full authoritative text" }));
  events = appendConversationEvent(events, event(2_005, "assistant.message.completed", { messageId: "second", text: "Final answer" }));
  assert.equal(events.length, 5);
  assert.deepEqual(events.map(e => e.type), ["user.message", "assistant.message.completed", "tool.started", "tool.completed", "assistant.message.completed"]);
  assert.equal(events[1].payload.text, "Full authoritative text");
  assert.equal(events[1].id, "e2");
  assert.equal(events[1].payload.delta, undefined);
  assert.deepEqual(appendConversationEvent(events, event(2_006, "assistant.message.delta", { messageId: "first", delta: "late" })), events);
});

test("conversation preserves partial cancelled messages, reasoning and independent turn identities", () => {
  const events = compactConversationEvents([
    event(1, "reasoning.summary.delta", { messageId: "r", delta: "first " }),
    event(2, "reasoning.summary.delta", { messageId: "r", delta: "second" }),
    event(3, "assistant.message.delta", { messageId: "same", delta: "Partial" }),
    event(4, "turn.cancelled"),
    event(5, "assistant.message.completed", { messageId: "same", text: "Other turn" }, "next"),
  ]);
  assert.equal(events.length, 4);
  assert.equal(events[0].payload.delta, "first second");
  assert.equal(events[1].payload.delta, "Partial");
  assert.equal(events[3].payload.text, "Other turn");
});

test("anonymous tool parameter fragments remain in the raw trace without creating phantom conversation tools", () => {
  assert.deepEqual(compactConversationEvents([event(1, "tool.updated", { delta: "{\"query\":" })]), []);
});

test("truncated historical traces recover original input and full earlier messages from turn records", () => {
  const session = { id: "s", turns: [{ id: "turn", startedAt: "", input: [{ type: "text", text: "Original input" }],
    assistantMessages: [{ messageId: "early", text: "Early response", completed: true }, { messageId: "last", text: "Full final response", completed: true }] }],
    events: [event(500, "tool.completed", { toolCallId: "read" }), event(501, "assistant.message.delta", { messageId: "last", delta: "response" }), event(502, "turn.completed")] };
  const restored = restoreConversationEvents(session);
  assert.equal(restored[0].payload.text, "Original input");
  assert.deepEqual(restored.filter(e => e.type === "assistant.message.completed").map(e => e.payload.text), ["Early response", "Full final response"]);
  assert.equal(restored.at(-1).type, "turn.completed");
  assert.deepEqual(restoreConversationEvents({ ...session, conversationEvents: restored }), restored);
});

test("interrupted history recovers the full partial message even when only its suffix survived", () => {
  const restored = restoreConversationEvents({ id: "s", turns: [{ id: "turn", input: [{ type: "text", text: "Question" }],
    assistantMessages: [{ messageId: "partial", text: "Full partial message", completed: false }] }],
    events: [event(500, "assistant.message.delta", { messageId: "partial", delta: "message" })] });
  assert.equal(restored[0].payload.text, "Question");
  assert.equal(restored[1].payload.delta, "Full partial message");
});

test("reasoning snapshots replace deltas per native block without merging independent paragraphs or identical text", () => {
  const events = compactConversationEvents([
    event(1, "reasoning.summary.delta", { messageId: "m", summaryIndex: 0, delta: "partial " }),
    event(2, "reasoning.summary.delta", { messageId: "m", summaryIndex: 0, delta: "text" }),
    event(3, "reasoning.summary.completed", { messageId: "m", summaryIndex: 0, text: "Full text" }),
    event(4, "reasoning.summary.delta", { messageId: "m", summaryIndex: 0, delta: "late duplicate" }),
    event(5, "reasoning.summary.completed", { messageId: "m", summaryIndex: 1, text: "Full text" }),
    event(6, "reasoning.summary.completed", { messageId: "other", summaryIndex: 0, text: "Next phase" }),
  ]);
  assert.deepEqual(events.map(e => e.payload.text), ["Full text", "Full text", "Next phase"]);
  assert.ok(events.every(e => e.payload.delta === undefined));
});
