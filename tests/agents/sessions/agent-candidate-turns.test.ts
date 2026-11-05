import test from "node:test";
import assert from "node:assert/strict";
import { candidateTurnLinks, candidateTurn } from "../../../src/services/agents/agent-candidate-turns.js";

test("confirmed MCP writes link a candidate to its latest turn across native result wrappers", () => {
  const packet = { schemaVersion: "research-agent-result.v1", kind: "candidateReceipt", data: { candidateId: "candidate:a" } };
  const event = (cursor, turnId, rawOutput, type = "tool.completed") => ({ id: `e${cursor}`, sessionId: "session", turnId, cursor, type, occurredAt: "", payload: { toolCallId: `call-${cursor}`, title: "mcp__topolumia__create_candidate", rawOutput } });
  const session = { conversationEvents: [event(1, "first", { content: [{ type: "text", text: JSON.stringify(packet) }] }), event(2, "second", JSON.stringify([{ type: "text", text: JSON.stringify(packet) }]))] };
  const links = candidateTurnLinks(session);
  assert.equal(candidateTurn({ id: "candidate:a" }, session, links), "second");
  assert.equal(candidateTurnLinks({ events: [event(1, "first", packet, "tool.failed")] }).size, 0);
  assert.equal(candidateTurnLinks({ events: [event(1, "first", { ...packet, kind: "candidates" })] }).size, 0);
  assert.equal(candidateTurnLinks({ events: [{ ...event(1, "first", packet), payload: { ...event(1, "first", packet).payload, server: "other" } }] }).size, 0);
});

test("notes retain their source turn and historical proposals use creation time without borrowing another turn", () => {
  const session = { turns: [{ id: "first", startedAt: "2026-11-03T00:00:00Z", completedAt: "2026-11-03T00:01:00Z" }, { id: "second", startedAt: "2026-11-03T00:02:00Z", completedAt: "2026-11-03T00:03:00Z" }] };
  assert.equal(candidateTurn({ sourceTurnId: "first", createdAt: "2026-11-03T00:05:00Z" }, session, new Map()), "first");
  assert.equal(candidateTurn({ createdAt: "2026-11-03T00:02:30Z" }, session, new Map()), "second");
  assert.equal(candidateTurn({ createdAt: "2026-11-03T00:05:00Z" }, session, new Map()), null);
});
