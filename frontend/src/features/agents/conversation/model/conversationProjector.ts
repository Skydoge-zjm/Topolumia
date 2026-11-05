import {
  normalizeConversation,
  type ConversationItem,
} from "./agentConversation";
import { groupActivityRuns } from "./agentActivity";
import type { AgentEvent } from "@/shared/types/api";

// Stable completed rows let React skip Markdown parsing and DOM work while a
// different content block streams. Snapshots and removals still replace rows.
export function createConversationProjector() {
  let previous = new Map<string, ConversationItem>(),
    last: ConversationItem[] = [];
  const arraysEqual = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    a === b ||
    Boolean(
      a && b && a.length === b.length && a.every((item, i) => item === b[i]),
    );
  return (events: AgentEvent[], compacted = true) => {
    const next = new Map<string, ConversationItem>();
    const stable = (item: ConversationItem): ConversationItem => {
      if (item.children) item.children = item.children.map(stable);
      const old = previous.get(item.key);
      if (
        old &&
        Object.keys(item).every((key) => {
          const value = item[key as keyof ConversationItem],
            prior = old[key as keyof ConversationItem];
          return (
            value === prior ||
            (Array.isArray(value) &&
              Array.isArray(prior) &&
              arraysEqual(value, prior))
          );
        }) &&
        Object.keys(old).length === Object.keys(item).length
      )
        item = old;
      next.set(item.key, item);
      return item;
    };
    const rows = groupActivityRuns(
      normalizeConversation(events, { compacted }),
    ).map(stable);
    previous = next;
    if (arraysEqual(rows, last)) return last;
    last = rows;
    return rows;
  };
}
