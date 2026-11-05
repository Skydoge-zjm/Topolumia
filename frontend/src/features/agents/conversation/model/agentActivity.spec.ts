import { describe, expect, it } from "vitest";
import { activitySummary, groupActivityRuns } from "./agentActivity";
import type { ConversationItem } from "./agentConversation";
import { normalizeConversation } from "./agentConversation";
import type { AgentEvent } from "@/shared/types/api";

const tool = (key: string, title: string, callCount = 1): ConversationItem => ({
  kind: "tool",
  key,
  title,
  callCount,
  status: "completed",
  turnKey: "turn",
});
const thinking = (key: string): ConversationItem => ({
  kind: "reasoning",
  key,
  text: key,
  turnKey: "turn",
  streaming: false,
});
const event = (
  cursor: number,
  payload: Record<string, unknown>,
  type = "tool.completed",
): AgentEvent => ({
  id: `e${cursor}`,
  cursor,
  type,
  payload,
  turnId: "turn",
  sessionId: "s",
  occurredAt: "",
});

describe("consecutive agent activity", () => {
  it("groups consecutive image views without crossing messages, tools, turns or actors", () => {
    const image = (cursor: number) =>
      event(cursor, {
        toolCallId: `image-${cursor}`,
        kind: "imageView",
        item: { type: "imageView", path: `E:/papers/figure-${cursor}.png` },
      });
    const rows = groupActivityRuns(
      normalizeConversation([
        image(1),
        image(2),
        event(
          3,
          { blockId: "progress", text: "Check the next figure." },
          "assistant.message.completed",
        ),
        image(4),
        event(5, {
          toolCallId: "shell",
          kind: "commandExecution",
          item: { command: "pwd" },
        }),
        { ...image(6), turnId: "other" },
        image(7),
        { ...image(8), payload: { ...image(8).payload, agentId: "child" } },
      ]),
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "image-gallery",
      "message",
      "image-gallery",
      "tool",
      "image-gallery",
      "image-gallery",
      "subagent",
    ]);
    expect(rows[0].children).toHaveLength(2);
    expect(rows[2].children).toHaveLength(1);
    expect(rows[4].turnKey).toBe("other");
    expect(rows[5].turnKey).toBe("turn");
  });
  it("summarizes mixed tools and separate reasoning blocks in one row with exact call counts", () => {
    const children = [
      thinking("r1"),
      tool("a", "mcp__topolumia__get_context"),
      thinking("r2"),
      tool("b", "topolumia_search", 3),
    ];
    const result = groupActivityRuns(children);
    expect(result).toHaveLength(1);
    expect(result[0].children).toEqual(children);
    expect(activitySummary(result[0].children!, false).text).toBe(
      "调用了 4 次 Topolumia MCP；思考 2 次",
    );
  });
  it("never folds user messages, assistant replies or approvals into activity", () => {
    const messages: ConversationItem[] = [
      tool("a", "Read"),
      thinking("r1"),
      { kind: "message", key: "answer", role: "assistant", text: "Answer" },
      tool("b", "Read"),
      { kind: "approval", key: "permission", status: "pending" },
      thinking("r2"),
    ];
    expect(groupActivityRuns(messages).map((item) => item.kind)).toEqual([
      "activity-batch",
      "message",
      "tool",
      "approval",
      "reasoning",
    ]);
  });
  it("separates native actors and turns and retains failure information outside the summary text", () => {
    const items = [
      tool("a", "Read"),
      { ...thinking("r1"), agentId: "child" },
      { ...tool("b", "Read"), turnKey: "other" },
    ];
    expect(groupActivityRuns(items)).toHaveLength(3);
    expect(
      activitySummary(
        [{ ...tool("failed", "Read"), status: "failed", failedCount: 1 }],
        false,
      ),
    ).toMatchObject({ failed: 1, status: "failed" });
  });
  it("counts Codex, Claude and OpenCode calls under the same MCP server without losing individual call counts", () => {
    const items = [
      {
        ...tool("codex", "search", 2),
        events: [
          event(1, {
            kind: "mcpToolCall",
            item: { server: "topolumia", tool: "search" },
          }),
        ],
      },
      {
        ...tool("claude", "mcp__topolumia__read_nodes"),
        events: [
          event(
            2,
            {
              title: "mcp__topolumia__read_nodes",
              kind: "mcp__topolumia__read_nodes",
            },
            "tool.started",
          ),
          event(3, { kind: "tool_result" }),
        ],
      },
      {
        ...tool("opencode", "topolumia_get_context"),
        events: [
          event(4, {
            kind: "dynamicToolCall",
            item: { tool: "topolumia_get_context" },
          }),
        ],
      },
      tool("discover", "ToolSearch"),
      thinking("r1"),
    ];
    expect(activitySummary(items, false).text).toBe(
      "调用了 4 次 Topolumia MCP、1 次 ToolSearch；思考 1 次",
    );
    expect(activitySummary(items, true).text).toBe(
      "Called Topolumia MCP ×4, ToolSearch ×1; 1 reasoning step",
    );
  });
  it("keeps servers with identically named tools separate before folding and distinguishes Bash from an unspecified terminal", () => {
    const items = normalizeConversation([
      event(
        1,
        {
          toolCallId: "a",
          kind: "mcpToolCall",
          item: { server: "topolumia", tool: "search" },
        },
        "tool.started",
      ),
      event(2, { toolCallId: "a" }),
      event(
        3,
        {
          toolCallId: "b",
          kind: "mcpToolCall",
          item: { server: "papers", tool: "search" },
        },
        "tool.started",
      ),
      event(4, { toolCallId: "b" }),
      event(5, { toolCallId: "c", title: "Bash" }),
      event(6, {
        toolCallId: "d",
        kind: "commandExecution",
        item: { command: "Get-Location" },
      }),
      event(7, {
        toolCallId: "e",
        kind: "commandExecution",
        item: { tool: "bash", command: "pwd" },
      }),
    ]);
    expect(activitySummary(items, false).text).toBe(
      "调用了 1 次 Topolumia MCP、1 次 papers MCP、2 次 Bash 工具、1 次 终端工具",
    );
  });
  it("trusts explicit server metadata and does not infer an arbitrary MCP from underscore-separated names", () => {
    const items = [
      {
        ...tool("server", "mcp__alias__search"),
        events: [event(1, { server: "actual", kind: "mcpToolCall" })],
      },
      tool("native", "custom_analysis_tool"),
      {
        ...tool("unknown", "mcpToolCall"),
        events: [event(2, { kind: "mcpToolCall" })],
      },
    ];
    expect(activitySummary(items, false).text).toBe(
      "调用了 1 次 actual MCP、1 次 custom_analysis_tool、1 次 MCP",
    );
  });
});
