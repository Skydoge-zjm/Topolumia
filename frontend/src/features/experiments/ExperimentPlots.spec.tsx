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
import { ExperimentPlots } from "./ExperimentPlots";
import type { RecordPlot } from "./ExperimentPlots";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const runs = [1, 2, 3].map((value) => ({
  nodeId: "experiment",
  nodeName: "Rank 4",
  runId: "run:" + value,
  runLabel: "Run " + value,
}));
const metrics = ["train/loss", "train/accuracy", "eval/psnr", "eval/ssim"];
const plot: RecordPlot = {
  temporary: true,
  metricKeys: metrics,
  omittedMetricCount: 0,
  runs,
  series: metrics.flatMap((key) =>
    runs.map((run, index) => ({
      ...run,
      key,
      xKey: "step",
      points: Array.from({ length: 8 }, (_, x) => ({ x, y: x + index })),
      pointCount: 260,
      sampled: true,
      sources: [{ assetId: "source:" + index }],
    })),
  ),
};
const show = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ExperimentPlots plot={plot} en />
    </QueryClientProvider>,
  );

it("shows one interactive chart per exact metric with all three runs and independent legends", () => {
  show();
  expect(screen.getAllByRole("figure")).toHaveLength(4);
  const loss = within(screen.getByRole("figure", { name: "train/loss" }));
  expect(loss.getByRole("img", { name: "train/loss · 3 runs" })).toBeVisible();
  expect(loss.getByRole("button", { name: "Run 2" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(loss.getByRole("button", { name: "Run 2" }));
  expect(loss.getByRole("button", { name: "Run 2" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(
    within(screen.getByRole("figure", { name: "eval/psnr" })).getByRole(
      "button",
      { name: "Run 2" },
    ),
  ).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(loss.getByRole("button", { name: "Zoom in" }));
  expect(loss.queryByText("7")).toBeNull();
  fireEvent.click(loss.getByRole("button", { name: "Reset zoom" }));
  expect(loss.getByText("7")).toBeVisible();
});

it("reads exact source points separately from the sampled chart and pages without rounding values", async () => {
  const fetch = vi.fn(async (_url: string, options: { body: string }) => {
    const request = JSON.parse(options.body);
    return new Response(
      JSON.stringify({
        data: {
          metric: request.metric,
          xKey: "step",
          points: [{ x: request.pointOffset, y: 0.123456789012345 }],
          offset: request.pointOffset,
          pointCount: 260,
          nextOffset: request.pointOffset + 40,
          sampled: false,
        },
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetch);
  show();
  const loss = within(screen.getByRole("figure", { name: "train/loss" }));
  fireEvent.click(loss.getByText("Data points"));
  await waitFor(() =>
    expect(loss.getByText("0.123456789012345")).toBeVisible(),
  );
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
    mode: "series",
    nodeId: "experiment",
    runId: "run:1",
    metric: "train/loss",
    pointOffset: 0,
  });
  fireEvent.click(loss.getByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body).pointOffset).toBe(40),
  );
});

it("keeps a run with one recorded observation visible as a data point", () => {
  const single: RecordPlot = {
    ...plot,
    runs: [runs[0]],
    metricKeys: ["loss"],
    series: [
      {
        ...plot.series[0],
        key: "loss",
        points: [{ x: 0, y: 0.5 }],
        pointCount: 1,
        sampled: false,
      },
    ],
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ExperimentPlots plot={single} en />
    </QueryClientProvider>,
  );
  expect(screen.getByLabelText("Run 1: 0.5")).toBeVisible();
});
