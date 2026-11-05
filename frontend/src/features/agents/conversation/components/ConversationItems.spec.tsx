import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationItems } from "./ConversationItems";
import { normalizeConversation } from "@/features/agents/conversation/model/agentConversation";
import type { AgentEvent } from "@/shared/types/api";

afterEach(cleanup);
const event = (
  cursor: number,
  type: string,
  payload: Record<string, unknown>,
): AgentEvent => ({
  id: `e${cursor}`,
  cursor,
  type,
  payload,
  sessionId: "s",
  turnId: "turn",
  occurredAt: "",
});

it("omits redundant agent names below reasoning and animates only unfinished activity", () => {
  const props = {
    en: false,
    approvalPending: false,
    onApproval: vi.fn(),
    agentLabel: "Claude Code",
  };
  const { container, rerender } = render(
    <ConversationItems
      {...props}
      items={normalizeConversation([
        event(1, "reasoning.summary.completed", {
          blockId: "r",
          text: "Reasoning",
        }),
        event(2, "tool.started", {
          toolCallId: "a",
          title: "mcp__topolumia__search",
        }),
        event(3, "assistant.message.completed", {
          blockId: "answer",
          text: "Evidence-based answer",
        }),
      ])}
    />,
  );
  expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
  expect(screen.getByText("Evidence-based answer")).toBeVisible();
  expect(
    container.querySelector(".activity-batch[data-state='running']"),
  ).toHaveAttribute("aria-busy", "true");
  expect(container.querySelectorAll(".message header")).toHaveLength(0);
  rerender(
    <ConversationItems
      {...props}
      items={normalizeConversation([
        event(1, "reasoning.summary.completed", {
          blockId: "r",
          text: "Reasoning",
        }),
        event(2, "tool.completed", {
          toolCallId: "a",
          title: "mcp__topolumia__search",
        }),
      ])}
    />,
  );
  expect(container.querySelector("[data-state='running']")).toBeNull();
});

it("uses one renderer to show child output inside its agent group and the parent answer outside it", async () => {
  const items = normalizeConversation([
    event(1, "agent.activity", {
      agentId: "child",
      parentToolUseId: "call",
      agentName: "文献检查",
      status: "completed",
    }),
    event(2, "assistant.message.completed", {
      blockId: "child-block",
      nativeMessageId: "child-message",
      agentId: "child",
      parentToolUseId: "call",
      text: "Child evidence.",
    }),
    event(3, "assistant.message.completed", {
      blockId: "parent-a",
      nativeMessageId: "parent-message",
      text: "First block. ",
    }),
    event(4, "assistant.message.completed", {
      blockId: "parent-b",
      nativeMessageId: "parent-message",
      text: "Second block.",
    }),
  ]);
  const { container } = render(
    <ConversationItems
      items={items}
      en={false}
      approvalPending={false}
      onApproval={vi.fn()}
      agentLabel="Agent"
    />,
  );
  const group = container.querySelector<HTMLDetailsElement>(".subagent-group")!;
  expect(group).toHaveTextContent("文献检查");
  expect(group.querySelector(".message-body")).toBeNull();
  group.open = true;
  fireEvent(group, new Event("toggle"));
  await waitFor(() =>
    expect(group.querySelector(".message-body")).toHaveTextContent(
      "Child evidence.",
    ),
  );
  expect(container.querySelectorAll(".message-body")).toHaveLength(2);
  expect(
    screen.getByText("First block. Second block.").closest(".subagent-group"),
  ).toBeNull();
  fireEvent.click(group.querySelector("summary")!);
});

it("keeps interrupted output visible and marks its completion state", () => {
  render(
    <ConversationItems
      items={normalizeConversation([
        event(1, "assistant.message.completed", {
          blockId: "partial",
          text: "Partial answer",
          completion: "interrupted",
        }),
      ])}
      en={false}
      approvalPending={false}
      onApproval={vi.fn()}
    />,
  );
  expect(screen.getByText("Partial answer")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("已中断");
});

it.each([true, false])(
  "shows message actions only on the final turn reply (native phases: %s)",
  (phases) => {
    const rows = [
      event(1, "assistant.message.completed", {
        blockId: "progress",
        text: "先检查材料。",
        ...(phases ? { phase: "commentary" } : {}),
      }),
      event(2, "tool.completed", { toolCallId: "read", title: "Read" }),
      event(3, "assistant.message.completed", {
        blockId: "answer",
        text: "最终研究结果。",
        ...(phases ? { phase: "final_answer" } : {}),
      }),
    ];
    const props = { en: false, onApproval: vi.fn(), onSave: vi.fn() };
    const { container, rerender } = render(
      <ConversationItems {...props} items={normalizeConversation(rows)} />,
    );
    expect(container.querySelector(".message-actions")).toBeNull();
    rerender(
      <ConversationItems
        {...props}
        items={normalizeConversation([...rows, event(4, "turn.completed", {})])}
      />,
    );
    expect(
      screen
        .getByText("先检查材料。")
        .closest(".message")!
        .querySelector(".message-actions"),
    ).toBeNull();
    expect(screen.getAllByRole("button", { name: "复制消息" })).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "整理为科研笔记" }),
    ).toHaveLength(1);
    expect(
      screen
        .getByRole("button", { name: "整理为科研笔记" })
        .closest(".message"),
    ).toHaveTextContent("最终研究结果。");
  },
);

it("keeps repeated MCP calls independently collapsed after opening the activity summary", async () => {
  const items = normalizeConversation([
    event(1, "tool.started", {
      toolCallId: "a",
      title: "mcp__topolumia__search",
      rawInput: { query: "first" },
    }),
    event(2, "tool.completed", { toolCallId: "a", rawOutput: { total: 1 } }),
    event(3, "tool.started", {
      toolCallId: "b",
      title: "mcp__topolumia__search",
      rawInput: { query: "second" },
    }),
    event(4, "tool.completed", { toolCallId: "b", rawOutput: { total: 2 } }),
  ]);
  const { container } = render(
    <ConversationItems items={items} en={false} onApproval={vi.fn()} />,
  );
  const batch = container.querySelector<HTMLDetailsElement>(".activity-batch")!;
  batch.open = true;
  fireEvent(batch, new Event("toggle"));
  await waitFor(() =>
    expect(container.querySelectorAll(".tool-group")).toHaveLength(2),
  );
  expect(container.querySelector(".tool-result-view")).toBeNull();
  const call = container.querySelector<HTMLDetailsElement>(".tool-group")!;
  call.open = true;
  fireEvent(call, new Event("toggle"));
  await waitFor(() =>
    expect(container.querySelectorAll(".tool-result-view")).toHaveLength(1),
  );
  expect(container.querySelector(".tool-input-view")).toHaveTextContent(
    "first",
  );
  expect(
    container.querySelectorAll<HTMLDetailsElement>(".tool-group")[1].open,
  ).toBe(false);
});

it("updates plan snapshots and removes deleted blocks without reviving them from old history", () => {
  const items = normalizeConversation([
    event(1, "plan.updated", { itemId: "plan", delta: "Draft" }),
    event(2, "plan.updated", {
      itemId: "plan",
      text: "Authoritative plan",
      updateKind: "snapshot",
    }),
    event(3, "assistant.message.completed", {
      blockId: "removed",
      text: "Obsolete",
    }),
    event(4, "content.removed", { targetId: "removed" }),
    event(5, "assistant.message.completed", {
      blockId: "removed",
      text: "Obsolete",
    }),
  ]);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    kind: "plan",
    detail: "Authoritative plan",
  });
});

it("preserves nesting when a child agent's events precede its parent's events", () => {
  const items = normalizeConversation([
    event(1, "assistant.message.completed", {
      blockId: "leaf",
      agentId: "leaf",
      parentAgentId: "middle",
      text: "Leaf",
    }),
    event(2, "agent.activity", {
      agentId: "middle",
      parentAgentId: "root-agent",
      agentName: "Middle",
    }),
    event(3, "agent.activity", { agentId: "root-agent", agentName: "Root" }),
  ]);
  expect(items).toHaveLength(1);
  expect(items[0].agentId).toBe("root-agent");
  expect(items[0].children?.[0].agentId).toBe("middle");
  expect(items[0].children?.[0].children?.[0].agentId).toBe("leaf");
});

it("does not guess an agent for legacy packets with an ambiguous shared tool call", () => {
  const items = normalizeConversation([
    event(1, "agent.activity", {
      agentId: "a",
      parentToolUseId: "shared",
      agentName: "Agent A",
    }),
    event(2, "agent.activity", {
      agentId: "b",
      parentToolUseId: "shared",
      agentName: "Agent B",
    }),
    event(3, "assistant.message.completed", {
      blockId: "unknown",
      parentToolUseId: "shared",
      text: "Unattributed child",
    }),
  ]);
  expect(items.map((item) => item.agentId)).toEqual(["a", "b", "shared"]);
  expect(items[2].children?.[0].text).toBe("Unattributed child");
});

it("uses semantic icons for reasoning, MCP, terminals, discovery, files, plans and approvals", () => {
  const items = normalizeConversation([
    event(1, "reasoning.summary.completed", {
      blockId: "r",
      text: "Check evidence.",
    }),
    event(2, "tool.completed", {
      toolCallId: "context",
      title: "mcp__topolumia__get_context",
    }),
    event(3, "tool.completed", {
      toolCallId: "papers",
      kind: "mcpToolCall",
      item: { server: "papers", tool: "search" },
    }),
    event(4, "tool.completed", { toolCallId: "bash", title: "Bash" }),
    event(5, "tool.completed", { toolCallId: "discover", title: "ToolSearch" }),
    event(6, "tool.completed", { toolCallId: "read", title: "Read" }),
    event(7, "tool.completed", { toolCallId: "write", title: "Write" }),
    event(8, "plan.updated", { text: "Review evidence." }),
    event(9, "approval.requested", {
      requestId: "approve",
      reason: "Write a result.",
    }),
  ]);
  const { container } = render(
    <ConversationItems
      items={items}
      en={false}
      approvalPending={false}
      onApproval={vi.fn()}
      groupActivities={false}
    />,
  );
  const icons = [
    ...container.querySelectorAll(
      "summary > .agent-motion-icon > [data-event-icon], .agent-approval > header > .agent-motion-icon > [data-event-icon]",
    ),
  ];
  expect(icons.map((icon) => icon.getAttribute("data-event-icon"))).toEqual([
    "reasoning",
    "mcp",
    "mcp",
    "terminal",
    "search",
    "file-read",
    "file-edit",
    "plan",
    "approval",
  ]);
  expect(
    icons.every((icon) => icon.getAttribute("aria-hidden") === "true"),
  ).toBe(true);
  expect(icons[1].innerHTML).toBe(icons[2].innerHTML);
  expect(new Set(icons.map((icon) => icon.innerHTML)).size).toBe(8);
  expect(screen.getByText("读取科研上下文")).toBeInTheDocument();
});

it("shows only MCP server counts in the collapsed batch while keeping internal tools in its details", async () => {
  const items = normalizeConversation([
    event(1, "reasoning.summary.completed", {
      blockId: "r",
      text: "Check evidence.",
    }),
    event(2, "tool.completed", {
      toolCallId: "a",
      title: "mcp__topolumia__get_context",
    }),
    event(3, "tool.completed", {
      toolCallId: "b",
      title: "mcp__topolumia__search",
    }),
  ]);
  const { container } = render(
    <ConversationItems
      items={items}
      en={false}
      approvalPending={false}
      onApproval={vi.fn()}
    />,
  );
  const batch = container.querySelector<HTMLDetailsElement>(".activity-batch")!;
  expect(batch.open).toBe(false);
  expect(batch.querySelector(":scope > summary")).toHaveTextContent(
    "调用了 2 次 Topolumia MCP；思考 1 次",
  );
  expect(batch.querySelector(":scope > summary")).not.toHaveTextContent(
    /get_context|search/,
  );
  expect(batch.querySelector(".activity-batch-body")).toBeEmptyDOMElement();
  batch.open = true;
  fireEvent(batch, new Event("toggle"));
  await waitFor(() =>
    expect(
      batch.querySelectorAll(
        ".activity-batch-body summary [data-event-icon='mcp']",
      ),
    ).toHaveLength(2),
  );
  expect(batch.querySelector(".activity-batch-body")).toHaveTextContent(
    "读取科研上下文",
  );
});
