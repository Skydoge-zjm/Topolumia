import test from "node:test";
import assert from "node:assert/strict";
import {
  downsamplePoints,
  normalizeSeries,
  normalizeMetricHistory,
} from "../../src/domain/experiments/experiment-domain.js";
import { MetricIngestionStore } from "../../src/services/experiments/metric-ingestion-store.js";
import { ExperimentTrackingGateway } from "../../src/services/experiments/experiment-tracking-gateway.js";
import { TrainingSimulationService, createTrainingSimulation } from "../../src/services/experiments/training-simulator.js";

test("provider history preserves W&B steps and never invents zero values for missing metrics", () => {
  const history = normalizeMetricHistory([{ _step: 10, loss: null }, { _step: 20, loss: 0 }, { _step: 30, loss: "" }, { _step: 40, loss: false }, { _step: 50, loss: "0.5" }]);
  assert.deepEqual(history.loss.map(point => [point.x, point.y]), [[20, 0], [50, .5]]);
});

test("extrema-aware reduction keeps a bounded curve and visible spikes", () => {
  const points = Array.from({ length: 50_000 }, (_, step) => ({ x: step, y: Math.sin(step / 80) }));
  points[12_345].y = 100;
  points[37_654].y = -100;
  const started = performance.now();
  const sampled = downsamplePoints(points, 240);
  const elapsed = performance.now() - started;
  assert.equal(sampled.length, 240);
  assert.deepEqual(sampled[0], points[0]);
  assert.deepEqual(sampled.at(-1), points.at(-1));
  assert.ok(sampled.some((point) => point.x === 12_345));
  assert.ok(sampled.some((point) => point.x === 37_654));
  assert.ok(elapsed < 1_000, `reduction took ${elapsed}ms`);
  const series = normalizeSeries({ psnr: points }, { maxPoints: 240 });
  assert.equal(series[0].pointCount, 50_000);
  assert.equal(series[0].returnedPointCount, 240);
  assert.equal(series[0].aggregation, "extrema-bucket");
});

test("metric ingestion is idempotent, sorts out-of-order events, and reports invalid rows", () => {
  const store = new MetricIngestionStore({ clock: () => new Date("2026-08-19T00:00:00.000Z") });
  const run = { ref: "simulation:run:ingestion-test", label: "ingestion test", status: "RUNNING" };
  const first = store.ingest({ run, events: [
    { eventId: "b", metric: "eval/psnr", value: 26, step: 10 },
    { eventId: "a", metric: "eval/psnr", value: 22, step: 0 },
    { eventId: "bad", metric: "eval/psnr", value: 2, step: -1 },
  ] });
  assert.equal(first.accepted, 2);
  assert.equal(first.rejected, 1);
  const second = store.ingest({ run, events: [
    { eventId: "a", metric: "eval/psnr", value: 22, step: 0 },
    { eventId: "c", metric: "eval/psnr", value: 27, step: 20 },
  ] });
  assert.equal(second.duplicates, 1);
  assert.equal(second.accepted, 1);
  const duplicateOnly = store.ingest({ run, events: [{ eventId: "c", metric: "eval/psnr", value: 27, step: 20 }] });
  assert.equal(duplicateOnly.changed, false);
  assert.equal(duplicateOnly.revision, second.revision);
  const series = store.series(run.ref, { metricKeys: ["eval/psnr"], maxPoints: 10 });
  assert.deepEqual(series.series[0].points.map((point) => point.x), [0, 10, 20]);
  assert.equal(series.series[0].pointCount, 3);
  assert.equal(store.get(run.ref).run.metrics["eval/psnr"], 27);
});

test("generated event ids remain stable when a retry omitted the timestamp", () => {
  let tick = 0;
  const store = new MetricIngestionStore({ clock: () => new Date(Date.UTC(2026, 7, 19, 0, 0, tick++)) });
  const run = { ref: "simulation:run:generated-id", status: "RUNNING" };
  const event = { metric: "train/loss", value: 0.4, step: 10 };
  assert.equal(store.ingest({ run, events: [event] }).accepted, 1);
  const retried = store.ingest({ run, events: [event] });
  assert.equal(retried.duplicates, 1);
  assert.equal(store.series(run.ref).series[0].pointCount, 1);
});

test("training simulator produces deterministic dense metric batches", () => {
  const first = createTrainingSimulation({ totalSteps: 50_000, logEvery: 100, seed: 42 });
  const second = createTrainingSimulation({ totalSteps: 50_000, logEvery: 100, seed: 42 });
  assert.equal(first.steps.length, 501);
  assert.equal(first.totalEvents, 501 * first.metricKeys.length);
  assert.deepEqual(first.batches().next().value, second.batches().next().value);
  assert.ok(first.metricKeys.includes("train/loss"));
  assert.ok(first.metricKeys.includes("eval/psnr"));
  assert.ok(first.metricKeys.includes("eval/lpips"));
  assert.ok(first.metricKeys.includes("train/learning_rate"));
});

test("metric summaries use direction-aware semantics for namespaced metrics", () => {
  const history = {
    "eval/lpips": [{ x: 0, y: 0.4 }, { x: 1, y: 0.2 }],
    "val/loss": [{ x: 0, y: 0.8 }, { x: 1, y: 0.3 }],
    "eval/psnr": [{ x: 0, y: 22 }, { x: 1, y: 28 }],
  };
  const gateway = new ExperimentTrackingGateway({}, { providers: {} });
  gateway.ingestMetrics({ run: { ref: "simulation:run:direction-test", status: "FINISHED" }, events: Object.entries(history).flatMap(([metric, points]) => points.map((point) => ({ metric, ...point }))) });
  const run = gateway.ingestion.get("simulation:run:direction-test").run;
  assert.equal(run.metricSummary["eval/lpips"].best, 0.2);
  assert.equal(run.metricSummary["val/loss"].best, 0.3);
  assert.equal(run.metricSummary["eval/psnr"].best, 28);
  const series = gateway.ingestion.series("simulation:run:direction-test");
  assert.equal(series.series.find((line) => line.key === "eval/lpips").higherIsBetter, false);
});

test("gateway ingests a simulated run and serves bounded chart/context data", async () => {
  const gateway = new ExperimentTrackingGateway({}, { providers: {} });
  const simulator = new TrainingSimulationService({ gateway, clock: () => new Date("2026-08-19T00:00:00.000Z") });
  const result = await simulator.run({ totalSteps: 5_000, logEvery: 10, batchSteps: 100, runId: "gateway-test", group: "G1" });
  assert.equal(result.mode, "simulation");
  assert.equal(result.rejected, 0);
  assert.equal(result.run.status, "FINISHED");
  assert.equal(result.run.metricSummary["eval/psnr"].count, 501);
  assert.equal(result.run.metricHistory, undefined);
  assert.equal(result.run.metricPointCounts["eval/psnr"], 501);

  const series = await gateway.series(result.runRef, { metricKeys: ["eval/psnr"], maxPoints: 120 });
  assert.equal(series.series[0].pointCount, 501);
  assert.equal(series.series[0].returnedPointCount, 120);
  assert.equal(series.series[0].aggregation, "extrema-bucket");
  const chart = await gateway.chart(result.runRef, { metricKeys: ["eval/psnr"], maxPoints: 120 });
  assert.equal(chart.mimeType, "image/svg+xml");
  assert.match(chart.content, /^<svg/);
  assert.doesNotMatch(chart.content, /<script/i);
  const beforeHits = gateway.stats.cacheHits;
  await gateway.chart(result.runRef, { metricKeys: ["eval/psnr"], maxPoints: 120 });
  assert.ok(gateway.stats.cacheHits > beforeHits);
});

test("simulation provider filtering does not fan out to native providers", async () => {
  const gateway = new ExperimentTrackingGateway({}, {
    providers: {
      mlflow: {
        id: "mlflow-test",
        async descriptor() { return { provider: "mlflow", capabilityProfile: {}, health: { status: "ready" } }; },
        async listRuns() { throw new Error("native provider should not be queried"); },
        async snapshot() { return { runs: [] }; },
        async getRun() { throw new Error("native provider should not be queried"); },
        async getSeries() { throw new Error("native provider should not be queried"); },
      },
    },
  });
  const simulator = new TrainingSimulationService({ gateway, clock: () => new Date("2026-08-19T00:00:00.000Z") });
  await simulator.run({ totalSteps: 20, logEvery: 10, batchSteps: 20, runId: "filter-test" });
  const page = await gateway.list({ provider: "simulation" });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].provider, "simulation");
  const experiments = await gateway.listExperiments({ provider: "simulation" });
  assert.deepEqual(experiments.items.map((item) => item.provider), ["simulation"]);
  const synced = await gateway.sync({ providers: ["simulation"], force: true });
  assert.equal(synced.snapshots.simulation.runs.length, 1);
});
