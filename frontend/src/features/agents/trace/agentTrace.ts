import type { AgentEvent } from "@/shared/types/api";
import { compactTraceEvents } from "@domain/agents/agent-trace";
import { topolumiaToolLabel } from "../tools/agentTool";

export type TraceGroup = {
  id: string;
  title: string;
  kind:
    "message" | "reasoning" | "tool" | "trace" | "plan" | "approval" | "status";
  status?: string;
  occurredAt?: string;
  events: AgentEvent[];
  text?: string;
};

function valueText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function traceTitle(event: AgentEvent, en = false): string {
  const researchLabel = topolumiaToolLabel({ events: [event] }, en);
  if (researchLabel) return researchLabel;
  const payload = event.payload ?? {};
  const item = (payload.item ?? {}) as Record<string, unknown>;
  const kind = String(payload.kind ?? item.type ?? payload.tool ?? "tool");
  const names: Record<string, string> = {
    commandExecution: "终端命令",
    mcpToolCall: "MCP 工具调用",
    fileChange: "文件变更",
    webSearch: "网络搜索",
    dynamicToolCall: "动态工具",
    subagentActivity: "子 Agent 活动",
  };
  const title = String(payload.title ?? item.title ?? names[kind] ?? kind);
  const command = payload.command ?? item.command;
  const server = payload.server ?? item.server;
  const tool = payload.tool ?? item.tool;
  if (kind === "commandExecution" && command)
    return `${title}: ${String(command).slice(0, 100)}`;
  if (kind === "mcpToolCall" && (server || tool))
    return `MCP · ${[server, tool].filter(Boolean).join("/")}`;
  return title;
}

export function traceDetail(event: AgentEvent): string {
  const payload = event.payload ?? {};
  const item = (payload.item ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (event.type.startsWith("approval.")) {
    const fields: Array<[string, unknown]> = [
      ["原因", payload.reason],
      ["工具", payload.toolName],
      ["命令", payload.command],
      ["目录", payload.cwd],
      ["路径", payload.paths],
      ["文件变更", payload.fileChanges],
      ["网络目标", payload.network],
      ["请求权限", payload.permissions],
      ["输入", payload.input],
      ["匹配规则", payload.patterns],
      ["记住规则", payload.rememberPatterns],
      ["审批结果", payload.decision],
      ["授权范围", payload.selectedScope],
      ["原生选项", payload.optionId],
      ["已选权限类别", payload.permissionKeys],
    ];
    return fields
      .filter(([, value]) => value != null)
      .map(([label, value]) => `${label}：${valueText(value)}`)
      .join("\n\n");
  }
  if (event.type === "usage.updated") {
    const usage = payload.tokenUsage as
      | { last?: Record<string, unknown>; total?: Record<string, unknown> }
      | undefined;
    const scope = payload.lastScope ?? payload.scope;
    const counts =
      scope === "session"
        ? (usage?.total ?? usage?.last)
        : (usage?.last ?? usage?.total);
    if (counts) {
      const labels: Record<string, string> = {
        step: "最近步骤",
        turn: "本轮",
        session: "会话累计",
      };
      parts.push(`用量范围：${labels[String(scope)] ?? "报告值"}`);
      for (const [label, key] of [
        ["输入 Tokens", "inputTokens"],
        ["输出 Tokens", "outputTokens"],
        ["缓存读取 Tokens", "cachedInputTokens"],
        ["缓存写入 Tokens", "cacheWriteInputTokens"],
        ["合计 Tokens", "totalTokens"],
      ]) {
        if (counts[key] !== undefined) parts.push(`${label}：${counts[key]}`);
      }
      return parts.join("\n");
    }
  }
  const fields: Array<[string, unknown]> = [
    ["命令", payload.command ?? item.command],
    ["工作目录", payload.cwd ?? item.cwd],
    ["路径", payload.filePath ?? payload.path ?? item.filePath ?? item.path],
    [
      "MCP",
      [payload.server ?? item.server, payload.tool ?? item.tool]
        .filter(Boolean)
        .join("/"),
    ],
    ["参数", payload.arguments ?? item.arguments],
    ["输入", payload.rawInput ?? item.input],
    [
      "输出",
      payload.rawOutput ??
        item.aggregatedOutput ??
        item.output ??
        payload.delta,
    ],
    ["结果", payload.result ?? item.result],
    ["错误", payload.error ?? item.error],
    ["变更", payload.diff ?? item.diff ?? item.patch],
  ];
  for (const [label, value] of fields)
    if (value !== undefined && value !== null && value !== "")
      parts.push(`${label}：${valueText(value)}`);
  if (Array.isArray(payload.entries))
    parts.push(`计划：${valueText(payload.entries)}`);
  if (Array.isArray(payload.files))
    parts.push(`文件：${valueText(payload.files)}`);
  if (!parts.length) {
    const fallback =
      payload.detail ??
      payload.message ??
      payload.text ??
      payload.summary ??
      payload.description ??
      payload.reason ??
      payload.decision ??
      payload.status;
    if (fallback !== undefined) parts.push(valueText(fallback));
  }
  return parts.join("\n\n");
}

export function buildAgentTrace(
  events: AgentEvent[],
  en = false,
): TraceGroup[] {
  const names: Record<string, string> = {
    "turn.completed": "回合完成",
    "turn.failed": "回合失败",
    "turn.cancelled": "回合已中断",
    "turn.retrying": "发生重试",
    "session.status": "会话状态",
    "session.closed": "会话关闭",
    "driver.process.closed": "运行时已结束",
    "usage.updated": "用量统计",
    "agent.activity": "子 Agent 活动",
    "agent.delegated": "任务委派",
    "content.removed": "内容已移除",
    "files.changed": "文件变更",
    "agent.question.unsupported": "交互问题",
  };
  return compactTraceEvents(events).map((event) => {
    const payload = event.payload;
    const common = {
      id: event.id,
      occurredAt: event.occurredAt,
      events: [event],
    };
    if (event.type === "user.message")
      return {
        ...common,
        id: `user:${event.id}`,
        kind: "message",
        title: "用户消息",
        text: String(payload.text ?? ""),
      };
    if (event.type.startsWith("assistant.message."))
      return {
        ...common,
        kind: "message",
        title: payload.agentName
          ? String(payload.agentName)
          : payload.agentId
            ? "子 Agent"
            : "Agent",
        text: String(payload.text ?? ""),
        status: String(
          payload.completion ??
            (event.type.endsWith(".completed") ? "completed" : "running"),
        ),
      };
    if (event.type.startsWith("reasoning.summary."))
      return {
        ...common,
        kind: "reasoning",
        title: "推理摘要",
        text: String(payload.text ?? ""),
        status: String(
          payload.completion ??
            (event.type.endsWith(".completed") ? "completed" : "running"),
        ),
      };
    if (event.type.startsWith("tool."))
      return {
        ...common,
        kind: "tool",
        title: traceTitle(event, en),
        status: String(
          payload.completion ??
            (event.type === "tool.failed"
              ? "failed"
              : event.type === "tool.completed"
                ? "completed"
                : "running"),
        ),
      };
    if (event.type === "plan.updated")
      return {
        ...common,
        kind: "plan",
        title: "执行计划",
        text: typeof payload.text === "string" ? payload.text : undefined,
      };
    if (event.type.startsWith("approval."))
      return {
        ...common,
        kind: "approval",
        title: event.type === "approval.resolved" ? "审批结果" : "等待审批",
        status: event.type === "approval.resolved" ? "resolved" : "pending",
      };
    return {
      ...common,
      kind: "status",
      title: names[event.type] ?? "执行结果",
      status: typeof payload.status === "string" ? payload.status : undefined,
    };
  });
}
