import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExperimentCompareDialog } from "./ExperimentCompareDialog";
import type { RecordPlot } from "./ExperimentPlots";

let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); });

it("loads a filtered metric beyond the initial 32 without losing the search field", async () => {
  const metricKeys = Array.from({ length: 33 }, (_, index) => "metric_" + (index + 1));
  const runs = ["a", "b"].map(nodeId => ({ nodeId, nodeName: "Experiment " + nodeId, runId: "run:" + nodeId, runLabel: "Run " + nodeId }));
  const plot = (keys: string[]): RecordPlot => ({ temporary: true, metricKeys, omittedMetricCount: metricKeys.length - keys.length, runs,
    series: keys.flatMap(key => runs.map(run => ({ ...run, blockId: "block:" + run.nodeId, key, xKey: "step", points: [{ x: 0, y: 7 }], pointCount: 1, sampled: false, sources: [] }))),
  });
  let release: ((response: Response) => void) | undefined;
  const fetch = vi.fn(async (url: string, options: RequestInit = {}) => {
    if (url.endsWith("/research-experiments")) return Response.json({ items: runs.map(run => ({ id: run.nodeId, name: run.nodeName, summary: "", runs: [{ id: run.runId, label: run.runLabel, blockId: "block:" + run.nodeId, status: "succeeded" }] })) });
    const input = JSON.parse(String(options.body));
    if (input.metricKeys) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json(plot(metricKeys.slice(0, 32)));
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><ExperimentCompareDialog nodeIds={["a", "b"]} en onClose={() => {}} /></QueryClientProvider>);
  await screen.findByRole("figure", { name: "metric_1" });
  const search = screen.getByRole("searchbox", { name: "Filter metrics" });
  fireEvent.change(search, { target: { value: "metric_33" } });
  await waitFor(() => expect(release).toBeTypeOf("function"));
  expect(screen.getByRole("searchbox", { name: "Filter metrics" })).toBe(search);
  const input = JSON.parse(String(fetch.mock.calls.filter(([url]) => url.endsWith("/plot")).at(-1)![1]?.body));
  expect(input).toEqual({ nodeIds: ["a", "b"], metricKeys: ["metric_33"] });
  await act(async () => release!(Response.json(plot(["metric_33"]))));
  expect(await screen.findByRole("figure", { name: "metric_33" })).toBeInTheDocument();
  expect(screen.queryByText("No metric matches this search.")).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: "" } });
  expect(await screen.findByRole("figure", { name: "metric_1" })).toBeInTheDocument();
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/plot"))).toHaveLength(2);
});
