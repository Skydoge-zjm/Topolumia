import { actorKey, contentBlockId, reasoningStreamKey } from "./agent-conversation.js";
import type { ConversationEvent } from "./agent-conversation.js";
type TraceEvent = Pick<ConversationEvent, "type" | "payload"> & Partial<ConversationEvent>;

const meaningful = new Set(["user.message", "session.status", "session.closed", "turn.completed", "turn.failed", "turn.cancelled", "turn.retrying",
  "approval.requested", "approval.resolved", "usage.updated", "plan.updated", "agent.activity", "agent.delegated", "files.changed", "content.removed", "agent.question.unsupported", "driver.process.closed"]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function identity(event: TraceEvent): string {
  const p = event.payload;
  const scope = `${event.turnId ?? "session"}:${actorKey(p)}`;
  if (event.type.startsWith("assistant.message.")) return `message:${scope}:${contentBlockId(p)}`;
  if (event.type.startsWith("reasoning.summary.")) return reasoningStreamKey(event);
  if (event.type.startsWith("tool.")) return `tool:${scope}:${p.toolCallId ?? object(p.item).id ?? event.id}`;
  if (event.type === "plan.updated") return `plan:${scope}:${p.planId ?? p.itemId ?? p.nativeItemId ?? "turn-plan"}`;
  if (event.type.startsWith("approval.")) return `approval:${p.requestId ?? event.id}`;
  if (event.type === "usage.updated") return `usage:${scope}:${p.nativeItemId ?? "total"}`;
  if (event.type === "agent.activity") return `agent:${scope}`;
  if (["session.status", "turn.retrying"].includes(event.type)) return `${event.type}:${scope}`;
  return `${event.type}:${event.id}`;
}

const traceIndexes = new WeakMap<TraceEvent[], { length: number; keys: Map<string, number> }>();
function traceIndex(events: TraceEvent[]) {
  let index = traceIndexes.get(events);
  if (!index || index.length !== events.length) {
    index = { length: events.length, keys: new Map() };
    const directory = index;
    events.forEach((event, position) => { const key = identity(event); if (!directory.keys.has(key)) directory.keys.set(key, position); });
    traceIndexes.set(events, index);
  }
  return index;
}

// Durable Trace is a state log: one full record per message block/tool call.
// Token deltas remain on the live SSE stream, never as historical log rows.
export function appendTraceEvent<T extends TraceEvent>(events: T[], event: T): T[] {
  if (typeof event.type !== "string") return events;
  const text = event.type.startsWith("assistant.message.") || event.type.startsWith("reasoning.summary.");
  const tool = event.type.startsWith("tool.");
  if (!text && !tool && !meaningful.has(event.type)) return events;
  if (event.type === "session.status" && !event.payload.error && event.payload.status !== "failed") return events;
  if (event.type === "driver.process.closed" && event.payload.expected) return events;
  if (["turn.completed", "turn.failed", "turn.cancelled", "session.closed"].includes(event.type)) {
    events = events.map(record => {
      if (event.type !== "session.closed" && record.turnId !== event.turnId) return record;
      const incomplete = record.type.endsWith(".snapshot") && /^(assistant.message|reasoning.summary)\./.test(record.type) || record.type === "tool.started";
      if (!incomplete) return record;
      const completion = event.type === "turn.failed" ? "failed" : event.type === "turn.cancelled" ? "interrupted" : "incomplete";
      return { ...record, type: record.type === "tool.started" ? "tool.failed" : record.type.replace(/\.snapshot$/, ".completed"),
        payload: { ...record.payload, completion, status: completion } };
    });
  }
  const key = identity(event);
  const directory = traceIndex(events);
  const index = directory.keys.get(key) ?? -1;
  const previous = index < 0 ? undefined : events[index];
  const p = event.payload;
  const old = previous?.payload ?? {};
  const payload = { ...old, ...p };
  let type = event.type;
  if (text) {
    if (event.type.endsWith(".delta")) {
      if (previous?.type.endsWith(".completed")) return events;
      payload.text = `${old.text ?? ""}${p.delta ?? ""}`;
      payload.completion = "streaming";
      type = event.type.replace(/\.delta$/, ".snapshot");
    } else {
      payload.text = p.text ?? old.text ?? "";
      if (event.type.endsWith(".completed") && !p.completion) payload.completion = "completed";
    }
  } else if (tool) {
    const item = { ...object(old.item), ...object(p.item) };
    if (Object.keys(item).length) payload.item = item;
    payload.title = old.title ?? p.title;
    payload.kind = old.kind ?? p.kind;
    if (typeof p.delta === "string") {
      const field = p.deltaField === "input" ? "rawInput" : "rawOutput";
      payload[field] = `${typeof old[field] === "string" ? old[field] : ""}${p.delta}`;
    }
    const incoming = object(p.item);
    const output = incoming.aggregatedOutput ?? incoming.output ?? p.rawOutput;
    if (output !== undefined) payload.rawOutput = output;
    if (p.rawInput !== undefined) payload.rawInput = p.rawInput;
    const terminal = ["tool.completed", "tool.failed"].includes(event.type);
    type = terminal ? event.type : previous && ["tool.completed", "tool.failed"].includes(previous.type) ? previous.type : "tool.started";
    if (type === "tool.completed") {
      delete payload.error;
      if (!incoming.error && payload.item) delete (payload.item as Record<string, unknown>).error;
    }
    if (terminal) payload.completion = p.completion ?? (type === "tool.failed" ? "failed" : "completed");
    if (!terminal && previous && type !== "tool.started") {
      payload.status = old.status; payload.completion = old.completion;
      if (payload.item) (payload.item as Record<string, unknown>).status = object(old.item).status;
    }
  } else if (event.type === "plan.updated") {
    if (typeof p.text === "string") { payload.text = p.text; delete payload.entries; }
    else if (Array.isArray(p.entries)) { payload.entries = p.entries; delete payload.text; }
    else if (typeof p.delta === "string") payload.text = `${old.text ?? ""}${p.delta}`;
  }
  delete payload.delta;
  delete payload.deltaField;
  payload.updateKind = "snapshot";
  const record = { ...event, id: previous?.id ?? event.id, cursor: event.updatedCursor ?? event.cursor, type, payload,
    occurredAt: previous?.occurredAt ?? event.occurredAt } as T;
  const next = events.slice();
  if (index < 0) next.push(record);
  else next[index] = record;
  traceIndexes.delete(events);
  directory.keys.set(key, index < 0 ? events.length : index);
  directory.length = next.length;
  traceIndexes.set(next, directory);
  return next;
}

export function compactTraceEvents<T extends ConversationEvent>(events: T[]): T[] {
  const seen = new Set<string>();
  return events.reduce((result, event) => {
    // Canonical snapshots reuse the original id but have a newer update cursor.
    const key = `${event.id}:${event.updatedCursor ?? event.cursor}`;
    if (seen.has(key)) return result;
    seen.add(key);
    return appendTraceEvent(result, event);
  }, [] as T[]);
}

export function traceFromConversation<T extends ConversationEvent>(conversation: T[], prior: T[] = []): T[] {
  const extra = prior.filter(event => typeof event.type === "string" && !event.type.startsWith("assistant.message.") && !event.type.startsWith("reasoning.summary.")
    && !event.type.startsWith("tool.") && event.type !== "plan.updated");
  return compactTraceEvents([...conversation, ...extra].sort((a, b) => a.cursor - b.cursor));
}
