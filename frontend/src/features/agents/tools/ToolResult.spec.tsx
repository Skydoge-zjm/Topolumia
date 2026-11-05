import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/shared/types/api";
import { ToolResult } from "./ToolResult";
import { StructuredValue } from "./StructuredToolOutput";

const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});
const event = (
  output: unknown,
  extra: Record<string, unknown> = {},
): AgentEvent => ({
  id: "e",
  cursor: 1,
  sessionId: "s",
  type: "tool.completed",
  occurredAt: "",
  payload: {
    title: "mcp__topolumia__read_source",
    rawOutput: output,
    ...extra,
  },
});
const source = {
  schemaVersion: "research-source.v2",
  projectId: "project",
  stateVersion: "research-version",
  source: {
    ref: "file:protocol.md",
    label: "实验协议",
    version: "source-version",
  },
  text: "# 实验安排\n\n需要三个随机种子。\n\n| 组别 | 种子 |\n| --- | --- |\n| G1 | 42 |",
  range: { start: 0, end: 70, totalChars: 140, nextOffset: 70 },
};

it("renders native JSON text envelopes as readable source content, with exact raw copying", async () => {
  const raw = JSON.stringify([{ type: "text", text: JSON.stringify(source) }]);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const onSource = vi.fn(),
    { container } = render(
      <ToolResult event={event(raw)} en={false} onSource={onSource} />,
    );
  expect(screen.getByRole("heading", { name: "实验安排" })).toBeVisible();
  expect(screen.getByText("需要三个随机种子。")).toBeVisible();
  expect(screen.getByRole("columnheader", { name: "组别" })).toBeVisible();
  expect(screen.getByText("字符范围 0–70 / 140")).toBeVisible();
  expect(container.querySelector(".tool-output")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看来源" }));
  expect(onSource).toHaveBeenCalledWith("file:protocol.md", "source-version");
  fireEvent.click(screen.getByRole("button", { name: "复制输出" }));
  expect(writeText).toHaveBeenCalledWith(raw);
  await screen.findByRole("button", { name: "已复制" });
});
it("supports direct structured MCP content and a singleton array without displaying protocol wrappers", () => {
  const { rerender } = render(
    <ToolResult
      event={event({
        structuredContent: source,
        content: [{ type: "text", text: "duplicate" }],
      })}
      en
    />,
  );
  expect(screen.getByRole("heading", { name: "实验安排" })).toBeVisible();
  expect(screen.queryByText("duplicate")).toBeNull();
  rerender(<ToolResult event={event(JSON.stringify([source]))} en />);
  expect(screen.getByText("Characters 0–70 / 140")).toBeVisible();
});
it("renders search results as cards with explicit page coverage", () => {
  const data = {
    schemaVersion: "research-search.v2",
    query: "conditioning",
    total: 20,
    nextCursor: "continuation",
    items: [
      {
        id: "node:g1",
        label: "条件化实验",
        kind: "experiment",
        summary: "三个种子对照",
        score: 0.00000001,
      },
    ],
  };
  render(
    <ToolResult
      event={event(JSON.stringify(data), { title: "mcp__topolumia__search" })}
      en={false}
    />,
  );
  expect(screen.getByText("返回 1 项 · 共 20 项")).toBeVisible();
  expect(screen.getByText("条件化实验")).toBeVisible();
  expect(screen.getByText("三个种子对照")).toBeVisible();
  expect(screen.getByText("后续页面还有结果。")).toBeVisible();
});
it("renders generic structured tables and retains exact numeric, boolean and null values", () => {
  render(
    <ToolResult
      event={event(
        '[{"metric":"loss","value":0.000000001,"valid":false,"missing":null}]',
        { title: "mcp__other__metrics" },
      )}
      en
    />,
  );
  expect(screen.getByRole("columnheader", { name: "metric" })).toBeVisible();
  expect(screen.getByRole("cell", { name: "1e-9" })).toBeVisible();
  expect(screen.getByRole("cell", { name: "No" })).toBeVisible();
  expect(screen.getByRole("cell", { name: "None" })).toBeVisible();
});
it("preserves malformed/plain output and escapes source HTML instead of running it", () => {
  const { container, rerender } = render(
    <ToolResult event={event("{incomplete JSON")} en />,
  );
  expect(container.querySelector(".tool-output")).toHaveTextContent(
    "{incomplete JSON",
  );
  rerender(
    <ToolResult
      event={event({
        ...source,
        text: "<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))",
      })}
      en
    />,
  );
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
});
it("pages large arrays locally while keeping access to later entries", () => {
  render(
    <StructuredValue
      value={Array.from({ length: 25 }, (_, i) => ({
        id: `row-${i}`,
        value: i,
      }))}
      en
    />,
  );
  expect(screen.queryByRole("cell", { name: "row-24" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show more (20/25)" }));
  expect(screen.getByRole("cell", { name: "row-24" })).toBeVisible();
});
