import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ObjectContentWorkspace } from "./ObjectContentWorkspace";
import type { ContentBlock } from "./ContentBlockRenderer";

const blocks: ContentBlock[] = Array.from({ length: 25 }, (_, index) => ({
  id: "block:" + index, title: "Material " + (index + 1), type: "richText", order: index, revision: 1,
  payload: { format: "plain", body: "Original text " + (index + 1) }, representations: [],
}));
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function show(paginated = false) {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { queueMicrotask(() => callback(performance.now())); return 0; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const request = new URL(url, "http://localhost"), path = decodeURIComponent(request.pathname);
    if (path.endsWith("/content-blocks")) {
      const offset = request.searchParams.has("cursor") ? 20 : 0;
      return Response.json({ data: { items: blocks.slice(offset, offset + 20) }, page: { total: 25, nextCursor: offset ? null : "second" } });
    }
    return Response.json(blocks.find(block => path.endsWith("/" + block.id)));
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><ObjectContentWorkspace
    owner={{ kind: paginated ? "group" : "node", id: "owner" }} initialBlocks={paginated ? undefined : blocks}
    collectionRevision={1} en canEdit onChanged={() => {}} rail={<span>Relations</span>}
  /></QueryClientProvider>);
}

it.each(["edit", "insert"])("keeps an unsaved %s draft when another page is selected in the outline", async mode => {
  show();
  const first = screen.getByRole("article", { name: "Material 1" });
  fireEvent.click(mode === "edit" ? within(first).getByRole("button", { name: "Edit content block" }) : screen.getByRole("button", { name: "Insert a block after Material 1" }));
  const draft = screen.getByRole("textbox", { name: "Text / Markdown" });
  fireEvent.change(draft, { target: { value: "Unfinished research conclusion" } });
  const outline = within(screen.getByRole("navigation", { name: "Material outline" }));
  expect(outline.getByRole("button", { name: "Material 21" })).toBeDisabled();
  fireEvent.click(outline.getByRole("button", { name: "Material 21" }));
  expect(draft).toHaveValue("Unfinished research conclusion");
  expect(screen.queryByRole("article", { name: "Material 21" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(outline.getByRole("button", { name: "Material 21" }));
  expect(await screen.findByRole("article", { name: "Material 21" })).toBeInTheDocument();
});

it("locates material on either loaded directory page of a group", async () => {
  show(true);
  await screen.findByText("Original text 1");
  fireEvent.click(screen.getByRole("button", { name: "Next material" }));
  await screen.findByText("Original text 21");
  const outline = within(screen.getByRole("navigation", { name: "Material outline" }));
  fireEvent.click(outline.getByRole("button", { name: "Material 1" }));
  await waitFor(() => expect(screen.getByRole("article", { name: "Material 1" })).toBeInTheDocument());
  expect(screen.queryByRole("article", { name: "Material 21" })).not.toBeInTheDocument();
  fireEvent.click(outline.getByRole("button", { name: "Material 25" }));
  expect(await screen.findByRole("article", { name: "Material 25" })).toBeInTheDocument();
});
