import { appendTraceEvent } from "../../domain/agents/agent-trace.js";
import { actorKey } from "../../domain/agents/agent-conversation.js";
import type { AgentEvent, AgentTurn } from "../../domain/agents/agent-types.js";

type CandidateSource = { id: string; createdAt: string; sourceTurnId?: string | null };
type CandidateEvent = Pick<AgentEvent, "type" | "payload" | "turnId"> & Partial<AgentEvent>;

// Native runtimes wrap MCP results as direct objects, JSON or text blocks.
function receipt(value: unknown, depth = 0): Record<string, unknown> | null {
  if (!value || depth > 6) return null;
  if (typeof value === "string") {
    try {
      return receipt(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value))
    return value.map((item) => receipt(item, depth + 1)).find(Boolean) ?? null;
  if (typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    item.schemaVersion === "research-agent-result.v1" &&
    item.kind === "candidateReceipt"
  )
    return item.data && typeof item.data === "object" && !Array.isArray(item.data) ? item.data as Record<string, unknown> : null;
  if (item.type === "text") return receipt(item.text, depth + 1);
  return receipt(item.structuredContent ?? item.content, depth + 1);
}

/** Match confirmed writes, never candidate IDs mentioned in assistant prose. */
export function candidateTurnLinks(session: { conversationEvents?: CandidateEvent[]; events?: CandidateEvent[] }) {
  const links = new Map<string, string>();
  const events = [
    ...(session.conversationEvents ?? []),
    ...(session.events ?? []),
  ].filter((event) => event.type?.startsWith("tool."));
  const calls = new Map<string, CandidateEvent>();
  for (const event of events.sort(
    (a, b) =>
      (a.updatedCursor ?? a.cursor ?? 0) - (b.updatedCursor ?? b.cursor ?? 0),
  )) {
    const key = `${event.turnId}:${actorKey(event.payload)}:${event.payload.toolCallId ?? event.payload.item?.id ?? event.id}`;
    const previous = calls.get(key);
    if (
      previous &&
      previous.id === event.id &&
      previous.cursor === (event.updatedCursor ?? event.cursor)
    )
      continue;
    calls.set(key, appendTraceEvent(previous ? [previous] : [], event)[0]);
  }
  for (const event of [...calls.values()].sort(
    (a, b) =>
      (a.updatedCursor ?? a.cursor ?? 0) - (b.updatedCursor ?? b.cursor ?? 0),
  )) {
    if (event.type !== "tool.completed" || !event.turnId) continue;
    const p = event.payload,
      item = p.item ?? {};
    const server = p.server ?? item.server;
    const names = [p.title, p.tool, item.tool].filter(
      (value) => typeof value === "string",
    );
    if (server && String(server).toLowerCase() !== "topolumia") continue;
    if (
      !names.some(
        (name) =>
          /^mcp__topolumia__(create_candidate|edit_candidate)$|^topolumia_+(create_candidate|edit_candidate)$/i.test(
            name,
          ) ||
          (String(server).toLowerCase() === "topolumia" &&
            /^(create_candidate|edit_candidate)$/.test(name)),
      )
    )
      continue;
    const result = receipt(
      p.rawOutput ?? item.result ?? item.output ?? p.result,
    );
    if (typeof result?.candidateId === "string")
      links.set(result.candidateId, event.turnId);
  }
  return links;
}

export function candidateTurn(candidate: CandidateSource, session: { turns?: Pick<AgentTurn, "id" | "startedAt" | "completedAt">[] }, links: Map<string, string>): string | null {
  if (links.has(candidate.id)) return links.get(candidate.id)!;
  if (candidate.sourceTurnId) return candidate.sourceTurnId;
  const created = Date.parse(candidate.createdAt);
  if (!Number.isFinite(created)) return null;
  const turns = session.turns ?? [];
  return (
    turns.find((turn, index) => {
      const start = Date.parse(turn.startedAt),
        end = Date.parse(turn.completedAt ?? turns[index + 1]?.startedAt ?? "");
      return (
        created >= start &&
        (Number.isFinite(end)
          ? created <= end
          : index === turns.length - 1 && !turn.completedAt)
      );
    })?.id ?? null
  );
}
