import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenCodeV2Fixture } from "../../../../../fixtures/native/opencode/v2/server.js";
import { OpenCodeV2AgentAdapter } from "../../../../../src/adapters/agents/opencode/v2/opencode-agent-adapter.js";
import { readOpenCodeV2Messages } from "../../../../../src/adapters/agents/opencode/v2/opencode-history.js";

test("V2 reconnect repairs offline reasoning, tools and final text exactly once", { timeout: 10_000 }, async t => {
  const f = await createOpenCodeV2Fixture(), events = [];
  const adapter = new OpenCodeV2AgentAdapter({ id: "v2", label: "V2", provider: "opencode", command: "fixture" }, { serverFactory: () => ({ start: async () => f.client, close: async () => {} }) as never, onEvent: event => events.push(event) });
  t.after(async () => { await adapter.close(); await f.close(); });
  const started = await adapter.start();
  const pending = adapter.prompt({ turnId: "recover", content: [{ type: "text", text: "hold" }] });
  while (!f.calls.some(call => call.path.endsWith("/prompt"))) await delay(5);
  await delay(20); f.disconnect();
  const message = f.assistant(started.nativeSessionId);
  f.content(started.nativeSessionId, message, "reasoning", "Offline reasoning"); f.tool(started.nativeSessionId, message);
  f.content(started.nativeSessionId, message, "text", "Recovered final"); f.finish(started.nativeSessionId, message);
  assert.equal((await pending).stopReason, "end_turn");
  assert.equal(events.filter(event => event.type === "assistant.message.completed" && event.payload.text === "Recovered final").length, 1);
  assert.equal(events.filter(event => event.type === "tool.completed").length, 1);
  assert.equal(events.filter(event => event.type === "usage.updated" && event.payload.scope === "step").length, 1);
  assert.ok(f.calls.some(call => call.path.endsWith("/log")));
});

test("V2 history follows opaque cursors without sending order twice", async t => {
  const f = await createOpenCodeV2Fixture(); t.after(() => f.close());
  const session = await f.client.session.create();
  f.sessions.get(session.id).messages = Array.from({ length: 215 }, (_, i) => ({ id: `msg_${i}`, type: "user", text: String(i), time: { created: i } }));
  const messages = await readOpenCodeV2Messages(f.client, session.id);
  assert.equal(messages.length, 215); assert.equal(new Set(messages.map(message => message.id)).size, 215);
  assert.ok(f.calls.filter(call => call.query.cursor).every(call => call.query.order === undefined));
});
