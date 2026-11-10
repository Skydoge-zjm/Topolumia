import type { StoredAgentSession, AgentRuntimeSession, AgentTurn, AgentEvent } from "../../domain/agents/agent-types.js";
import { compactConversationEvents } from "../../domain/agents/agent-conversation.js";
import { publicAgentAttachment } from "../../domain/agents/agent-attachments.js";

// Turn records retain the original input and full message bodies even when an
// older raw trace has already rolled over. Recover only those known messages;
// deleted tool diagnostics cannot be reconstructed from them.
export function restoreConversationEvents(session: Pick<StoredAgentSession | AgentRuntimeSession, "id" | "createdAt" | "provider" | "turns" | "events"> & { conversationEvents?: AgentEvent[] }): AgentEvent[] {
  if (Array.isArray(session.conversationEvents)) return compactConversationEvents(structuredClone(session.conversationEvents));
  const raw = session.events ?? [];
  if (raw.length && raw[0].cursor <= 1) return compactConversationEvents(raw);
  const result = raw.filter(event => !event.turnId && event.type !== "session.closed");
  const turns = session.turns ?? [];
  const knownTurns = new Set(turns.map(turn => turn.id));
  const recovered = (turn: AgentTurn, type: string, payload: AgentEvent["payload"], suffix: string) => ({
    schemaVersion: "agent-session-event.v1", id: `recovered:${turn.id}:${suffix}`,
    cursor: 0, sessionId: session.id, turnId: turn.id, type,
    occurredAt: turn.startedAt ?? session.createdAt, provider: session.provider, payload,
  });
  for (const turn of turns) {
    const events = raw.filter(event => event.turnId === turn.id);
    if (!events.some(event => event.type === "user.message")) {
      const text = (turn.input ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
      if (text || turn.attachments?.length) result.push(recovered(turn, "user.message", { text, ...(turn.attachments?.length ? { attachments: turn.attachments.map(publicAgentAttachment) } : {}) }, "user"));
    }
    const messages = turn.assistantMessages?.length ? turn.assistantMessages
      : turn.assistantText ? [{ messageId: `turn:${turn.id}`, text: turn.assistantText, completed: Boolean(turn.completedAt) }] : [];
    // Insert missing early messages before the retained tail, then repair any
    // incomplete retained stream using the full body in its turn record.
    for (const message of messages) {
      if (!events.some(event => event.type.startsWith("assistant.message.") && (event.payload?.messageId ?? event.payload?.nativeItemId) === message.messageId)) {
        result.push(recovered(turn, message.completed ? "assistant.message.completed" : "assistant.message.delta",
          { messageId: message.messageId, ...(message.completed ? { text: message.text } : { delta: message.text }) }, `assistant:${message.messageId}`));
      }
    }
    const terminal = events.filter(event => ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.type));
    result.push(...events.filter(event => !terminal.includes(event)));
    for (const message of messages) {
      if (message.completed) result.push(recovered(turn, "assistant.message.completed", { messageId: message.messageId, text: message.text }, `final:${message.messageId}`));
    }
    result.push(...terminal);
  }
  result.push(...raw.filter(event => event.turnId && !knownTurns.has(event.turnId)));
  result.push(...raw.filter(event => !event.turnId && event.type === "session.closed"));
  const restored = compactConversationEvents(result);
  for (const turn of turns) for (const message of turn.assistantMessages ?? []) {
    const event = restored.find(event => event.turnId === turn.id && event.type === "assistant.message.delta" && event.payload.messageId === message.messageId);
    if (event) event.payload.delta = message.text;
  }
  return restored;
}
