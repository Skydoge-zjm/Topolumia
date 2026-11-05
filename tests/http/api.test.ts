import { installTopologyFixture } from "../helpers/topology-fixture.js";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startMvpServer } from "../../src/server.js";

let app;

before(async () => {
  app = await startMvpServer({ port: 0 });
  installTopologyFixture(app);
  await app.sourceRefresh.refresh({ reason: "test-setup", force: true });
});

after(async () => {
  if (app?.server) await new Promise((resolve) => app.server.close(resolve));
});

async function request(path, options = {}) {
  const response = await fetch(`${app.url}${path}`, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers ?? {}) },
  });
  const payload = await response.json();
  return { response, payload };
}

test("tools and environment inventory starts unchecked and does not claim fixture connections", async () => {
  const { response, payload } = await request("/api/tools-environment");
  assert.equal(response.status, 200);
  assert.equal(payload.schemaVersion, "tools-environment.v3");
  assert.deepEqual(payload.tools.map((tool) => tool.id), ["git", "docker", "jupyter", "mlflow", "wandb", "tensorboard", "torch", "jax", "tensorflow"]);
  assert.equal(payload.tools.find((tool) => tool.id === "mlflow").status, "not_configured");
  assert.deepEqual(payload.environment.map(tool => tool.id), ["workspace", "node", "python", "conda", "uv", "nvidia", "cuda"]);
  assert.deepEqual(payload.tools.map(tool => tool.category), ["development", "development", "experiments", "experiments", "experiments", "experiments", "acceleration", "acceleration", "acceleration"]);
});

test("static application and favicon load with security headers", async () => {
  const page = await fetch(`${app.url}/`);
  const favicon = await fetch(`${app.url}/favicon.svg`);
  assert.equal(page.status, 200);
  assert.equal(favicon.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  const html = await page.text();
  assert.match(html, /Topolumia/);
  const scriptPath = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
  assert.ok(scriptPath?.startsWith("/assets/"));
  const script = await fetch(new URL(scriptPath, app.url));
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
});

test("source refresh API reports an explicit outcome and publishes freshness state", async () => {
  const refreshed = await request("/api/source-refresh", {
    method: "POST",
    body: JSON.stringify({ reason: "manual", force: true }),
  });
  assert.equal(refreshed.response.status, 200);
  assert.equal(refreshed.payload.schemaVersion, "source-refresh-result.v1");
  assert.ok(["updated", "unchanged"].includes(refreshed.payload.outcome));
  assert.ok(refreshed.payload.snapshot?.stateVersion);

  const current = await request("/api/state");
  assert.equal(current.payload.sourceRefresh.status, "ready");
  assert.equal(current.payload.sourceRefresh.lastReason, "manual");
  assert.ok(current.payload.sourceRefresh.lastCheckedAt);
  assert.ok(current.payload.sourceRefresh.nextScheduledAt);
});

test("research experiment API aggregates attempts while the formal topology stays scientific", async () => {
  await request("/api/sync", { method: "POST", body: "{}" });

  const topology = await request("/api/topology");
  assert.equal(topology.response.status, 200);
  const forbiddenKinds = new Set(["run", "config", "artifact", "gitCommit", "workspaceChange", "delegation", "agentSession", "executionPreview"]);
  assert.equal(topology.payload.nodes.some((node) => forbiddenKinds.has(node.kind)), false);
  assert.deepEqual(
    topology.payload.nodes.filter((node) => node.kind === "experiment").map((node) => node.id),
    ["experiment:g0", "experiment:g1", "experiment:g2", "experiment:g3"],
  );

  const index = await request("/api/research-experiments");
  assert.equal(index.response.status, 200);
  assert.equal(index.payload.schemaVersion, "research-experiment-index.v1");
  assert.equal(index.payload.items.length, 4);

  const detail = await request("/api/research-experiments/g1?maxPoints=40");
  assert.equal(detail.response.status, 200);
  assert.equal(detail.payload.experiment.id, "g1");
  assert.ok(detail.payload.attempts.some((attempt) => attempt.attemptRole === "failed"));
  assert.ok(detail.payload.attempts.some((attempt) => attempt.attemptRole === "unstable"));
  assert.ok(detail.payload.attempts.some((attempt) => attempt.attemptRole === "completed"));

  const compactContext = await request("/api/research-experiments/agent-context", {
    method: "POST",
    body: JSON.stringify({ experimentIds: ["g1"] }),
  });
  assert.equal(compactContext.response.status, 200);
  assert.equal(compactContext.payload.experiments.length, 1);
  assert.equal(compactContext.payload.runs.length, 0);
  assert.equal(compactContext.payload.capabilities.attemptDetails, false);

  const expandedContext = await request("/api/research-experiments/agent-context", {
    method: "POST",
    body: JSON.stringify({ experimentIds: ["g1"], includeDetails: true, includeCharts: true, maxPoints: 40, accepts: ["text", "image/svg+xml"] }),
  });
  assert.equal(expandedContext.response.status, 200);
  assert.ok(expandedContext.payload.runs.length >= 1);
  assert.ok(expandedContext.payload.series.length >= 1);
});

test("Docker preview rejects an absent execution contract with a typed error", async () => {
  const response = await request("/api/executions/docker/preview", { method: "POST", body: "{}" });
  assert.equal(response.response.status, 422);
  assert.equal(response.payload.error.code, "EXECUTION_INPUT_REQUIRED");
});
