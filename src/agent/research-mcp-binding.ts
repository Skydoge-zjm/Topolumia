import path from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { bundledRoot } from "../config.js";
import { snapshotSkillBundle } from "./skill-bundle.js";
import type { ResearchMcpBinding } from "../domain/agents/agent-types.js";

export function buildResearchMcpBinding({
  baseUrl,
  projectId,
  sessionToken,
  cwd,
  runtimeInstanceId = randomUUID(),
  researchSessionId = runtimeInstanceId,
  dataRoot = path.join(cwd, ".topolumia-skills"),
}: { baseUrl: string; projectId: string; sessionToken: string; cwd: string; runtimeInstanceId?: string; researchSessionId?: string; dataRoot?: string }): ResearchMcpBinding {
  const transferRoot = path.join(cwd, ".topolumia-transfer", runtimeInstanceId);
  mkdirSync(path.join(transferRoot,"out"),{recursive:true});
  mkdirSync(path.join(transferRoot,"in"),{recursive:true});
  const source = path.join(bundledRoot,"src/agent/skills/topolumia-paper-reading");
  let skillInstructions = "";
  let skillDelivery;
  try {
    const { entryPath, bundleHash } = snapshotSkillBundle({
      sourceRoot: source,
      destinationRoot: path.join(dataRoot, "agent-skills"),
      researchSessionId,
    });
    skillInstructions = `Skill topolumia-paper-reading: only when a paper task uses Topolumia nodes, blocks, assets or candidates, read ${entryPath} using your native file tools; load references only as needed.`;
    skillDelivery = { name: "topolumia-paper-reading", mode: "manifestFile", version: bundleHash.slice(0, 12), bundleHash };
  } catch {
    // Optional task guidance must never prevent the Agent or MCP from starting.
    skillDelivery = { name: "topolumia-paper-reading", mode: "unavailable" };
  }
  return {
    name: "topolumia",
    command: process.execPath,
    args: [path.join(bundledRoot, "src/mcp/research-stdio.js")],
    cwd,
    instructions: [`Research file transfer directory: ${transferRoot}. Prepare uploads in out/; downloads arrive in in/.`, skillInstructions].filter(Boolean).join(" "),
    skillDelivery,
    env: {
      TOPOLUMIA_URL: baseUrl,
      TOPOLUMIA_PROJECT_ID: projectId,
      TOPOLUMIA_SESSION: sessionToken,
      TOPOLUMIA_TRANSFER_ROOT: transferRoot,
    },
  };
}
export function withoutResearchCredentials(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !key.toUpperCase().startsWith("TOPOLUMIA_"),
    ),
  );
}
export function codexMcpConfig(binding: ResearchMcpBinding, settings: Record<string, unknown> = {}) {
  const toolSettings = Object.fromEntries(
    ["omit_tools_from", "tool_input_schema_max_bytes", "enabled_tools", "disabled_tools"]
      .filter(key => settings[key] !== undefined)
      .map(key => [key, settings[key]]),
  );
  return {
    omit_tools_from: ["direct"],
    tool_input_schema_max_bytes: 5000,
    ...toolSettings,
    command: binding.command,
    args: binding.args,
    env: binding.env,
    cwd: binding.cwd,
    enabled: true,
    required: true,
    startup_timeout_sec: 30,
    tool_timeout_sec: 120,
  };
}
