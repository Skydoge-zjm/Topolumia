import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLI_CONTRACT } from "../domain/research/research-interface.js";
import { researchTools } from "../domain/research/research-mcp-contract.js";
import { setTimeout as delay } from "node:timers/promises";
import { Readable } from "node:stream";
import type { ResearchMcpBinding } from "../domain/agents/agent-types.js";

export async function openResearchMcp(binding: Pick<ResearchMcpBinding, "command" | "args" | "cwd" | "env">) {
  const transport = new StdioClientTransport({
    command: binding.command,
    args: binding.args,
    cwd: binding.cwd,
    env: binding.env,
    stderr: "pipe",
  });
  if (transport.stderr instanceof Readable) transport.stderr.resume();
  const client = new Client({
    name: "topolumia-integration",
    version: "1.0.0",
  });
  try {
    await client.connect(transport, { timeout: 15000 });
    return {
      client,
      close: async () => {
        const pid = transport.pid;
        await client.close();
        if (!pid) return;
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
          } catch {
            return;
          }
          await delay(20);
        }
        throw new Error("科研 MCP 进程未在关闭后退出。");
      },
    };
  } catch (error) {
    await transport.close();
    throw error;
  }
}
export async function verifyResearchMcp(binding: Pick<ResearchMcpBinding, "command" | "args" | "cwd" | "env">) {
  const connection = await openResearchMcp(binding);
  try {
    const { tools } = await connection.client.listTools();
    if (
      !tools.some((tool) => tool.name === "get_context") ||
      tools.some((tool) => !Object.hasOwn(researchTools, tool.name))
    )
      throw new Error("科研 MCP 工具目录不兼容。");
    const result = await connection.client.callTool(
      { name: "get_context", arguments: {} },
      undefined,
      { timeout: 25000 },
    );
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    const nativeExecution = result._meta?.execution;
    const execution = nativeExecution && typeof nativeExecution === "object" ? nativeExecution as Record<string, unknown> : undefined;
    if (
      result.isError ||
      structured?.projectId !==
        binding.env.TOPOLUMIA_PROJECT_ID ||
      execution?.contract !== CLI_CONTRACT ||
      !execution?.pid
    )
      throw new Error("科研 MCP 授权或真实 CLI 往返失败。");
    return {
      toolCount: Object.keys(researchTools).length,
      checkedTools: tools.length,
      cliContract: CLI_CONTRACT,
      transport: "stdio",
    };
  } finally {
    await connection.close();
  }
}
