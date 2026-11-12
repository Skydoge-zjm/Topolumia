import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeV2Trace } from "../../../../../src/adapters/agents/opencode/v2/opencode-trace.js";

test("V2 final snapshots correct streamed text while retaining native ordinals and usage identity", () => {
  const events = [], trace = new OpenCodeV2Trace(event => events.push(event));
  const packet = (type, data) => trace.event({ id: `evt_${events.length}`, created: 1, type, data: { sessionID: "ses", assistantMessageID: "msg", ...data } } as never, "turn", "user");
  packet("session.text.delta", { ordinal: 0, delta: "Partial" });
  packet("session.text.ended", { ordinal: 0, text: "Authoritative answer" });
  packet("session.text.delta", { ordinal: 0, delta: "stale delta" });
  const message = { id: "msg", type: "assistant", agent: "build", model: { id: "model", providerID: "fixture" }, time: { created: 1, completed: 2 },
    content: [{ type: "text", text: "Corrected answer" }], tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }, cost: 0.1 };
  trace.message(message as never, "turn", "user"); trace.message(message as never, "turn", "user");
  assert.equal(events.filter(event => event.type === "assistant.message.completed").at(-1).payload.text, "Corrected answer");
  assert.equal(events.filter(event => event.type === "assistant.message.delta").map(event => event.payload.delta).join(""), "Partial");
  assert.equal(events.filter(event => event.type === "usage.updated").length, 1);
  assert.ok(events.every(event => event.payload.nativeParentId === "user"));
});
