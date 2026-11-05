import type { ConversationItem } from "./agentConversation";

export type ConversationWaypoint = { key: string; text: string; reply: string };
const excerptCache = new WeakMap<
  ConversationItem,
  { text: string; excerpt: string }
>();

export function navigationExcerpt(text: string, limit = 240): string {
  const plain = text
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(^|\n)\s*(?:#{1,6}\s+|[-+>]\s+)/g, " ")
    .replace(/[*`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
}

export function conversationWaypoints(
  items: ConversationItem[],
): ConversationWaypoint[] {
  const result: ConversationWaypoint[] = [];
  let current: ConversationWaypoint | undefined;
  let hasFinal = false;
  for (const item of items) {
    if (item.kind !== "message") continue;
    if (item.role === "user") {
      current = {
        key: item.key,
        text:
          item.text ||
          item.attachments?.map((image) => image.name).join(", ") ||
          "",
        reply: "",
      };
      result.push(current);
      hasFinal = false;
    } else if (
      current &&
      item.text?.trim() &&
      (!hasFinal || item.phase === "final_answer")
    ) {
      const prior = excerptCache.get(item);
      const excerpt =
        prior?.text === item.text
          ? prior.excerpt
          : navigationExcerpt(item.text);
      if (prior?.text !== item.text)
        excerptCache.set(item, { text: item.text, excerpt });
      current.reply = excerpt;
      hasFinal ||= item.phase === "final_answer";
    }
  }
  return result;
}
