import { expect, it } from "vitest";
import { topolumiaOperation, topolumiaToolLabel } from "./agentTool";
import type { AgentEvent } from "@/shared/types/api";

const event = (
  payload: Record<string, unknown>,
  type = "tool.started",
): AgentEvent => ({
  id: "e",
  cursor: 1,
  sessionId: "s",
  turnId: "t",
  type,
  payload,
  occurredAt: "",
});
it("identifies Topolumia across native providers and uses bilingual action labels", () => {
  const sources = [
    {
      events: [
        event({
          item: {
            server: "topolumia",
            tool: "search",
            arguments: { target: "nodes" },
          },
        }),
      ],
    },
    {
      title: "mcp__topolumia__search",
      events: [
        event({
          title: "mcp__topolumia__search",
          rawInput: { target: "nodes" },
        }),
      ],
    },
    {
      events: [
        event({
          item: { tool: "topolumia_search", arguments: { target: "nodes" } },
        }),
      ],
    },
  ];
  for (const source of sources) {
    expect(topolumiaOperation(source)).toBe("search");
    expect(topolumiaToolLabel(source, false, "running")).toBe("搜索节点中");
    expect(topolumiaToolLabel(source, true, "running")).toBe("Searching nodes");
    expect(topolumiaToolLabel(source, false, "completed")).toBe("搜索节点");
  }
});
it("leaves external servers and bare tools unchanged even when their names resemble Topolumia", () => {
  for (const source of [
    { title: "search" },
    { title: "mcp__papers__search" },
    { title: "topolumia_like_search" },
    { title: "mcp__topolumia__search", events: [event({ server: "papers" })] },
  ]) {
    expect(topolumiaToolLabel(source, false)).toBeUndefined();
  }
  expect(
    topolumiaToolLabel({ title: "mcp__topolumia_other__search" }, false),
  ).toBeUndefined();
});
it("labels every registered operation and avoids an inaccurate target for mixed grouped searches", () => {
  for (const tool of [
    "get_environment",
    "get_context",
    "search",
    "read_nodes",
    "neighbors",
    "read_source",
    "read_candidates",
    "create_candidate",
    "edit_candidate",
  ]) {
    const label = topolumiaToolLabel(
      { title: `mcp__topolumia__${tool}` },
      false,
      "running",
    );
    expect(label).toBeTruthy();
    expect(label).not.toContain("mcp__");
    expect(label?.endsWith("中")).toBe(true);
  }
  const grouped = {
    title: "mcp__topolumia__search",
    events: [
      event({ toolCallId: "a", rawInput: { target: "nodes" } }),
      event({ toolCallId: "b", rawInput: { target: "sources" } }),
    ],
  };
  expect(topolumiaToolLabel(grouped, false, "completed")).toBe("搜索科研信息");
});
