import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
      columns: input.metricKeys.map((metric: string) => {
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
        request.metricKeys?.length === 4 && request.pointOffset === 100,
    ),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Data run" }));
  fireEvent.click(screen.getByRole("option", { name: "Run 2" }));
  await screen.findByText("No scalar metrics for this run.");
  expect(screen.queryByRole("table")).toBeNull();
});
