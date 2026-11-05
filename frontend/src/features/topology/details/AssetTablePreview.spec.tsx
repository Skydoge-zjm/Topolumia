import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AssetTablePreview } from "./AssetTablePreview";
import userEvent from "@testing-library/user-event";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("renders imported spreadsheet preview and offers original plus XLSX and TeX exports", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    asset: { originalName: "sr3-table2.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    preview: { schemaVersion: "research-table-preview.v1", columns: [{ key: "c1", label: "Model" }, { key: "c2", label: "FID" }], rows: [{ c1: "SR3", c2: 5.2 }], sourceFormat: "xlsx", sheetName: "Table 2", truncated: false, totalRows: 1 },
    error: null,
  }))));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><AssetTablePreview owner={{kind:"node",id:"paper:sr3"}} assetId="asset:table2" blockId="block:table2" blockRevision={1} en={false} /></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(screen.getByText("sr3-table2.xlsx")).toBeInTheDocument());
  expect(screen.getByText("SR3")).toBeInTheDocument();
  expect(screen.getByText("5.2")).toBeInTheDocument();
});

it("shows only one TeX representation and supports switching with mouse and keyboard", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    asset: { originalName: "results.tex", mediaType: "application/x-tex", compiled: { state: "ready", pdf: "preview.pdf", image: "preview.png" } },
    preview: { columns: [{ key: "c1", label: "Method" }, { key: "c2", label: "FID" }], rows: [{ c1: "SR3", c2: 5.2 }], sourceFormat: "tex", truncated: false, totalRows: 1 },
    error: null,
  }))));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AssetTablePreview owner={{kind:"node",id:"paper:sr3"}} assetId="asset:tex" blockId="block:tex" blockRevision={1} en={false} /></QueryClientProvider>);
  await screen.findByRole("img", { name: "TeX 编译表格预览" });
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "渲染预览" })).toHaveAttribute("aria-selected", "true");
  await user.click(screen.getByRole("tab", { name: "表格数据" }));
  expect(screen.getByRole("table")).toBeVisible();
  expect(screen.queryByRole("img", { name: "TeX 编译表格预览" })).not.toBeInTheDocument();
  await user.keyboard("{ArrowLeft}");
  await waitFor(() => expect(screen.getByRole("tab", { name: "渲染预览" })).toHaveAttribute("aria-selected", "true"));
  expect(screen.getByRole("img", { name: "TeX 编译表格预览" })).toBeVisible();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "XLSX" })).toBeInTheDocument();
});
