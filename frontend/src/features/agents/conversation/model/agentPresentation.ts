import type { AgentSession, AgentEvent } from "@/shared/types/api";
import { describeTool, topolumiaToolLabel } from "../../tools/agentTool";

export function agentStatus(status: string, en: boolean) {
  const labels: Record<string, [string, string]> = {
    ready: ["就绪", "Ready"],
    running: ["执行中", "Working"],
    awaiting_permission: ["等待审批", "Awaiting approval"],
    starting: ["连接中", "Connecting"],
    detached: ["可继续", "Can continue"],
    closed: ["已结束", "Ended"],
    failed: ["需要恢复", "Needs recovery"],
    stopping: ["正在停止", "Stopping"],
    closing: ["正在结束", "Closing"],
  };
  return labels[status]?.[en ? 1 : 0] ?? (en ? "Unknown" : "状态未知");
}
export function currentAgentActivity(
  session: AgentSession | undefined,
  events: AgentEvent[],
  en: boolean,
) {
  if (session?.status !== "running") return "";
  const finished = new Set<string>();
  for (const event of [...events].reverse()) {
    if (event.turnId !== session.activeTurnId && session.activeTurnId) continue;
    const toolId = String(
      event.payload.toolCallId ??
        (event.payload.item as { id?: string } | undefined)?.id ??
        event.id,
    );
    if (["tool.completed", "tool.failed"].includes(event.type)) {
      finished.add(toolId);
      continue;
    }
    if (event.type === "tool.started" && !finished.has(toolId))
      return (
        topolumiaToolLabel({ events: [event] }, en, "running") ??
        (en
          ? `Calling ${describeTool({ events: [event] }, true).label}`
          : `正在调用 ${describeTool({ events: [event] }, false).label}`)
      );
    if (
      event.type === "assistant.message.delta" ||
      (event.type === "assistant.message.snapshot" &&
        event.payload.completion === "streaming")
    )
      return en ? "Writing reply" : "正在生成回复";
    if (
      event.type === "reasoning.summary.delta" ||
      (event.type === "reasoning.summary.snapshot" &&
        event.payload.completion === "streaming")
    )
      return en ? "Reasoning" : "正在思考";
    if (event.type === "assistant.message.completed") break;
  }
  return en ? "Processing" : "正在处理";
}
export function sessionGroup(
  session: AgentSession,
  en: boolean,
  now = new Date(),
) {
  if (session.pinned) return en ? "Pinned" : "置顶";
  const date = new Date(session.updatedAt || session.createdAt);
  const day = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const age =
    day -
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return age < 86_400_000
    ? en
      ? "Today"
      : "今天"
    : age < 7 * 86_400_000
      ? en
        ? "This week"
        : "最近七天"
      : en
        ? "Earlier"
        : "更早";
}
