import type { OpenCodeClient } from "@opencode/client";

export async function setOpenCodeV2Instructions(client: OpenCodeClient, sessionID: string, text: string): Promise<void> {
  // Stable key replaces the previous runtime's instructions without an extra model turn.
  if (text) await client.experimental.session.instructions.entry.put({ sessionID, key: "topolumia.research", value: text });
  else await client.experimental.session.instructions.entry.remove({ sessionID, key: "topolumia.research" });
}
