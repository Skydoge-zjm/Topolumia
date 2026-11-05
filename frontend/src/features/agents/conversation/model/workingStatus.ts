import { describeTool, topolumiaToolLabel } from "../../tools/agentTool";
import type { AgentEvent, AgentSession } from "@/shared/types/api";

export type WorkingStatus = {
  /** Stable key for the current phase, so the UI animates only on real change. */
  phase: string;
  /** What the agent is doing right now, in the user's language. */
  text: string;
  /** Seconds since the turn started, once it is worth showing. */
  elapsed?: number;
  /** True when a tool is actively running rather than the model composing. */
  tool: boolean;
};

const toolKey = (event: AgentEvent) =>
  String(
    event.payload.toolCallId ??
      (event.payload.item as { id?: string } | undefined)?.id ??
      event.id,
  );

/** Last tool call that started and has not finished inside the active turn. */
function runningTool(session: AgentSession, events: AgentEvent[]) {
  const finished = new Set<string>();
  for (const event of [...events].reverse()) {
    if (session.activeTurnId && event.turnId !== session.activeTurnId) continue;
    const id = toolKey(event);
    if (["tool.completed", "tool.failed"].includes(event.type)) {
      finished.add(id);
      continue;
    }
    if (event.type === "tool.started" && !finished.has(id)) return event;
  }
  return undefined;
}

function latestUserText(session: AgentSession, events: AgentEvent[]) {
  for (const event of [...events].reverse()) {
    if (session.activeTurnId && event.turnId !== session.activeTurnId) continue;
    if (event.type !== "user.message") continue;
    const text =
      (event.payload.text as string | undefined) ??
      (event.payload.message as { text?: string } | undefined)?.text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
}

const ZH_STAGES = [
  "正在通读会话",
  "正在梳理问题",
  "正在核对材料",
  "正在组织思路",
  "正在推演下一步",
];
const EN_STAGES = [
  "Reading the conversation",
  "Untangling the question",
  "Checking the material",
  "Shaping the approach",
  "Working out the next step",
];

/** Elapsed-aware stage text, so a long turn reads as progress rather than a frozen label. */
export function stageText(
  elapsed: number,
  started: { events: number; tools: number; reasoning: boolean; reply: boolean },
  en: boolean,
) {
  if (started.reasoning) return en ? "Thinking it through" : "正在权衡思路";
  if (started.reply) return en ? "Composing the answer" : "正在落笔作答";
  const index = Math.min(
    ZH_STAGES.length - 1,
    Math.floor(elapsed / (en ? 6 : 5)),
  );
  const base = en ? EN_STAGES[index] : ZH_STAGES[index];
  if (elapsed < 30) return base;
  return en ? `${base} · ${elapsed}s` : `${base} · 已 ${elapsed} 秒`;
}

/**
 * One line describing the live turn. A running tool wins because it names the
 * concrete action; otherwise the wording advances with elapsed time.
 */
export function workingStatus(
  session: AgentSession | undefined,
  events: AgentEvent[],
  en: boolean,
  now = Date.now(),
): WorkingStatus | null {
  if (session?.status === "stopping" || session?.cancellingTurnId)
    return { phase: "stopping", text: en ? "Stopping" : "正在停止", tool: false };
  if (session?.status !== "running") return null;
  const startedAt = events.find(
    (event) => !session.activeTurnId || event.turnId === session.activeTurnId,
  )?.occurredAt;
  const elapsed = startedAt
    ? Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000))
    : 0;
  const tool = runningTool(session, events);
  if (tool) {
    const label =
      topolumiaToolLabel({ events: [tool] }, en, "running") ??
      (en
        ? `Calling ${describeTool({ events: [tool] }, true).label}`
        : `正在调用 ${describeTool({ events: [tool] }, false).label}`);
    return {
      phase: `tool:${toolKey(tool)}`,
      text: label,
      elapsed: elapsed >= 10 ? elapsed : undefined,
      tool: true,
    };
  }
  const tail = events.slice(-12).reverse();
  const reasoning = tail.some(
    (event) =>
      event.type === "reasoning.summary.delta" ||
      (event.type === "reasoning.summary.snapshot" &&
        event.payload.completion === "streaming"),
  );
  const reply = tail.some(
    (event) =>
      event.type === "assistant.message.delta" ||
      (event.type === "assistant.message.snapshot" &&
        event.payload.completion === "streaming"),
  );
  const stage = stageText(elapsed, { events: events.length, tools: 0, reasoning, reply }, en);
  return {
    phase: `${reasoning ? "reasoning" : reply ? "reply" : "stage"}:${Math.floor(elapsed / 5)}`,
    text: stage,
    elapsed: elapsed >= 10 ? elapsed : undefined,
    tool: false,
  };
}

/** Recent user wording, used to keep the placeholder grounded in the actual task. */
export function workingHint(session: AgentSession | undefined, events: AgentEvent[]) {
  if (!session) return "";
  return latestUserText(session, events).replace(/\s+/g, " ").slice(0, 80);
}
