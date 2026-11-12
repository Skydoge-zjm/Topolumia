import type { OpenCodeClient } from "@opencode/client";
import type { ResearchMcpBinding } from "../../../../domain/agents/agent-types.js";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../../../../lib/errors.js";

export async function bindOpenCodeV2Mcp(client: OpenCodeClient, directory: string, binding: ResearchMcpBinding): Promise<void> {
  const location = { directory };
  await client.experimental.mcp.add({ server: binding.name, location, config: {
    type: "local", command: [binding.command, ...binding.args], cwd: binding.cwd, environment: binding.env,
    disabled: false, codemode: false, pool: false, timeout: { startup: 30_000, catalog: 30_000, execution: 120_000 },
  } });
  await client.experimental.mcp.connect({ server: binding.name, location });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await client.mcp.list({ location });
    const server = result.data.find(server => server.name === binding.name);
    if (server?.status.status === "connected") return;
    if (server && server.status.status !== "pending") break;
    await delay(100);
  }
  throw new AppError("OPENCODE_V2_MCP_UNAVAILABLE", "OpenCode 2 科研 MCP 连接失败，请检查会话授权和 CLI。", { status: 503 });
}
