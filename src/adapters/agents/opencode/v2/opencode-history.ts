import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client";
import path from "node:path";
import { AppError } from "../../../../lib/errors.js";

export function sameOpenCodeV2Directory(left: string, right: string): boolean {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function readOpenCodeV2Messages(client: OpenCodeClient, sessionID: string): Promise<SessionMessageInfo[]> {
  const messages: SessionMessageInfo[] = [];
  const ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.message.list({ sessionID, limit: 100, ...(cursor ? { cursor } : { order: "asc" as const }) });
    if (!page || !Array.isArray(page.data) || !page.cursor) throw new AppError("OPENCODE_V2_HISTORY_INVALID", "OpenCode 2 没有返回有效的历史分页。", { status: 502 });
    for (const message of page.data) if (!ids.has(message.id)) { ids.add(message.id); messages.push(message); }
    if (!page.data.length) break;
    cursor = page.cursor.next ?? undefined;
    if (cursor && cursors.has(cursor)) throw new AppError("OPENCODE_V2_HISTORY_INVALID", "OpenCode 2 历史分页游标重复。", { status: 502 });
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return messages;
}

export function openCodeV2Parents(messages: SessionMessageInfo[]): Map<string, string> {
  const result = new Map<string, string>();
  let parent: string | undefined;
  for (const message of messages) {
    if (message.type === "user") parent = message.id;
    if (parent) result.set(message.id, parent);
  }
  return result;
}
