import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExperimentPlots } from "./ExperimentPlots";
import { niceTicks, runColor } from "./chartModel";
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

it("shows one chart per exact metric and toggles a run across all of them at once", () => {
  show();
  expect(screen.getAllByRole("figure")).toHaveLength(4);
  const loss = within(screen.getByRole("figure", { name: "train/loss" }));
  expect(loss.getByRole("img", { name: "train/loss · 3 runs" })).toBeVisible();
  expect(screen.getByRole("figure", { name: "train/loss" })).toHaveAttribute(
    "data-series-count",
    "3",
  );
  const legend = within(
    screen.getByRole("group", { name: "Runs shown in every chart" }),
  );
  expect(legend.getAllByRole("button")).toHaveLength(3);
  expect(legend.getByRole("button", { name: "Run 2" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(legend.getByRole("button", { name: "Run 2" }));
  expect(legend.getByRole("button", { name: "Run 2" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  for (const figure of screen.getAllByRole("figure"))
    expect(figure).toHaveAttribute("data-series-count", "2");
});

it("keeps colours bound to the run identity, not to its position", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const forward = Object.fromEntries(
    ids.map((id) => [id, runColor("experiment", id)]),
  );
  const reverse = Object.fromEntries(
    [...ids].reverse().map((id) => [id, runColor("experiment", id)]),
  );
  expect(reverse).toEqual(forward);
  expect(new Set(Object.values(forward)).size).toBeGreaterThan(1);
});

it("places ticks on 1/2/5 × 10ⁿ steps instead of raw min/max fractions", () => {
  expect(niceTicks(0, 1, 5)).toEqual(
    [0, 0.2, 0.4, 0.6000000000000001, 0.8, 1].map((value) =>
      Number(value.toPrecision(12)),
    ),
  );
  expect(niceTicks(-3, 7, 5)).toEqual([-2, 0, 2, 4, 6]);
});

it("keeps raw point controls off the chart page", () => {
  show();
  expect(screen.queryByText("Data points")).toBeNull();
  expect(screen.queryByText("数据点")).toBeNull();
});

it("keeps a run with one recorded observation readable without a canvas", () => {
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
  const loss = within(screen.getByRole("figure", { name: "loss" }));
  expect(
    loss.getByText("Open the Experiment data tab to inspect raw points."),
  ).toBeVisible();
});
