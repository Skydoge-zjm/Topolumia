import type { ConversationEvent } from "./agent-conversation.js";

export function isImageView(event: Pick<ConversationEvent, "type" | "payload">): boolean {
  const item = event.payload.item as Record<string, unknown> | undefined;
  return (
    event.type.startsWith("tool.") &&
    [event.payload.kind, item?.type].some(
      (value) => String(value ?? "").toLowerCase() === "imageview",
    )
  );
}

export function imageViewPath(event: Pick<ConversationEvent, "type" | "payload">): string | undefined {
  if (!isImageView(event)) return undefined;
  const item = event.payload.item as Record<string, unknown> | undefined;
  const value = item?.path ?? event.payload.path;
  return typeof value === "string" && value.trim() ? value : undefined;
}
