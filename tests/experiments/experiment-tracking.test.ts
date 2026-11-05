import { installTopologyFixture } from "../helpers/topology-fixture.js";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../src/server.js";
import { downsamplePoints, metricSummary, renderMetricChart } from "../../src/domain/experiments/experiment-domain.js";
import { loadConfig } from "../../src/config.js";
import { WandbAdapter } from "../../src/adapters/experiments/wandb-adapter.js";
import { TensorboardAdapter } from "../../src/adapters/experiments/tensorboard-adapter.js";
import { ExperimentTrackingGateway } from "../../src/services/experiments/experiment-tracking-gateway.js";
import { normalizeRun, stableRunRef } from "../../src/domain/experiments/experiment-domain.js";

let app;

before(async () => { app = await startMvpServer({ port: 0 });
  installTopologyFixture(app); });
after(async () => { if (app?.server) await new Promise((resolve) => app.server.close(resolve)); });

async function request(path, options = {}) {
  const response = await fetch(`${app.url}${path}`, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers ?? {}) },
  });
  return { response, payload: await response.json() };
}

test("experiment domain preserves summary statistics and curve endpoints", () => {
  const points = Array.from({ length: 101 }, (_, step) => ({ x: step, y: step / 10 }));
  const sampled = downsamplePoints(points, 12);
  assert.equal(sampled.length, 12);
  assert.deepEqual(sampled[0], points[0]);
  assert.deepEqual(sampled.at(-1), points.at(-1));
  const summary = metricSummary({ psnr: points }, {});
  assert.equal(summary.psnr.count, 101);
  assert.equal(summary.psnr.latest, 10);
  assert.equal(summary.psnr.best, 10);
  const svg = renderMetricChart([{ ref: "mlflow:run:test", label: "G0", metricHistory: { psnr: points, lpips: points.map((item) => ({ x: item.x, y: item.y / 100 })) } }]);
  assert.match(svg, /<svg/);
  assert.match(svg, /psnr/);
  assert.match(svg, /lpips/);
  assert.doesNotMatch(svg, /<script/i);
});

test("W&B and TensorBoard adapters expose explicit capability differences", async () => {
  const config = await loadConfig();
  const wandb = new WandbAdapter(config);
  const tensorboard = new TensorboardAdapter(config);
  const [wSnapshot, tSnapshot, wDescriptor, tDescriptor] = await Promise.all([
    wandb.snapshot(), tensorboard.snapshot(), wandb.descriptor(), tensorboard.descriptor(),
  ]);
  assert.equal(wSnapshot.mode, "fixture");
  assert.equal(tSnapshot.mode, "fixture");
  assert.equal(wDescriptor.capabilityProfile.inputs, true);
  assert.equal(tDescriptor.capabilityProfile.structuredRun, false);
  const detail = await wandb.getRun(wSnapshot.runs[0].ref);
  const series = await wandb.getSeries(wSnapshot.runs[0].ref, { metricKeys: ["psnr"], maxPoints: 4 });
  assert.equal(detail.run.provider, "wandb");
  assert.equal(series.series[0].returnedPointCount, 4);
});

test("W&B live adapter maps and paginates official GraphQL run connections", async () => {
  const config = await loadConfig({
    wandb: { baseUrl: "https://api.wandb.invalid", entity: "lab", project: "diffusion", pageSize: 1, maxRuns: 2 },
  });
  const adapter = new WandbAdapter(config);
  const calls = [];
  adapter.requestGraphql = async (_query, variables) => {
    calls.push(variables);
    const second = Boolean(variables.after);
    return {
      project: {
        id: "project-1",
        name: "diffusion",
        runs: {
          edges: [{ node: {
            id: second ? "node-2" : "node-1",
            name: second ? "run-b" : "run-a",
            displayName: second ? "Run B" : "Run A",
            state: "finished",
            group: "G1",
            createdAt: "2026-08-18T00:00:00.000Z",
            heartbeatAt: "2026-08-18T01:00:00.000Z",
            config: JSON.stringify({ seed: { value: second ? 43 : 42 } }),
            summaryMetrics: JSON.stringify({ psnr: second ? 28.2 : 28.1 }),
            tags: [{ name: "reproduction" }],
          } }],
          pageInfo: { hasNextPage: !second, endCursor: second ? null : "next" },
        },
      },
    };
  };
  const snapshot = await adapter.liveSnapshot();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].after, "next");
  assert.equal(snapshot.runs[0].ref, "wandb:run:lab/diffusion/run-a");
  assert.equal(snapshot.runs[0].params.seed, 42);
  assert.equal(snapshot.runs[1].metricSummary.psnr.latest, 28.2);
});

test("TensorBoard adapter routes protobuf event files through the configured sidecar", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-tb-"));
  try {
    const runDir = path.join(root, "run-a");
    await mkdir(runDir);
    await writeFile(path.join(runDir, "events.out.tfevents.1.host"), "fixture", "utf8");
    const config = await loadConfig({ tensorboard: { logdir: root, maxDepth: 2 } });
    const adapter = new TensorboardAdapter(config);
    let parsed = null;
    adapter.parseEventDirectory = async (dir) => {
      parsed = dir;
      return { scalars: { psnr: [{ step: 0, value: 24 }, { step: 10, value: 28 }] } };
    };
    const snapshot = await adapter.localSnapshot();
    assert.equal(parsed, runDir);
    assert.equal(snapshot.mode, "local");
    assert.equal(snapshot.runs.length, 1);
    assert.equal(snapshot.runs[0].metricSummary.psnr.latest, 28);
    assert.equal(snapshot.runs[0].capabilities.structuredRun.status, "unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("experiment APIs return run detail, downsampled series, and multimodal Agent context", async () => {
  const index = await request("/api/experiments?limit=20");
  assert.equal(index.response.status, 200);
  assert.equal(index.payload.schemaVersion, "experiment-index.v1");
  assert.ok(index.payload.items.some((item) => item.provider === "mlflow"));
  assert.ok(index.payload.items.some((item) => item.provider === "wandb"));
  assert.ok(index.payload.items.some((item) => item.provider === "tensorboard"));

  const ref = "mlflow:run:sr3-g1-seed42";
  const detail = await request(`/api/experiments/${encodeURIComponent(ref)}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.payload.run.ref, ref);
  assert.ok(detail.payload.run.metricSummary.lpips);
  assert.ok(detail.payload.series.series.some((item) => item.key === "psnr"));

  const series = await request(`/api/experiments/${encodeURIComponent(ref)}/series?metrics=psnr,lpips&maxPoints=3`);
  assert.equal(series.response.status, 200);
  assert.ok(series.payload.series.every((item) => item.returnedPointCount <= 3));
  assert.ok(series.payload.series.every((item) => item.points.length >= 2));

  const context = await request("/api/agent-context/experiments", {
    method: "POST",
    body: JSON.stringify({ refs: [ref], metrics: ["psnr", "lpips"], includeCharts: true, accepts: ["text", "image/svg+xml"], maxPoints: 8 }),
  });
  assert.equal(context.response.status, 200);
  assert.equal(context.payload.schemaVersion, "experiment-agent-context.v1");
  assert.equal(context.payload.runs[0].ref, ref);
  assert.ok(context.payload.runs[0].metricSummary.psnr.latest);
  assert.ok(context.payload.assets[0].mimeType === "image/svg+xml");
  assert.match(context.payload.assets[0].content, /^<svg/);
  assert.equal(context.payload.content[1].type, "image");
  assert.equal(context.payload.capabilities.fullLogs, false);
});

test("experiment APIs reject unknown refs and oversized curve requests", async () => {
  const missing = await request(`/api/experiments/${encodeURIComponent("mlflow:run:missing")}`);
  assert.equal(missing.response.status, 404);
  assert.equal(missing.payload.error.code, "EXPERIMENT_REF_NOT_FOUND");
  const oversized = await request(`/api/experiments/${encodeURIComponent("mlflow:run:sr3-g1-seed42")}/series?maxPoints=2001`);
  assert.equal(oversized.response.status, 422);
  assert.equal(oversized.payload.error.code, "EXPERIMENT_QUERY_TOO_LARGE");
});

function gatewayProvider(name, { failSnapshot = false, structuredRun = true } = {}) {
  let snapshots = 0;
  const ref = stableRunRef(name, "run-1");
  const run = normalizeRun({
    ref,
    externalId: "run-1",
    label: `${name} run`,
    status: "FINISHED",
    metrics: { psnr: 28.1 },
    metricHistory: { psnr: [{ x: 0, y: 24 }, { x: 10, y: 28.1 }] },
  }, { provider: name, capabilityProfile: { structuredRun, history: true, artifacts: false, inputs: false, media: false } });
  return {
    id: `${name}-test`,
    get snapshots() { return snapshots; },
    async descriptor() { return { id: this.id, provider: name, capabilityProfile: run.capabilityProfile, capabilityDetails: run.capabilities, health: { status: "ready" } }; },
    async snapshot() {
      snapshots += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (failSnapshot) throw new Error(`${name} unavailable`);
      return { provider: name, mode: "fixture", observedAt: "2026-08-19T00:00:00.000Z", runs: [run] };
    },
    async listRuns() {
      if (failSnapshot) throw new Error(`${name} unavailable`);
      return { items: [run], mode: "fixture", sourceStatus: "ready", observedAt: run.observedAt };
    },
    async getRun(requested) {
      if (requested !== ref) throw new Error("missing");
      return { run, source: { provider: name, mode: "fixture", observedAt: run.observedAt } };
    },
    async getSeries() {
      return { ref, provider: name, sourceStatus: "ready", observedAt: run.observedAt, series: [{ key: "psnr", xKey: "step", points: [{ x: 0, y: 24 }, { x: 10, y: 28.1 }], pointCount: 2, returnedPointCount: 2, downsampled: false, missing: false }] };
    },
    async listArtifacts() { return { items: [] }; },
  };
}

test("experiment gateway deduplicates concurrent provider sync", async () => {
  const mlflow = gatewayProvider("mlflow");
  const gateway = new ExperimentTrackingGateway({ experimentGateway: { listTtlMs: 10_000 } }, { providers: { mlflow } });
  const [first, second] = await Promise.all([
    gateway.sync({ reason: "first", force: true }),
    gateway.sync({ reason: "second", force: true }),
  ]);
  assert.equal(mlflow.snapshots, 1);
  assert.equal(first.sourceStatus, "ready");
  assert.equal(second.sourceStatus, "ready");
  assert.equal(first.snapshots.mlflow.runs[0].ref, "mlflow:run:run-1");
});

test("experiment gateway returns healthy providers when one adapter fails", async () => {
  const mlflow = gatewayProvider("mlflow");
  const wandb = gatewayProvider("wandb", { failSnapshot: true });
  const gateway = new ExperimentTrackingGateway({}, { providers: { mlflow, wandb } });
  const sync = await gateway.sync({ force: true });
  assert.equal(sync.sourceStatus, "partial");
  assert.equal(sync.snapshots.wandb.sourceStatus, "unavailable");
  const index = await gateway.list({ limit: 10 });
  assert.equal(index.sourceStatus, "partial");
  assert.deepEqual(index.items.map((item) => item.provider), ["mlflow"]);
  assert.equal(index.warnings[0].provider, "wandb");
});

test("experiment gateway aggregates capabilities and keeps partial Agent context", async () => {
  const mlflow = gatewayProvider("mlflow", { structuredRun: true });
  const tensorboard = gatewayProvider("tensorboard", { structuredRun: false });
  const gateway = new ExperimentTrackingGateway({}, { providers: { mlflow, tensorboard } });
  const context = await gateway.agentContext({
    refs: ["mlflow:run:run-1", "tensorboard:run:run-1"],
    metrics: ["psnr"],
    maxPoints: 8,
  });
  assert.equal(context.runs.length, 2);
  assert.equal(context.capabilityDetails.structuredRun.status, "partial");
  assert.equal(context.capabilities.fullLogs, false);
  assert.equal(context.capabilityDetails.fullLogs.status, "unavailable");
});

test("experiment gateway keeps successful Agent context when one ref fails", async () => {
  const mlflow = gatewayProvider("mlflow");
  const gateway = new ExperimentTrackingGateway({}, { providers: { mlflow } });
  const context = await gateway.agentContext({
    refs: ["mlflow:run:run-1", "mlflow:run:missing"],
    metrics: ["psnr"],
  });
  assert.equal(context.sourceStatus, "partial");
  assert.equal(context.runs.length, 1);
  assert.equal(context.errors.length, 1);
  assert.equal(context.errors[0].ref, "mlflow:run:missing");
});

test("gateway status and comparison APIs expose the unified layer", async () => {
  const status = await request("/api/experiment-gateway");
  assert.equal(status.response.status, 200);
  assert.equal(status.payload.schemaVersion, "experiment-gateway-status.v1");
  assert.equal(status.payload.gateway.contract, "experiment-gateway.v1");
  assert.equal(status.payload.gateway.providerCount, 3);

  const comparison = await request("/api/experiments/compare", {
    method: "POST",
    body: JSON.stringify({
      refs: ["mlflow:run:sr3-g1-seed42", "wandb:run:lab-local/diffusion-sr-reproduction/wb-g1-42"],
      metrics: ["psnr"],
      maxPoints: 4,
    }),
  });
  assert.equal(comparison.response.status, 200);
  assert.equal(comparison.payload.schemaVersion, "experiment-compare.v1");
  assert.equal(comparison.payload.runs.length, 2);
  assert.ok(comparison.payload.series.every((line) => line.runRef));
});

test("simulation API feeds the topology-aware gateway and serves a unified chart", async () => {
  const simulated = await request("/api/experiment-gateway/simulations", {
    method: "POST",
    body: JSON.stringify({ totalSteps: 2_000, logEvery: 10, batchSteps: 100, runId: "api-g1-seed42", group: "G1" }),
  });
  assert.equal(simulated.response.status, 201);
  assert.equal(simulated.payload.mode, "simulation");
  assert.equal(simulated.payload.run.status, "FINISHED");
  assert.equal(simulated.payload.run.metricSummary["eval/psnr"].count, 201);
  assert.equal(simulated.payload.run.metricHistory, undefined);
  assert.equal(simulated.payload.run.metricPointCounts["eval/psnr"], 201);

  const ref = simulated.payload.runRef;
  const series = await request(`/api/experiments/${encodeURIComponent(ref)}/series?metrics=eval%2Fpsnr&maxPoints=80`);
  assert.equal(series.response.status, 200);
  assert.equal(series.payload.series[0].pointCount, 201);
  assert.equal(series.payload.series[0].returnedPointCount, 80);
  assert.equal(series.payload.series[0].aggregation, "extrema-bucket");

  const chartResponse = await fetch(`${app.url}/api/experiments/${encodeURIComponent(ref)}/chart?metrics=eval%2Fpsnr&maxPoints=80`);
  assert.equal(chartResponse.status, 200);
  assert.match(chartResponse.headers.get("content-type"), /image\/svg\+xml/);
  const chart = await chartResponse.text();
  assert.match(chart, /^<svg/);
  assert.doesNotMatch(chart, /<script/i);

  const topology = await request("/api/topology");
  const g1 = topology.payload.nodes.find((node) => node.id === "experiment:g1");
  assert.equal(g1?.kind, "experiment");
  assert.ok(g1?.data?.runSummary?.total >= 2);
  assert.equal(topology.payload.nodes.some((node) => node.kind === "run"), false);
  const state = await request("/api/state");
  assert.equal(state.payload.snapshot.experiments.simulation.runs[0].metricHistory, undefined);
  const gatewayStatus = await request("/api/experiment-gateway");
  assert.equal(gatewayStatus.payload.gateway.providerCount, 4);
  assert.ok(gatewayStatus.payload.providers.some((provider) => provider.provider === "simulation"));
});
