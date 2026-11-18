export type AgentCommandSource = "builtin" | "custom" | "skill";
export type AgentCommandExecution = "native" | "prompt";
export type AgentCommandRisk = "none" | "session" | "workspace" | "account";

export interface AgentCommand {
  name: string;
  aliases?: string[];
  label: string;
  description: string;
  source: AgentCommandSource;
  execution: AgentCommandExecution;
  risk: AgentCommandRisk;
}

export interface AgentCommandInput {
  name: string;
  arguments?: string;
  id?: string;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface AgentCommandResult {
  stopReason: "end_turn" | "cancelled" | "incomplete";
  nativeSessionId?: string | null;
  nativeTurnId?: string | null;
  result?: unknown;
}

export const compactAgentCommand: AgentCommand = Object.freeze({
  name: "compact",
  label: "/compact",
  description: "压缩当前 Agent 会话上下文。",
  source: "builtin",
  execution: "native",
  risk: "session",
});

export const codexAgentCommands: AgentCommand[] = [
  compactAgentCommand,
  { name: "review", label: "/review", description: "启动当前会话的代码审阅。", source: "builtin", execution: "native", risk: "workspace" },
  { name: "rename", label: "/rename", description: "重命名原生会话。", source: "builtin", execution: "native", risk: "session" },
  { name: "goal", label: "/goal", description: "设置、查看或清除会话目标。", source: "builtin", execution: "native", risk: "session" },
];

export const openCodeAgentCommands: AgentCommand[] = [
  compactAgentCommand,
  { name: "undo", label: "/undo", description: "撤销最近一条消息及其文件变更。", source: "builtin", execution: "native", risk: "workspace" },
  { name: "redo", label: "/redo", description: "恢复最近一次撤销。", source: "builtin", execution: "native", risk: "workspace" },
  { name: "fork", label: "/fork", description: "从当前原生会话分叉。", source: "builtin", execution: "native", risk: "session" },
];

export function normalizeAgentCommandName(value: unknown): string {
  return String(value ?? "").trim().replace(/^\//, "").toLocaleLowerCase();
}

export function commandArguments(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function commandText(input: AgentCommandInput): string {
  const name = normalizeAgentCommandName(input.name);
  const args = commandArguments(input.arguments);
  return `/${name}${args ? ` ${args}` : ""}`;
}

export function parseAgentCommand(text: string): AgentCommandInput | null {
  const value = text.trim();
  if (!value.startsWith("/")) return null;
  const match = /^\/([^\s]*)(?:\s+([\s\S]*))?$/.exec(value);
  return { name: normalizeAgentCommandName(match?.[1]), arguments: commandArguments(match?.[2]) };
}

export function findAgentCommand(commands: AgentCommand[], value: unknown): AgentCommand | undefined {
  const name = normalizeAgentCommandName(value);
  return commands.find(command => command.name === name || command.aliases?.includes(name));
}
