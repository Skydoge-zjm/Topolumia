// The conversation is a durable projection of meaningful events. Raw provider
// traces have a separate retention limit; token-sized deltas must not evict it.
export type AgentCompletion = "streaming" | "completed" | "interrupted" | "incomplete" | "failed";
export interface AgentContentMetadata {
  nativeSessionId?: string | null;
  nativeTurnId?: string | null;
  nativeMessageId?: string | null;
  nativeItemId?: string | null;
  nativeEventId?: string | null;
  packetUuid?: string | null;
  blockId?: string | null;
  blockIndex?: number;
  agentId?: string | null;
  agentName?: string | null;
  parentAgentId?: string | null;
  parentToolUseId?: string | null;
  phase?: string | null;
  completion?: AgentCompletion;
  updateKind?: "delta" | "snapshot" | "removed";
  restored?: boolean;
}
export interface ConversationEvent {
  id: string;
  cursor: number;
  updatedCursor?: number;
  sessionId: string;
  turnId?: string | null;
  type: string;
  occurredAt: string;
  provider?: string | null;
  payload: Record<string, unknown>;
}

const retainedTypes = new Set([
  "user.message", "assistant.message.delta", "assistant.message.snapshot", "assistant.message.completed",
  "reasoning.summary.delta", "reasoning.summary.snapshot", "reasoning.summary.completed", "tool.started", "tool.updated", "tool.completed", "tool.failed",
  "plan.updated", "approval.requested", "approval.resolved", "session.status", "session.closed",
  "turn.started", "turn.completed", "turn.cancelled", "turn.failed", "turn.retrying",
  "agent.activity", "agent.delegated", "files.changed", "agent.question.unsupported", "content.removed",
]);

export function actorKey(payload: Record<string, unknown>): string {
  return String(payload.agentId ?? payload.parentToolUseId ?? "main");
}

export function contentBlockId(payload: Record<string, unknown>): string {
  return String(payload.blockId ?? payload.messageId ?? payload.nativeItemId ?? "default");
}

export function isRemovedContent(event: Pick<ConversationEvent, "type" | "payload">, removal: Pick<ConversationEvent, "payload">): boolean {
  if (event.type === "content.removed") return false;
  const payload = event.payload;
  if (removal.payload.agentId && actorKey(payload) !== actorKey(removal.payload)) return false;
  if (!removal.payload.targetId && removal.payload.nativeMessageId && payload.nativeMessageId === removal.payload.nativeMessageId) return true;
  const id = removal.payload.targetId;
  return Boolean(id && [payload.blockId, payload.messageId, payload.nativeItemId, payload.toolCallId].includes(id));
}

export function reasoningStreamKey(event: Pick<ConversationEvent, "turnId" | "payload"> & Partial<Pick<ConversationEvent, "id">>): string {
  const payload = event.payload;
  const identity = payload.reasoningId ?? payload.messageId ?? payload.nativeItemId ?? event.id;
  return `reasoning:${event.turnId ?? "session"}:${actorKey(payload)}:${identity}:${payload.channel ?? "summary"}:${payload.summaryIndex ?? payload.blockIndex ?? 0}`;
}

function streamKey(event: ConversationEvent): string | null {
  const payload = event.payload;
  const turn = `${event.turnId ?? "session"}:${actorKey(payload)}`;
  if (event.type.startsWith("assistant.message.")) return `assistant:${turn}:${contentBlockId(payload)}`;
  if (event.type.startsWith("reasoning.summary.")) return reasoningStreamKey(event);
  if (event.type.startsWith("tool.")) {
    const item = payload.item as { id?: string } | undefined;
    return `${event.type}:${turn}:${payload.toolCallId ?? item?.id ?? event.id}`;
  }
  if (event.type === "plan.updated") return `plan:${turn}:${payload.planId ?? payload.itemId ?? payload.nativeItemId ?? "turn-plan"}`;
  if (event.type === "agent.activity") return `agent:${turn}`;
  if (event.type === "content.removed") return `removed:${payload.targetId ?? payload.nativeMessageId}`;
  return null;
}

type ConversationIndex = { length: number; keys: Map<string, number>; removals: ConversationEvent[] };
const conversationIndexes = new WeakMap<ConversationEvent[], ConversationIndex>();
function conversationIndex(events: ConversationEvent[]): ConversationIndex {
  let index = conversationIndexes.get(events);
  if (!index || index.length !== events.length) {
    index = { length: events.length, keys: new Map(), removals: [] };
    const directory = index;
    events.forEach((event, position) => {
      const key = streamKey(event);
      if (key !== null && !directory.keys.has(key)) directory.keys.set(key, position);
      if (event.type === "content.removed") directory.removals.push(event);
    });
    conversationIndexes.set(events, index);
  }
  return index;
}
export function isConversationContentRemoved(events: ConversationEvent[], event: Pick<ConversationEvent, "type" | "payload">): boolean {
  return conversationIndex(events).removals.some(removal => isRemovedContent(event, removal));
}
function indexConversation<T extends ConversationEvent>(previous: T[], next: T[], index: ConversationIndex, key: string | null, position: number): T[] {
  // Only the newest array owns the mutable index. Branching from an older
  // immutable snapshot rebuilds its index instead of sharing stale positions.
  conversationIndexes.delete(previous);
  if (key !== null) index.keys.set(key, position);
  index.length = next.length;
  conversationIndexes.set(next, index);
  return next;
}

export function appendConversationEvent<T extends ConversationEvent>(events: T[], event: T): T[] {
  if (!retainedTypes.has(event.type)) return events;
  if (event.type === "content.removed") {
    return [...events.filter(existing => !isRemovedContent(existing, event) && !(existing.type === "content.removed" && streamKey(existing) === streamKey(event))), event];
  }
  if (event.payload.restored) events = events.filter(existing => existing.type !== "content.removed" || !isRemovedContent(event, existing));
  if (isConversationContentRemoved(events, event)) return events;
  if (event.type === "tool.updated" && !event.payload.toolCallId && !(event.payload.item as { id?: string } | undefined)?.id) return events;
  if (event.type === "tool.completed" || event.type === "tool.failed") {
    const call = event.payload.toolCallId ?? (event.payload.item as { id?: string } | undefined)?.id;
    const sameCall = (candidate: T) => candidate.turnId === event.turnId && actorKey(candidate.payload) === actorKey(event.payload)
      && call && (candidate.payload.toolCallId ?? (candidate.payload.item as { id?: string } | undefined)?.id) === call;
    const started = events.find(candidate => candidate.type === "tool.started" && sameCall(candidate));
    const updated = events.find(candidate => candidate.type === "tool.updated" && sameCall(candidate));
    const item = { ...(started?.payload.item as object ?? {}), ...(updated?.payload.item as object ?? {}), ...(event.payload.item as object ?? {}) };
    const payload = { ...started?.payload, ...updated?.payload, ...event.payload };
    if (Object.keys(item).length) payload.item = item;
    const finalItem = event.payload.item as Record<string, unknown> | undefined;
    const output = event.payload.rawOutput ?? finalItem?.aggregatedOutput ?? finalItem?.output;
    if (output !== undefined) payload.rawOutput = output;
    if (event.payload.rawInput === undefined && (finalItem?.arguments !== undefined || finalItem?.input !== undefined)) delete payload.rawInput;
    if (updated?.payload.deltaField === "input" && payload.rawInput === undefined) payload.rawInput = updated.payload.delta;
    if (updated?.payload.deltaField !== "input" && payload.rawOutput === undefined) payload.rawOutput = updated?.payload.delta;
    delete payload.delta;
    delete payload.deltaField;
    event = { ...event, payload };
    events = events.filter(candidate => candidate.type !== "tool.updated" || !sameCall(candidate));
  }
  const key = streamKey(event);
  const directory = conversationIndex(events);
  const index = key === null ? -1 : (directory.keys.get(key) ?? -1);
  if (index < 0) return indexConversation(events, [...events, event], directory, key, events.length);
  const previous = events[index];
  const payload = { ...previous.payload, ...event.payload };
  if (event.type === "assistant.message.delta" || event.type === "reasoning.summary.delta") {
    // Late deltas cannot reopen or duplicate an authoritative final message.
    if (previous.type.endsWith(".completed")) return events;
    payload.delta = `${previous.payload.delta ?? previous.payload.text ?? ""}${event.payload.delta ?? ""}`;
    delete payload.text;
  } else if (event.type === "assistant.message.completed" || event.type === "reasoning.summary.completed" || event.type.endsWith(".snapshot")) {
    payload.text = event.payload.text ?? previous.payload.text ?? previous.payload.delta ?? "";
    delete payload.delta;
  } else if (["tool.updated", "plan.updated"].includes(event.type)) {
    if (typeof event.payload.text === "string" || Array.isArray(event.payload.entries)
      || event.type === "tool.updated" && event.payload.updateKind === "snapshot" && ["rawInput", "rawOutput", "item"].some(key => event.payload[key] !== undefined)) {
      delete payload.delta;
      delete payload.deltaField;
      if (Array.isArray(event.payload.entries)) delete payload.text;
      if (typeof event.payload.text === "string") delete payload.entries;
    }
    else payload.delta = `${previous.payload.delta ?? ""}${event.payload.delta ?? ""}`;
  }
  const next = events.slice();
  // Preserve the first occurrence's position and identity while replacing text.
  next[index] = { ...previous, type: event.type, payload, updatedCursor: event.cursor };
  return indexConversation(events, next, directory, key, index);
}

export function compactConversationEvents<T extends ConversationEvent>(events: T[]): T[] {
  const seen = new Set<string>();
  return events.reduce((result, event) => {
    if (seen.has(event.id)) return result;
    seen.add(event.id);
    return appendConversationEvent(result, event);
  }, [] as T[]);
}
