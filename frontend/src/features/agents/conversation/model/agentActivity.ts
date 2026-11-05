import type { ConversationItem } from "./agentConversation";
import { describeTool } from "../../tools/agentTool";

const activity = (item: ConversationItem) =>
  ["tool", "reasoning", "plan"].includes(item.kind);

export function groupActivityRuns(
  items: ConversationItem[],
): ConversationItem[] {
  const result: ConversationItem[] = [];
  let run: ConversationItem[] = [];
  let images: ConversationItem[] = [];
  const flushImages = () => {
    if (!images.length) return;
    const summary = activitySummary(images, false);
    result.push({
      kind: "image-gallery",
      key: `images:${images[0].key}`,
      turnKey: images[0].turnKey,
      agentId: images[0].agentId,
      parentToolUseId: images[0].parentToolUseId,
      children: images,
      status: summary.status,
    });
    images = [];
  };
  const flush = () => {
    if (!run.length) return;
    if (run.length > 1 || (run[0].callCount ?? 1) > 1)
      result.push({
        kind: "activity-batch",
        key: run[0].key,
        turnKey: run[0].turnKey,
        children: run,
      });
    else result.push(run[0]);
    run = [];
  };
  for (const item of items) {
    if (item.kind === "image") {
      flush();
      const firstImage = images[0];
      if (
        firstImage &&
        (firstImage.turnKey !== item.turnKey ||
          firstImage.agentId !== item.agentId ||
          firstImage.parentToolUseId !== item.parentToolUseId)
      )
        flushImages();
      images.push(item);
      continue;
    }
    flushImages();
    const first = run[0];
    if (
      first &&
      (first.turnKey !== item.turnKey ||
        first.agentId !== item.agentId ||
        first.parentToolUseId !== item.parentToolUseId)
    )
      flush();
    if (activity(item)) run.push(item);
    else {
      flush();
      result.push(item);
    }
  }
  flush();
  flushImages();
  return result;
}

export function activitySummary(items: ConversationItem[], en: boolean) {
  const tools = new Map<string, { label: string; count: number }>();
  let reasoning = 0,
    plans = 0,
    failed = 0,
    incomplete = 0,
    running = false;
  for (const item of items) {
    if (item.kind === "reasoning") reasoning++;
    if (item.kind === "plan") plans++;
    if (item.kind === "tool") {
      const tool = describeTool(item, en);
      tools.set(tool.key, {
        label: tool.label,
        count: (tools.get(tool.key)?.count ?? 0) + (item.callCount ?? 1),
      });
    }
    failed +=
      item.failedCount ??
      (item.status === "failed" || item.completion === "failed" ? 1 : 0);
    if (
      ["incomplete", "cancelled"].includes(item.status ?? "") ||
      ["incomplete", "interrupted"].includes(item.completion ?? "")
    )
      incomplete++;
    running ||= Boolean(
      item.streaming || item.pendingCount || item.status === "running",
    );
  }
  const parts: string[] = [];
  if (tools.size)
    parts.push(
      en
        ? `Called ${[...tools.values()].map(({ label, count }) => `${label} ×${count}`).join(", ")}`
        : `调用了 ${[...tools.values()].map(({ label, count }) => `${count} 次 ${label}`).join("、")}`,
    );
  if (reasoning)
    parts.push(
      en
        ? `${reasoning} reasoning ${reasoning === 1 ? "step" : "steps"}`
        : `思考 ${reasoning} 次`,
    );
  if (plans)
    parts.push(
      en
        ? `${plans} plan ${plans === 1 ? "update" : "updates"}`
        : `更新计划 ${plans} 次`,
    );
  const separator = en ? "; " : "；";
  return {
    text: parts.join(separator),
    primary: tools.size ? parts[0] : parts.join(separator),
    secondary: tools.size ? parts.slice(1).join(separator) : "",
    status: running
      ? "running"
      : failed
        ? "failed"
        : incomplete
          ? "incomplete"
          : "completed",
    failed,
    incomplete,
  };
}
