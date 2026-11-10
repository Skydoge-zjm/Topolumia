import { readFile } from "node:fs/promises";
import type { AgentPromptPart } from "../../../domain/agents/agent-types.js";

export async function promptImages(content: AgentPromptPart[] = []) {
  return Promise.all(
    content
      .filter((part) => part.type === "image")
      .map(async (part) => ({
        data: (await readFile(part.path ?? "")).toString("base64"),
        mimeType: part.mimeType ?? "image/png",
        name: part.name,
      })),
  );
}
