import type { AgentEvent } from "@/shared/types/api";
import {
  actorKey,
  compactConversationEvents,
  contentBlockId,
  reasoningStreamKey,
} from "@domain/agents/agent-conversation";
import type { AgentCompletion } from "@domain/agents/agent-conversation";
import type { AgentApproval } from "@domain/agents/agent-approval";
import { isImageView } from "@domain/agents/agent-images";
import type { AgentImageAttachment } from "@domain/agents/agent-attachments";

export type ConversationItem = {
  kind:
    | "message"
    | "tool"
    | "image"
    | "image-gallery"
    | "plan"
    | "reasoning"
    | "approval"
    | "status"
    | "activity"
    | "subagent"
    | "activity-batch";
  key: string;
  role?: "user" | "assistant";
  text?: string;
  attachments?: AgentImageAttachment[];
  streaming?: boolean;
  title?: string;
  status?: string;
  detail?: string;
  requestId?: string;
  events?: AgentEvent[];
  turnKey?: string;
  callCount?: number;
  pendingCount?: number;
  failedCount?: number;
  nativeMessageId?: string;
  agentId?: string;
  agentName?: string;
  parentAgentId?: string;
  parentToolUseId?: string;
  completion?: AgentCompletion;
  phase?: string;
  finalReply?: boolean;
  children?: ConversationItem[];
  approval?: AgentApproval;
  sourceEventIds?: string[];
};
const stringValue = (value: unknown) =>
  typeof value === "string" ? value : undefined;
function metadata(event: AgentEvent): Partial<ConversationItem> {
  const p = event.payload;
  return {
    turnKey: event.turnId ?? "session",
    nativeMessageId: stringValue(p.nativeMessageId),
    agentId: stringValue(p.agentId),
    agentName: stringValue(p.agentName),
    parentAgentId: stringValue(p.parentAgentId),
    parentToolUseId: stringValue(p.parentToolUseId),
    completion: p.completion as AgentCompletion | undefined,
    phase: stringValue(p.phase),
  };
}

export function normalizeConversation(
  events: AgentEvent[],
  options: { compacted?: boolean } = {},
): ConversationItem[] {
  const items: ConversationItem[] = [];
  const byKey = new Map<string, ConversationItem>();
  const batches = new Map<string, ConversationItem>();
  const terminalTurns = new Set<string>();
  const completedTurns = new Set<string>();
  let sessionEnded = false;
  const add = (item: ConversationItem) => {
    const previous = byKey.get(item.key);
    if (previous) return previous;
    items.push(item);
    byKey.set(item.key, item);
    return item;
  };
  for (const event of options.compacted
    ? events
    : compactConversationEvents(events)) {
    const payload = event.payload;
    const meta = metadata(event);
    const turn = event.turnId ?? "session";
    const actor = actorKey(payload);
    if (event.type === "turn.started") sessionEnded = false;
    if (event.type === "turn.completed") completedTurns.add(turn);
    if (
      [
        "turn.completed",
        "turn.cancelled",
        "turn.failed",
        "session.closed",
      ].includes(event.type)
    ) {
      if (event.type === "session.closed") sessionEnded = true;
      else terminalTurns.add(turn);
      for (const item of items) {
        if (event.type !== "session.closed" && item.turnKey !== turn) continue;
        if (
          item.streaming &&
          (!item.completion || item.completion === "streaming")
        )
          item.completion =
            event.type === "turn.failed"
              ? "failed"
              : event.type === "turn.cancelled"
                ? "interrupted"
                : "incomplete";
        item.streaming = false;
        if (item.kind === "approval" && item.status === "pending") {
          item.status = "resolved";
          if (item.approval)
            item.approval = {
              ...item.approval,
              status: "resolved",
              decision:
                event.type === "turn.cancelled" ? "cancelled" : "expired",
            };
        }
        if (["tool", "image"].includes(item.kind) && item.status === "running") {
          item.status =
            event.type === "turn.failed"
              ? "failed"
              : event.type === "turn.cancelled"
                ? "cancelled"
                : "incomplete";
          item.pendingCount = 0;
        }
      }
    }
    if (event.type === "user.message") {
      add({
        ...meta,
        kind: "message",
        key: `user:${event.id}`,
        role: "user",
        attachments: payload.attachments as AgentImageAttachment[] | undefined,
        ...(Array.isArray(payload.attachments) && payload.attachments.length ? { events: [event] } : {}),
        text: String(payload.text ?? ""),
      });
      continue;
    }
    if (event.type.startsWith("assistant.message.")) {
      const streaming =
        event.type === "assistant.message.delta" ||
        (event.type === "assistant.message.snapshot" &&
          payload.completion === "streaming");
      add({
        ...meta,
        kind: "message",
        key: `assistant:${turn}:${actor}:${contentBlockId(payload)}`,
        role: "assistant",
        text: String(payload.text ?? payload.delta ?? ""),
        streaming,
        sourceEventIds: [event.id],
      });
      continue;
    }
    if (event.type.startsWith("tool.")) {
      const tool = payload as {
        toolCallId?: string;
        title?: string;
        tool?: string;
        kind?: string;
        item?: {
          id?: string;
          command?: string;
          tool?: string;
          [key: string]: unknown;
        };
      };
      const callKey = `${turn}:${actor}:${tool.toolCallId ?? tool.item?.id ?? event.id}`;
      const title = String(
        tool.item?.command ??
          tool.item?.tool ??
          tool.tool ??
          tool.title ??
          tool.kind ??
          "工具调用",
      );
      let item = batches.get(callKey);
      if (!item) {
        // Each call stays independently inspectable; activity batches provide
        // the shared summary without merging multiple inputs and outputs.
        item = add({
          ...meta,
          kind: isImageView(event) ? "image" : "tool",
          key: `tool:${callKey}`,
          title,
          status: "running",
          events: [],
          callCount: 0,
        });
        batches.set(callKey, item);
        item.callCount = (item.callCount ?? 0) + 1;
      }
      item.events?.push(event);
      if (isImageView(event)) item.kind = "image";
      const status =
        event.type === "tool.failed"
          ? payload.completion === "incomplete"
            ? "incomplete"
            : payload.completion === "interrupted"
              ? "cancelled"
              : "failed"
          : event.type === "tool.completed"
            ? "completed"
            : (item.status ?? "running");
      item.pendingCount = status === "running" ? 1 : 0;
      item.failedCount = status === "failed" ? 1 : 0;
      item.status = status;
      continue;
    }
    if (event.type.startsWith("reasoning.summary.")) {
      add({
        ...meta,
        kind: "reasoning",
        key: reasoningStreamKey(event),
        title: "推理摘要",
        text: String(payload.text ?? payload.delta ?? ""),
        streaming:
          event.type === "reasoning.summary.delta" ||
          (event.type.endsWith(".snapshot") &&
            payload.completion === "streaming"),
      });
      continue;
    }
    if (event.type === "plan.updated") {
      add({
        ...meta,
        kind: "plan",
        key: `plan:${turn}:${actor}:${payload.planId ?? payload.itemId ?? payload.nativeItemId ?? "turn-plan"}`,
        title: "执行计划",
        detail:
          typeof payload.text === "string"
            ? payload.text
            : Array.isArray(payload.entries)
              ? JSON.stringify(payload.entries, null, 2)
              : String(payload.delta ?? ""),
      });
      continue;
    }
    if (event.type === "agent.activity" || event.type === "agent.delegated") {
      add({
        ...meta,
        agentId: meta.agentId ?? stringValue(payload.nativeItemId),
        agentName: meta.agentName ?? stringValue(payload.agent),
        kind: "activity",
        key: `activity:${turn}:${actor}:${payload.nativeItemId ?? ""}`,
        title: String(payload.agentName ?? payload.description ?? "子 Agent"),
        status: String(
          payload.status ??
            (event.type === "agent.delegated" ? "delegated" : "unknown"),
        ),
        detail: String(payload.summary ?? payload.description ?? ""),
      });
      continue;
    }
    if (
      event.type === "files.changed" ||
      event.type === "agent.question.unsupported"
    ) {
      add({
        ...meta,
        kind: "status",
        key: `activity:${event.id}`,
        title: event.type === "files.changed" ? "文件变更" : "交互问题",
        detail:
          event.type === "files.changed"
            ? JSON.stringify(
                { files: payload.files, hash: payload.hash },
                null,
                2,
              )
            : "当前会话尚不支持交互问答，已拒绝该请求。",
      });
      continue;
    }
    if (
      event.type === "approval.requested" ||
      event.type === "approval.resolved"
    ) {
      const key = `approval:${payload.requestId ?? event.id}`;
      const item = add({
        ...meta,
        kind: "approval",
        key,
        title: "等待审批",
        status: "pending",
      });
      item.requestId = String(payload.requestId ?? "");
      item.detail = String(
        payload.reason ?? payload.command ?? payload.decision ?? "",
      );
      item.status = event.type === "approval.resolved" ? "resolved" : "pending";
      item.approval = {
        ...item.approval,
        ...payload,
        requestId: item.requestId,
        options: (payload.options ??
          item.approval?.options ??
          []) as AgentApproval["options"],
        status: item.status,
      } as AgentApproval;
      if (
        event.type === "approval.requested" &&
        (sessionEnded || terminalTurns.has(turn))
      ) {
        item.status = "resolved";
        item.approval.status = "resolved";
        item.approval.decision = "expired";
      }
      continue;
    }
    if (
      ["turn.failed", "turn.retrying", "session.status"].includes(event.type)
    ) {
      const error = payload.error as { message?: string } | undefined;
      if (
        event.type === "session.status" &&
        !error &&
        payload.status !== "failed"
      )
        continue;
      add({
        ...meta,
        kind: "status",
        key: `status:${event.id}`,
        title:
          event.type === "turn.failed"
            ? "回合失败"
            : event.type === "turn.retrying"
              ? "正在重试"
              : "会话状态",
        status: String(payload.status ?? "info"),
        detail: String(
          error?.message ?? payload.message ?? payload.status ?? "",
        ),
      });
    }
  }
  const visible = items.filter(
    (item) => item.kind !== "reasoning" || Boolean(item.text?.trim()),
  );
  // Adjacent text blocks in the same native message read as one reply. Tool and
  // reasoning entries preserve their actual positions between message blocks.
  const merged: ConversationItem[] = [];
  for (const item of visible) {
    const last = merged.at(-1);
    if (
      item.kind === "message" &&
      item.role === "assistant" &&
      item.nativeMessageId &&
      last?.kind === "message" &&
      last.role === "assistant" &&
      item.nativeMessageId === last.nativeMessageId &&
      item.turnKey === last.turnKey &&
      item.agentId === last.agentId &&
      item.parentToolUseId === last.parentToolUseId &&
      item.phase === last.phase
    ) {
      last.text = `${last.text ?? ""}${item.text ?? ""}`;
      last.streaming ||= item.streaming;
      last.sourceEventIds = [
        ...(last.sourceEventIds ?? []),
        ...(item.sourceEventIds ?? []),
      ];
      if (item.completion && item.completion !== "completed")
        last.completion = item.completion;
    } else merged.push(item);
  }
  // Claude Code and OpenCode do not label commentary/final phases. Only the
  // last reply after all activity in a successful turn gets message actions.
  const lastContent = new Map<string, ConversationItem>();
  for (const item of merged) {
    if (["message", "tool", "image", "reasoning", "plan"].includes(item.kind))
      lastContent.set(
        `${item.turnKey}:${item.agentId ?? ""}:${item.parentToolUseId ?? ""}`,
        item,
      );
  }
  for (const item of lastContent.values()) {
    if (
      item.kind === "message" &&
      item.role === "assistant" &&
      item.phase !== "commentary" &&
      !item.streaming &&
      (!item.completion || item.completion === "completed") &&
      completedTurns.has(item.turnKey ?? "session")
    )
      item.finalReply = true;
  }
  return groupAgents(merged);
}

function groupAgents(items: ConversationItem[]): ConversationItem[] {
  const roots: ConversationItem[] = [];
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const item of items)
    if (item.agentId && item.parentToolUseId) {
      const key = `${item.turnKey}:${item.parentToolUseId}`;
      if (aliases.has(key) && aliases.get(key) !== item.agentId) {
        aliases.delete(key);
        ambiguous.add(key);
      }
      if (!ambiguous.has(key)) aliases.set(key, item.agentId);
    }
  const groups = new Map<string, ConversationItem>();
  const identities = new Map<string, Partial<ConversationItem>>();
  for (const item of items) {
    const id =
      item.agentId ??
      (item.parentToolUseId
        ? (aliases.get(`${item.turnKey}:${item.parentToolUseId}`) ??
          item.parentToolUseId)
        : null);
    if (id)
      identities.set(`${item.turnKey}:${id}`, {
        ...identities.get(`${item.turnKey}:${id}`),
        ...Object.fromEntries(
          Object.entries(item).filter(([, value]) => value !== undefined),
        ),
      });
  }
  const ensure = (
    id: string,
    item: Partial<ConversationItem>,
    visited = new Set<string>(),
  ): ConversationItem => {
    item = identities.get(`${item.turnKey}:${id}`) ?? item;
    const key = `subagent:${item.turnKey}:${id}`;
    const known = groups.get(key);
    if (known) return known;
    const group: ConversationItem = {
      kind: "subagent",
      key,
      agentId: id,
      title: item.agentName ?? id,
      turnKey: item.turnKey,
      children: [],
    };
    groups.set(key, group);
    visited.add(id);
    if (item.parentAgentId && !visited.has(item.parentAgentId)) {
      ensure(
        item.parentAgentId,
        { turnKey: item.turnKey },
        visited,
      ).children!.push(group);
    } else roots.push(group);
    return group;
  };
  for (const item of items) {
    const id =
      item.agentId ??
      (item.parentToolUseId
        ? (aliases.get(`${item.turnKey}:${item.parentToolUseId}`) ??
          item.parentToolUseId)
        : null);
    if (!id) {
      roots.push(item);
      continue;
    }
    const group = ensure(id, item);
    if (item.agentName) group.title = item.agentName;
    if (item.kind === "activity") {
      group.status = item.status;
      group.detail = item.detail;
    } else {
      group.children!.push(item);
      if (item.streaming) group.status = "running";
    }
  }
  return roots;
}
