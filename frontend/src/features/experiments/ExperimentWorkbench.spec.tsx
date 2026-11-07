import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExperimentWorkbench } from "./ExperimentWorkbench";
import type { ContentBlock } from "@/features/topology/details/ContentBlockRenderer";

const owner = { kind: "node" as const, id: "node:experiment" };
const record: ContentBlock = { id: "block:record", title: "Record", type: "experimentRecord", review: "unreviewed", revision: 3, order: 0, payload: { provider: "wandb", runs: [{ sourceId: "source-a", runId: "run:one", label: "Run", status: "succeeded", assetIds: [], ref: "wandb:run:source-a" }, { sourceId: "source-b", runId: "run:one", label: "Run", status: "succeeded", assetIds: [], ref: "wandb:run:source-b" }] }, representations: [], sourceRefs: [] };
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function show(canEdit = true) {
  const fetch = vi.fn(async (url: string, options: RequestInit = {}) => {
    if (options.method === "PATCH" || options.method === "DELETE") return Response.json({ ...record, title: "Renamed" });
    if (url.endsWith("/experiment")) return Response.json({ revision: 1, runs: [], materialLinks: [] });
    return Response.json({ temporary: true, runs: [], series: [], metricKeys: [], omittedMetricCount: 0 });
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const changed = vi.fn();
  render(<QueryClientProvider client={client}><ExperimentWorkbench nodeId={owner.id} owner={owner} blocks={[record]} collectionRevision={5} en canEdit={canEdit} onChanged={changed} /></QueryClientProvider>);
  return { fetch, changed };
}

it("plots one run once when multiple sources share its identity", async () => {
  const { fetch } = show();
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith("/plot"))).toBe(true));
  const input = JSON.parse(String(fetch.mock.calls.find(([url]) => url.endsWith("/plot"))![1]?.body));
  expect(input.selections).toEqual([{ nodeId: owner.id, runId: "run:one" }]);
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
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Delete content block" }));
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
