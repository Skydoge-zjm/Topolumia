import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ObjectContentWorkspace } from "@/features/topology/details/ObjectContentWorkspace";
import type { ContentBlock } from "@/features/topology/details/ContentBlockRenderer";

const owner = { kind: "node" as const, id: "node:experiment" };
const record: ContentBlock = { id: "block:record", title: "Record", type: "experimentRecord", review: "unreviewed", revision: 3, order: 0, payload: { provider: "wandb", runs: [{ sourceId: "source-a", runId: "run:one", label: "Run", status: "succeeded", assetIds: ["asset:source-a"] }, { sourceId: "source-b", runId: "run:one", label: "Run", status: "succeeded", assetIds: ["asset:source-b"] }] }, representations: [{kind:"asset",assetId:"asset:source-a",role:"source"},{kind:"asset",assetId:"asset:source-b",role:"source"}], sourceRefs: [] };
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function show(canEdit = true) {
  const fetch = vi.fn(async (url: string, options: RequestInit = {}) => {
    if (options.method === "PATCH" || options.method === "DELETE") return Response.json({ ...record, title: "Renamed" });
    if (url.includes("/experiment?")) return Response.json({ revision: 1, runs: [{ id: "run:one" }], materialLinks: [] });
    if (url.endsWith("/status")) return Response.json({ snapshots: [] });
    if (url.endsWith("/version")) return Response.json({ durableWatermark: 0, updatedAt: null });
    if (url.includes("collaboration/context")) return Response.json({ permissions: canEdit ? ["*"] : [] });
    return Response.json({ temporary: true, runs: [], series: [], metricKeys: [], omittedMetricCount: 0 });
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const changed = vi.fn();
  render(<QueryClientProvider client={client}><ObjectContentWorkspace nodeKind="experiment" owner={owner} initialBlocks={[record]} collectionRevision={5} en canEdit={canEdit} onChanged={changed} /></QueryClientProvider>);
  return { fetch, changed };
}

it("plots one run once when multiple sources share its identity", async () => {
  const { fetch } = show();
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith("/plot"))).toBe(true));
  const input = JSON.parse(String(fetch.mock.calls.find(([url]) => url.endsWith("/plot"))![1]?.body));
  expect(input.nodeId).toBe(owner.id);
  expect(input.blockId).toBe(record.id);
  expect(input.selections).toBeUndefined();
  expect(input.blockRevision).toBe(3);
});

it("edits and deletes an experiment record through the shared versioned block actions", async () => {
  const { fetch, changed } = show();
  fireEvent.click(screen.getByRole("button", { name: "Edit content block" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Block title" }), { target: { value: "Renamed" } });
  fireEvent.click(screen.getByRole("button", { name: "Save block" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  const update = fetch.mock.calls.find(([, options]) => options?.method === "PATCH")!;
  expect(JSON.parse(String(update[1]?.body))).toEqual({ patch: { title: "Renamed" }, expectedRevision: 3 });
  fireEvent.click(screen.getByRole("button", { name: "Delete content block" }));
  const confirmation = await screen.findByRole("dialog", { name: "Delete block: Record" });
  expect(changed).toHaveBeenCalledTimes(1);
  fireEvent.click(within(confirmation).getByRole("button", { name: "Delete block" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
  const deletion = fetch.mock.calls.find(([, options]) => options?.method === "DELETE")!;
  expect(JSON.parse(String(deletion[1]?.body))).toEqual({ expectedRevision: 3 });
});

it("keeps record actions unavailable to readers", async () => {
  show(false);
  const card = screen.getByRole("heading", { name: "Record" }).closest("article")!;
  expect(within(card).queryByRole("button", { name: "Edit content block" })).toBeNull();
  expect(within(card).queryByRole("button", { name: "Delete content block" })).toBeNull();
});
