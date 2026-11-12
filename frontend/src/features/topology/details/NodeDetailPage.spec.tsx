import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { NodeDetailPage } from "./NodeDetailPage";
import { useUiStore } from "@/shared/state/ui";

let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps unsaved note text when navigation is cancelled, and discards only after confirmation", async () => {
  localStorage.setItem("research-workbench-project", "audit");
  useUiStore.setState({ locale: "en" });
  const node = { id: "note:audit", kind: "note", label: "Audit note", summary: "", status: "active" };
  const block = { id: "block:body", title: "正文", type: "richText", role: "body", order: 0, revision: 1, payload: { format: "plain", body: "Original body" }, representations: [] };
  const detail = { node, core: { nodeName: "Audit note", tags: [] }, bodyBlockId: block.id, contentBlocks: [block], pendingCandidates: [], relations: [], nodeRevision: 1, coreRevision: 1, blockCollectionRevision: 1 };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/collaboration/context") return Response.json({ actor: { id: "auditor" }, permissions: ["*"] });
    if (url.startsWith("/api/research-nodes/")) return Response.json(detail);
    if (url.startsWith("/api/research-relations")) return Response.json({ data: { items: [] }, page: { total: 0, nextCursor: null } });
    return Response.json({ nodes: [node], groups: [], edges: [] });
  }));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/topology/nodes/note:audit"]}><Routes><Route path="/topology/nodes/:id" element={<NodeDetailPage />} /><Route path="/topology" element={<h1>Topology list</h1>} /></Routes></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Note body" }), { target: { value: "Unsaved conclusion" } });
  fireEvent.click(screen.getByRole("link", { name: "Research topology" }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Unsaved conclusion");
  fireEvent.click(screen.getByRole("button", { name: "Node name：Audit note" }));
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Unsaved conclusion");
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Node name" }), { key: "Escape" });
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("link", { name: "Research topology" }));
  await screen.findByRole("heading", { name: "Topology list" });
  expect(screen.queryByRole("textbox", { name: "Note body" })).not.toBeInTheDocument();
  expect(confirm).toHaveBeenCalledTimes(2);
});
