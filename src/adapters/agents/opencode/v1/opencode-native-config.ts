import type { AgentProfile, NativeConfig } from "../../../../domain/agents/agent-types.js";

// Frozen V1 format. V2 configuration is defined independently in v2/.
export const openCodeV1Format = {
  filename: "opencode.jsonc", format: "jsonc", schemaFile: "opencode/v1.json",
  schemaUrl: "https://opencode.ai/config.json", docsUrl: "https://opencode.ai/docs/server/",
};

export function initialOpenCodeV1Config(profile: AgentProfile): NativeConfig {
  return { $schema: openCodeV1Format.schemaUrl, ...(profile.model ? { model: profile.model } : {}),
    permission: profile.approvalPolicy === "never" ? "allow" : "ask" };
}
