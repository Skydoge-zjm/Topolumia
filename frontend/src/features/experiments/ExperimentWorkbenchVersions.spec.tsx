import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExperimentWorkbench } from "./ExperimentWorkbench";
import type { RecordPlot } from "./ExperimentPlots";
import type { ContentBlock } from "@/features/topology/details/ContentBlockRenderer";

const nodeId = "experiment:versions", blockId = "block:versions", runId = "run:one";
const block: ContentBlock = { id: blockId, type: "experimentRecord", title: "Training", order: 0, revision: 1, payload: { provider: "wandb", runs: [] } };
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function result(value: number): RecordPlot {
  const run = { nodeId, nodeName: "Experiment", runId, runLabel: "Run" };
  return { temporary: true, metricKeys: ["loss"], omittedMetricCount: 0, runs: [run], series: [{ ...run, blockId, key: "loss", xKey: "step", points: [{ x: 0, y: value }], pointCount: 1, sampled: false, sources: [] }] };
}

function show(read: (body: { selections?: { snapshotId: string }[] }) => Promise<RecordPlot>) {
  localStorage.setItem("research-workbench-project", "version-test");
  const fetch = vi.fn(async (url: string, options: RequestInit = {}) => {
    if (url.endsWith("/plot")) return Response.json(await read(JSON.parse(String(options.body))));
    if (url.endsWith("/version")) return Response.json({ durableWatermark: 0, updatedAt: null });
    if (url.endsWith("/status")) return Response.json({ snapshots: [{ id: "old", createdAt: "2026-11-01T00:00:00Z" }, { id: "new", createdAt: "2026-11-02T00:00:00Z" }] });
    if (url.includes("/experiment?")) return Response.json({ revision: 1, runs: [{ id: runId, label: "Live run", status: "running", note: "", sources: [], records: [] }], materialLinks: [] });
    if (url.endsWith("/read")) return Response.json({ data: { items: [{ id: runId, label: "Frozen run", status: "succeeded" }] }, page: { nextCursor: null } });
    if (url.includes("/events?")) return Response.json({ items: [], nextAfter: null });
    if (url.includes("collaboration/context")) return Response.json({ actor: { id: "tester" }, permissions: ["*"] });
    throw new Error("Unexpected request: " + url);
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><ExperimentWorkbench nodeId={nodeId} block={block} en /></QueryClientProvider>);
  return fetch;
}

function ledger() { return within(document.querySelector(".run-ledger")! as HTMLElement); }
function selectVersion(index: number) {
  fireEvent.click(screen.getByRole("button", { name: "Record version" }));
  fireEvent.click(screen.getAllByRole("option").filter(option => option.textContent?.startsWith("Version of"))[index]);
}

it("waits for each selected version instead of placing previous values under its label", async () => {
  const pending = new Map<string, (plot: RecordPlot) => void>();
  let holdLatest = false;
  const fetch = show(async body => {
    const version = body.selections?.[0]?.snapshotId ?? "latest";
    if (version === "latest" && !holdLatest) return result(11);
    return new Promise(resolve => pending.set(version, resolve));
  });
  await screen.findByRole("button", { name: "Live run" });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(ledger().getByText("11", { exact: true })).toBeInTheDocument();
  selectVersion(0);
  await waitFor(() => expect(pending.has("old")).toBe(true));
  expect(ledger().queryByText("11", { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole("figure", { name: "loss" })).not.toBeInTheDocument();
  await act(async () => pending.get("old")!(result(33)));
  await waitFor(() => expect(ledger().getByText("33", { exact: true })).toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: "Events & files" }));
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes("/events?") && new URL(url, "http://localhost").searchParams.get("snapshotId") === "old")).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Curves" }));
  selectVersion(1);
  await waitFor(() => expect(pending.has("new")).toBe(true));
  expect(ledger().queryByText("33", { exact: true })).not.toBeInTheDocument();
  await act(async () => pending.get("new")!(result(66)));
  await waitFor(() => expect(ledger().getByText("66", { exact: true })).toBeInTheDocument());

  holdLatest = true;
  fireEvent.click(screen.getByRole("button", { name: "Read latest data" }));
  await waitFor(() => expect(pending.has("latest")).toBe(true));
  expect(ledger().queryByText("66", { exact: true })).not.toBeInTheDocument();
  await act(async () => pending.get("latest")!(result(22)));
  await waitFor(() => expect(ledger().getByText("22", { exact: true })).toBeInTheDocument());
});

it("keeps the current live reading visible while a new watermark is being read", async () => {
  let release: ((plot: RecordPlot) => void) | undefined;
  let hold = false;
  show(async () => hold ? new Promise(resolve => { release = resolve; }) : result(11));
  await screen.findByRole("button", { name: "Live run" });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  fireEvent.click(screen.getByRole("button", { name: "Pause updates" }));
  hold = true;
  act(() => { client.setQueryData(["record-watermark", "version-test", blockId], { durableWatermark: 1, updatedAt: null }); });
  await waitFor(() => expect(release).toBeTypeOf("function"));
  expect(ledger().getByText("11", { exact: true })).toBeInTheDocument();
  await act(async () => release!(result(22)));
  await waitFor(() => expect(ledger().getByText("22", { exact: true })).toBeInTheDocument());
});
