import type { AgentEvent } from "@/shared/types/api";

export type ToolKind =
  | "mcp"
  | "terminal"
  | "search"
  | "web"
  | "file-read"
  | "file-edit"
  | "agent"
  | "tool";
type ToolSource = { title?: string; events?: AgentEvent[] };

export function toolInvocation(event: AgentEvent) {
  const p = event.payload, item = object(p.item);
  const input = p.rawInput ?? item.arguments ?? item.input ?? p.arguments;
  let parsed = input;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { /* Incomplete live input. */ }
  }
  const args = object(parsed);
  return { input, command: item.command ?? p.command ?? args.command ?? args.cmd };
}

export function toolCallLabel(source: ToolSource, en: boolean, status?: string) {
  const research = topolumiaToolLabel(source, en, status);
  if (research) return research;
  if (describeTool(source, en).kind === "terminal") {
    const command = [...(source.events ?? [])].reverse()
      .map((event) => toolInvocation(event).command)
      .find((value) => typeof value === "string");
    if (typeof command === "string") {
      // Hide a launcher path in the preview; the complete command stays in details.
      const body = /^(?:"[^"]*(?:pwsh|powershell)(?:\.exe)?"|\S*(?:pwsh|powershell)(?:\.exe)?)\s+(?:-NoProfile\s+|-NonInteractive\s+)*-(?:Command|c)\s+([\s\S]+)$/i.exec(command)?.[1] ?? command;
      return body.replace(/^(["'])([\s\S]*)\1$/, "$2").replace(/\s+/g, " ").trim();
    }
  }
  return source.title ?? describeTool(source, en).label;
}
type ToolDescription = { kind: ToolKind; key: string; label: string };
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
const strings = (values: unknown[]) =>
  values.filter(
    (value): value is string =>
      typeof value === "string" && Boolean(value.trim()),
  );

const researchActions: Record<string, [string, string, string]> = {
  get_environment: ["读取科研环境", "Read research environment", "Reading research environment"],
  get_context: [
    "读取科研上下文",
    "Read research context",
    "Reading research context",
  ],
  search: [
    "搜索科研信息",
    "Search research information",
    "Searching research information",
  ],
  read_nodes: ["读取节点", "Read nodes", "Reading nodes"],
  neighbors: [
    "探索节点关系",
    "Explore node relationships",
    "Exploring node relationships",
  ],
  read_source: ["读取来源", "Read source", "Reading source"],
  read_blocks: ["读取内容块", "Read content blocks", "Reading content blocks"],
  read_assets: ["读取研究附件", "Read research assets", "Reading research assets"],
  transfer_asset: ["交接研究文件", "Transfer research file", "Transferring research file"],
  get_schema: ["查阅格式说明", "Read format reference", "Reading format reference"],
  read_candidates: [
    "读取候选变更",
    "Read proposed changes",
    "Reading proposed changes",
  ],
  create_candidate: [
    "提交候选变更",
    "Submit proposed changes",
    "Submitting proposed changes",
  ],
  edit_candidate: [
    "修改候选变更",
    "Edit proposed changes",
    "Editing proposed changes",
  ],
};

/** Match only this application's MCP namespace; explicit server identity wins. */
export function topolumiaOperation(source: ToolSource): string | undefined {
  if (describeTool(source, false).key !== "mcp:topolumia") return undefined;
  const explicitServer = (source.events ?? []).flatMap((event) =>
    strings([event.payload.server, object(event.payload.item).server]),
  )[0];
  for (const event of [...(source.events ?? [])].reverse()) {
    const item = object(event.payload.item);
    for (const name of strings([
      item.tool,
      event.payload.tool,
      event.payload.title,
      source.title,
    ])) {
      const qualified = /^mcp__topolumia__(.+)$/i.exec(name),
        prefixed = /^topolumia_+(.+)$/i.exec(name);
      if (qualified) return qualified[1];
      if (prefixed && Object.hasOwn(researchActions, prefixed[1]))
        return prefixed[1];
      if (
        explicitServer?.toLowerCase() === "topolumia" &&
        Object.hasOwn(researchActions, name)
      )
        return name;
    }
  }
  const qualified = /^mcp__topolumia__(.+)$/i.exec(source.title ?? ""),
    prefixed = /^topolumia_+(.+)$/i.exec(source.title ?? "");
  return (
    qualified?.[1] ??
    (prefixed && Object.hasOwn(researchActions, prefixed[1])
      ? prefixed[1]
      : explicitServer?.toLowerCase() === "topolumia"
        ? "unknown"
        : undefined)
  );
}

export function topolumiaToolLabel(
  source: ToolSource,
  en: boolean,
  status?: string,
): string | undefined {
  const operation = topolumiaOperation(source);
  if (!operation) return undefined;
  let action = researchActions[operation] ?? [
    "执行科研操作",
    "Run research operation",
    "Running research operation",
  ];
  if (operation === "search") {
    const targets = new Map<string, unknown>();
    for (const event of source.events ?? []) {
      const p = event.payload,
        item = object(p.item),
        raw = p.rawInput ?? p.arguments ?? item.arguments ?? item.input;
      let input = raw;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          continue;
        }
      }
      if (input && typeof input === "object")
        targets.set(
          String(p.toolCallId ?? item.id ?? "call"),
          object(input).target ?? "all",
        );
    }
    const values = new Set(targets.values());
    if (values.size === 1 && values.has("nodes"))
      action = ["搜索节点", "Search nodes", "Searching nodes"];
    else if (values.size === 1 && values.has("sources"))
      action = ["搜索来源", "Search sources", "Searching sources"];
  }
  const last = source.events?.at(-1);
  const running = status
    ? ["running", "pending", "inProgress"].includes(status)
    : last?.type === "tool.started" || last?.type === "tool.updated";
  return en ? action[running ? 2 : 1] : action[0] + (running ? "中" : "");
}

/** Describe the tool boundary, keeping MCP's internal operations out of summaries. */
export function describeTool(source: ToolSource, en: boolean): ToolDescription {
  const payloads = (source.events ?? []).map((event) => event.payload);
  const items = payloads.map((payload) => object(payload.item));
  const names = strings(
    payloads
      .flatMap((payload, index) => [
        items[index].tool,
        payload.tool,
        payload.title,
        payload.kind,
      ])
      .concat(source.title),
  );
  const servers = strings(
    payloads.flatMap((payload, index) => [payload.server, items[index].server]),
  );
  const qualified = names
    .map((name) => /^mcp__(.+?)__.+$/.exec(name))
    .find(Boolean);
  // OpenCode prefixes this application's MCP tools with its configured server name.
  // Other underscore-separated names are not sufficient evidence of an MCP call.
  const server =
    servers[0] ??
    qualified?.[1] ??
    (names.some((name) => /^topolumia_+/.test(name)) ? "topolumia" : undefined);
  if (server) {
    const id = server.toLowerCase() === "topolumia" ? "topolumia" : server;
    return {
      kind: "mcp",
      key: `mcp:${id}`,
      label: `${id === "topolumia" ? "Topolumia" : id} MCP`,
    };
  }
  if (
    names.includes("mcpToolCall") ||
    items.some((item) => item.type === "mcpToolCall")
  )
    return { kind: "mcp", key: "mcp", label: "MCP" };

  const terminal = names.find((name) =>
    /^(bash|powershell|pwsh|shell|shell_command|shell_command_tool|exec_command|terminal)$/i.test(
      name,
    ),
  );
  if (
    terminal ||
    names.includes("commandExecution") ||
    items.some((item) => item.type === "commandExecution") ||
    payloads.some(
      (payload, index) =>
        typeof payload.command === "string" ||
        typeof items[index].command === "string",
    )
  ) {
    const shell = /^(bash)$/i.test(terminal ?? "")
      ? "Bash"
      : /^(powershell|pwsh)$/i.test(terminal ?? "")
        ? "PowerShell"
        : undefined;
    return {
      kind: "terminal",
      key: `terminal:${shell ?? "generic"}`,
      label: shell
        ? en
          ? `${shell} tool`
          : `${shell} 工具`
        : en
          ? "terminal tool"
          : "终端工具",
    };
  }

  const name =
    names.find((name) => !["dynamicToolCall", "tool_result"].includes(name)) ??
    source.title ??
    (en ? "tool" : "工具");
  const normalized = name.toLowerCase();
  const kind: ToolKind = /^(toolsearch|grep|glob|search|rg)$/.test(normalized)
    ? "search"
    : /^(websearch|webfetch|web_search|web_fetch)$/.test(normalized)
      ? "web"
      : /^(read|read_file|readfile)$/.test(normalized)
        ? "file-read"
        : /^(edit|write|multiedit|apply_patch|edit_file|write_file)$/.test(
              normalized,
            )
          ? "file-edit"
          : /^(agent|task)$/.test(normalized)
            ? "agent"
            : "tool";
  return { kind, key: `tool:${name}`, label: name };
}
