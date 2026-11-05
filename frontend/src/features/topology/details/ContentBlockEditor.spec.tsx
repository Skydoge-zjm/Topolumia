import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContentBlockEditor } from "./ContentBlockEditor";
import type { ContentBlock } from "./ContentBlockRenderer";

afterEach(cleanup);
const source = { id: "source:paper", kind: "table", value: "Table 2", locator: { page: "6", table: "2" }, label: "Original source", delivery: "agentReported" };
const cases = [
  ["richText", { format: "plain", body: "Research text" }],
  ["metric", { items: [{ name: "FID", value: 5.2, condition: "Same compute", note: "Three seeds", sourceRefIds: [source.id] }] }],
  ["quote", { text: "Original quote", translation: "原文译文", note: "Interpretation", sourceRefIds: [source.id] }],
  ["image", { caption: "Original caption", alt: "Detailed image description", locator: "Figure 2" }],
  ["spreadsheet", { format: "xlsx", sheet: "Results", range: "B2:F9" }],
  ["table", { columns: [{ key: "model", label: "Model" }, { key: "score", label: "Score" }, { key: "valid", label: "Valid" }, { key: "missing", label: "Missing" }], rows: [{ model: "SR3", score: 5.2, valid: true, missing: null }], sourceFormat: "xlsx", sheetName: "Results", caption: "Comparison", totalRows: 1, truncated: false }],
  ["document", { format: "pdf", title: "Original paper" }],
  ["link", { url: "https://example.org", label: "Dashboard", kind: "wandb", note: "Original run" }],
  ["code", { code: "print(1)", language: "python", filename: "train.py" }],
  ["chart", { chartType: "line", dataBlockId: "block:data", config: { x: "step", y: "loss" } }],
  ["file", { label: "Checkpoint", note: "Seed 42" }],
  ["image", undefined],
  ["document", undefined],
  ["spreadsheet", undefined],
  ["table", undefined],
  ["file", undefined],
] as const;
function block(type: string, payload: unknown): ContentBlock {
  return { id: "block:fixture", title: "Original title", type, payload, revision: 3, order: 0, sourceRefs: [source], review: "confirmed", representations: [{ id: "representation:original", kind: "asset", assetId: "asset:original", role: "source", sourceRefIds: [source.id] }], primaryRepresentationId: "representation:original" };
}

it.each(cases)("renaming a %s block sends only the title patch", async (type, payload) => {
  const save = vi.fn(async () => {});
  render(<ContentBlockEditor en initial={block(type, payload)} onSave={save} onCancel={() => {}} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Block title" }), { target: { value: "Renamed" } });
  fireEvent.click(screen.getByRole("button", { name: "Save block" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ title: "Renamed" }));
});

it("editing a metric preserves its conditions, notes and source bindings", async () => {
  const save = vi.fn(async () => {}), payload = cases[1][1];
  render(<ContentBlockEditor en initial={block("metric", payload)} onSave={save} onCancel={() => {}} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Value" }), { target: { value: "6.1" } });
  fireEvent.click(screen.getByRole("button", { name: "Save block" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ payload: { items: [{ ...payload.items[0], value: 6.1 }] } }));
});

it("editing table cells keeps column identities, primitive types and scientific metadata", async () => {
  const save = vi.fn(async () => {}), payload = cases[5][1];
  render(<ContentBlockEditor en initial={block("table", payload)} onSave={save} onCancel={() => {}} />);
  const input = screen.getByRole("textbox", { name: /Paste a table/ });
  fireEvent.change(input, { target: { value: "Model\tScore\tValid\tMissing\nSR3 revised\t5.2\ttrue\t\n" } });
  expect((input as HTMLTextAreaElement).value).toMatch(/\n$/);
  fireEvent.click(screen.getByRole("button", { name: "Save block" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ payload: { ...payload, rows: [{ model: "SR3 revised", score: 5.2, valid: true, missing: null }], sourceFormat: "manual" } }));
});

it("editing a quotation or source keeps the existing translation and citation identity", async () => {
  const save = vi.fn(async () => {}), payload = cases[2][1];
  render(<ContentBlockEditor en initial={block("quote", payload)} onSave={save} onCancel={() => {}} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Quoted text" }), { target: { value: "Updated quote" } });
  fireEvent.change(screen.getByLabelText("Source 1"), { target: { value: "Table 3" } });
  fireEvent.click(screen.getByRole("button", { name: "Save block" }));
  const originalSource: Record<string, unknown> = { ...source };
  delete originalSource.delivery;
  await waitFor(() => expect(save).toHaveBeenCalledWith({ payload: { ...payload, text: "Updated quote" }, sourceRefs: [{ ...originalSource, value: "Table 3" }] }));
});
