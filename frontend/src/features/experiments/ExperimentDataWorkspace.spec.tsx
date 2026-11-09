import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExperimentDataWorkspace } from "./ExperimentDataWorkspace";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const keys = ["train/loss", "train/accuracy", "eval/psnr", "eval/ssim"];
const runs = [
  { id: "run:one", label: "Run 1", status: "succeeded" },
  { id: "run:failed", label: "Run 2", status: "failed" },
];
const precise = 0.123456789012345;

it("selects and reads identical metric names independently by their axes", async () => {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.startsWith("/api/research-nodes/")) return Response.json({ runs: [runs[0]] });
    const input = JSON.parse(String(options?.body));
    if (input.mode === "metrics") return Response.json({ data: { items: ["step", "epoch"].map(xKey => ({ key: "loss", xKey, pointCount: 1, readHint: { expectedContentVersion: "v1" } })) } });
    return Response.json({ columns: input.metrics.map((metric: { key: string; xKey: string }) => ({ metric: metric.key, xKey: metric.xKey, pointCount: 1, points: [{ x: 0, y: metric.xKey === "step" ? 0.2 : 0.7 }], nextOffset: null })) });
  });
  vi.stubGlobal("fetch", fetch);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}><ExperimentDataWorkspace nodeId="experiment" en /></QueryClientProvider>);
  await screen.findByRole("columnheader", { name: "loss · step" });
  expect(screen.getByRole("columnheader", { name: "loss · epoch" })).toBeVisible();
  const request = fetch.mock.calls.find(([url]) => url.endsWith("/table"))!;
  expect(JSON.parse(String(request[1]?.body)).metrics).toEqual([{ key: "loss", xKey: "step", expectedContentVersion: "v1" }, { key: "loss", xKey: "epoch", expectedContentVersion: "v1" }]);
  fireEvent.click(screen.getByRole("button", { name: "loss · step" }));
  await waitFor(() => expect(screen.queryByRole("columnheader", { name: "loss · step" })).toBeNull());
  expect(await screen.findByRole("cell", { name: "0.7" })).toBeVisible();
});

function show({ sparse = false } = {}) {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.startsWith("/api/research-nodes/")) return Response.json({ runs });
    const input = JSON.parse(String(options?.body));
    if (input.mode === "metrics") {
      if (input.runId === "run:failed")
        return Response.json({ data: { items: [] } });
      const page = input.cursor ? keys.slice(2) : keys.slice(0, 2);
      return Response.json({
        data: {
          items: page.map((key) => ({
            key,
            xKey: "step",
            pointCount: sparse ? 3 : 201,
            readHint: { expectedContentVersion: "v1" },
          })),
        },
        page: { nextCursor: input.cursor ? null : "second" },
      });
    }
    return Response.json({
      columns: input.metrics.map(({ key: metric }: { key: string }) => {
        const points = sparse
          ? metric === "train/loss"
            ? [
                { x: 0, y: precise },
                { x: 0, y: 0.987654321098765 },
                { x: 2, y: 0.5 },
              ]
            : metric === "train/accuracy"
              ? [
                  { x: 0, y: 0.9 },
                  { x: 1, y: 0.8 },
                  { x: 2, y: 0.7 },
                ]
              : [
                  { x: 0, y: 20 },
                  { x: 2, y: 23 },
                ]
          : Array.from(
              { length: Math.min(100, 201 - input.pointOffset) },
              (_, index) => ({
                x: input.pointOffset + index,
                y:
                  input.pointOffset + index === 0
                    ? precise
                    : input.pointOffset + index + keys.indexOf(metric) / 10,
              }),
            );
        return {
          metric,
          xKey: "step",
          points,
          pointCount: sparse ? 3 : 201,
          offset: input.pointOffset,
          nextOffset:
            sparse || input.pointOffset + 100 >= 201
              ? null
              : input.pointOffset + 100,
        };
      }),
    });
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      <ExperimentDataWorkspace nodeId="experiment" en />
    </QueryClientProvider>,
  );
  return fetch;
}

it("shows all metric columns and preserves exact values, sparse points and repeated steps", async () => {
  show({ sparse: true });
  const table = await screen.findByRole("table");
  expect(within(table).getAllByRole("columnheader")).toHaveLength(5);
  expect(within(table).getAllByRole("row")).toHaveLength(5);
  expect(
    within(table).getByRole("cell", { name: String(precise) }),
  ).toBeVisible();
  expect(
    within(table).getByRole("cell", { name: "0.987654321098765" }),
  ).toBeVisible();
  expect(
    within(table).getAllByRole("cell", { name: "—" }).length,
  ).toBeGreaterThan(0);
  expect(screen.queryByRole("heading", { name: "Experiment data" })).toBeNull();
});

it("can hide metric columns without moving other values under the wrong heading", async () => {
  show({ sparse: true });
  await screen.findByRole("columnheader", { name: "eval/ssim" });
  fireEvent.click(screen.getByRole("button", { name: "train/loss" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("columnheader", { name: "train/loss" }),
    ).toBeNull(),
  );
  await screen.findByRole("columnheader", { name: "train/accuracy" });
  const firstRow = screen.getAllByRole("row")[1];
  expect(
    within(firstRow)
      .getAllByRole("cell")
      .map((cell) => cell.textContent),
  ).toEqual(["0", "0.9", "20", "20"]);
});

it("paginates exact points and handles a failed run without metrics", async () => {
  const fetch = show();
  await screen.findByRole("columnheader", { name: "eval/ssim" });
  expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "101");
  expect(screen.getAllByRole("row").length).toBeLessThan(45);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("cell", { name: "100.1" });
  const requests = fetch.mock.calls
    .filter((call) => call[1]?.body)
    .map((call) => JSON.parse(String(call[1]?.body)));
  expect(
    requests.filter(
      (request) =>
        request.metrics?.length === 4 && request.pointOffset === 100,
    ),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Data run" }));
  fireEvent.click(screen.getByRole("option", { name: "Run 2" }));
  await screen.findByText("No scalar metrics for this run.");
  expect(screen.queryByRole("table")).toBeNull();
});

it("switches from pinned to live query parameters without reusing the snapshot cache", async () => {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.startsWith("/api/research-nodes/"))
      return Response.json({ runs: [{ id: "run:live", label: "Live run", status: "running" }] });
    const input = JSON.parse(String(options?.body));
    const snapshot = input.snapshotId === "snapshot:old";
    if (input.snapshotId !== undefined && !snapshot)
      throw new Error(`Unexpected snapshot ${input.snapshotId}`);
    if (input.mode === "runs")
      return Response.json({ data: { items: [{ id: snapshot ? "run:snapshot" : "run:live", label: snapshot ? "Snapshot run" : "Live run", status: "running" }] }, page: { nextCursor: null } });
    if (input.mode === "metrics")
      return Response.json({ data: { items: [{ key: "loss", xKey: "step", pointCount: 1, readHint: { expectedContentVersion: snapshot ? "snapshot-v1" : "live-v2" } }] }, page: { nextCursor: null } });
    return Response.json({ columns: [{ metric: "loss", xKey: "step", pointCount: 1, points: [{ x: 0, y: snapshot ? 1 : 2 }], nextOffset: null }] });
  });
  vi.stubGlobal("fetch", fetch);
  function Harness() {
    const [snapshotId, setSnapshotId] = useState<string | undefined>("snapshot:old");
    return <ExperimentDataWorkspace nodeId="experiment" blockId="block" snapshotId={snapshotId} onLatest={() => setSnapshotId(undefined)} en />;
  }
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}><Harness /></QueryClientProvider>);

  expect(await screen.findByRole("cell", { name: "1" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Read latest data" }));
  expect(await screen.findByRole("cell", { name: "2" })).toBeVisible();
  expect(fetch.mock.calls.some(([url]) => url.includes("/record-blocks/") && url.endsWith("/snapshots"))).toBe(false);
  const tableRequests = fetch.mock.calls.filter(([url, options]) => url.endsWith("/table") && options?.body).map(([, options]) => JSON.parse(String(options?.body)));
  expect(tableRequests.some(request => request.snapshotId === "snapshot:old")).toBe(true);
  expect(tableRequests.at(-1)?.snapshotId).toBeUndefined();
});

it("keeps two live record blocks isolated in the latest data view", async () => {
  const blockRuns = {
    "block:a": [{ id: "run:a", label: "Block A run", status: "running" }],
    "block:b": [{ id: "run:b", label: "Block B run", status: "running" }],
  };
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.startsWith("/api/research-nodes/")) {
      const blockId = new URL("http://test.local" + url).searchParams.get("blockId")!;
      return Response.json({ runs: blockRuns[blockId as keyof typeof blockRuns] });
    }
    const input = JSON.parse(String(options?.body));
    if (input.mode === "metrics") return Response.json({ data: { items: [{ key: "loss", xKey: "step", pointCount: 1 }] }, page: { nextCursor: null } });
    return Response.json({ columns: [{ metric: "loss", xKey: "step", pointCount: 1, points: [{ x: 0, y: input.runId === "run:a" ? 1 : 2 }], nextOffset: null }] });
  });
  vi.stubGlobal("fetch", fetch);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
    <ExperimentDataWorkspace nodeId="experiment" blockId="block:a" en />
    <ExperimentDataWorkspace nodeId="experiment" blockId="block:b" en />
  </QueryClientProvider>);

  await waitFor(() => expect(screen.getAllByRole("region", { name: "Experiment data" })).toHaveLength(2));
  const regions = screen.getAllByRole("region", { name: "Experiment data" });
  await within(regions[0]).findByRole("button", { name: "Data run" });
  await within(regions[1]).findByRole("button", { name: "Data run" });
  expect(within(regions[0]).getByRole("button", { name: "Data run" })).toHaveTextContent("Block A run");
  expect(within(regions[1]).getByRole("button", { name: "Data run" })).toHaveTextContent("Block B run");
  const overviewUrls = fetch.mock.calls.map(([url]) => url).filter((url) => url.includes("/experiment?blockId="));
  expect(overviewUrls).toEqual(expect.arrayContaining([
    "/api/research-nodes/experiment/experiment?blockId=block%3Aa",
    "/api/research-nodes/experiment/experiment?blockId=block%3Ab",
  ]));
});
