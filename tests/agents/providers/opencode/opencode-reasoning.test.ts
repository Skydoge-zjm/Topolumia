import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeTrace } from "../../../../src/adapters/agents/opencode/opencode-trace.js";
import { compactConversationEvents } from "../../../../src/domain/agents/agent-conversation.js";

test("OpenCode reasoning retains native part boundaries and final snapshot corrections without replay duplication", () => {
  const events = [];
  const trace = new OpenCodeTrace(e => events.push(e), () => "turn");
  const info = { id: "message", role: "assistant", sessionID: "session", time: { created: 1 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
  trace.message(info);
  const first = { id: "reason-a", type: "reasoning", messageID: "message", sessionID: "session", text: "Partial", time: { start: 1 } };
  trace.part(first);
  const final = { ...first, text: "Corrected final summary", time: { start: 1, end: 2 } };
  trace.part(final);
  const second = { ...final, id: "reason-b" };
  trace.part(second);
  trace.replay([{ info: { ...info, time: { created: 1, completed: 3 } }, parts: [final, second] }]);
  const projected = compactConversationEvents(events.map((e, i) => ({ ...e, id: `e${i}`, cursor: i, sessionId: "s", occurredAt: "" })));
  assert.deepEqual(projected.map(e => e.payload.text), ["Corrected final summary", "Corrected final summary"]);
  assert.equal(events.filter(e => e.type === "reasoning.summary.completed").length, 2);
});

test("removed OpenCode content stays removed through stale history and returns only on a native restore", () => {
  const events = [];
  const trace = new OpenCodeTrace(event => events.push(event), () => "turn");
  const info = { id: "message", role: "assistant", sessionID: "session", parentID: "user", time: { created: 1, completed: 3 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
  const part = { id: "text", type: "text", messageID: "message", sessionID: "session", text: "Old", time: { start: 1, end: 2 } };
  const current = () => compactConversationEvents(events.map((event, cursor) => ({ ...event, id: `e${cursor}`, cursor, sessionId: "session", occurredAt: "" })));
  trace.replay([{ info, parts: [part] }]);
  trace.removePart(part.id);
  trace.replay([{ info, parts: [part] }]);
  assert.ok(!current().some(event => event.type === "assistant.message.completed"));
  trace.part({ ...part, text: "Restored" }, true);
  assert.equal(current().find(event => event.type === "assistant.message.completed").payload.text, "Restored");
  trace.removeMessage(info.id); trace.replay([{ info, parts: [part] }]);
  assert.ok(!current().some(event => event.type === "assistant.message.completed"));
});
