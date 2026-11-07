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

test("research experiment API uses saved node/run identities and never invents tracker attempts", async () => {
  await request("/api/sync", { method: "POST", body: "{}" });
  const topology = await request("/api/topology");
  const forbiddenKinds = new Set(["run", "config", "artifact", "gitCommit", "workspaceChange", "delegation", "agentSession", "executionPreview"]);
  assert.equal(topology.payload.nodes.some(node => forbiddenKinds.has(node.kind)), false);
  assert.ok(topology.payload.nodes.every(node => ["paper", "experiment", "note"].includes(node.kind)));
  const nodeId = "experiment:g1";
  const recorded = await request("/api/research-nodes/" + encodeURIComponent(nodeId) + "/experiment", {
    method: "PATCH", body: JSON.stringify({ expectedExperimentRevision: 1, patch: { addRuns: [{ label: "OOM attempt", status: "failed" }, { label: "Retry", status: "succeeded" }] } }),
  });
  assert.equal(recorded.response.status, 200, JSON.stringify(recorded.payload));
  const index = await request("/api/research-experiments");
  assert.equal(index.response.status, 200);
  const entry = index.payload.items.find(item => item.id === nodeId);
  assert.deepEqual(entry.runs.map(run => run.label), ["OOM attempt", "Retry"]);
  const detail = await request("/api/research-experiments/" + encodeURIComponent(nodeId));
  assert.equal(detail.response.status, 200);
  assert.equal(detail.payload.nodeId, nodeId);
  assert.deepEqual(detail.payload.runs.map(run => run.status), ["failed", "succeeded"]);
  assert.equal((await request("/api/research-experiments/g1")).response.status, 404);
  const read = await request("/api/research/experiments/read", { method: "POST", body: JSON.stringify({ mode: "runs", nodeId }) });
  assert.equal(read.response.status, 200);
  assert.equal(read.payload.kind, "experiment");
  assert.equal(read.payload.data.items.length, 2);
  const compare = await request("/api/research/experiments/read", { method: "POST", body: JSON.stringify({ mode: "compare", selections: detail.payload.runs.map(run => ({ nodeId, runId: run.id })) }) });
  assert.equal(compare.response.status, 200);
  assert.equal(compare.payload.data.temporary, true);
  assert.equal(compare.payload.data.items.length, 0);
});

test("Docker preview rejects an absent execution contract with a typed error", async () => {
  const response = await request("/api/executions/docker/preview", { method: "POST", body: "{}" });
  assert.equal(response.response.status, 422);
  assert.equal(response.payload.error.code, "EXECUTION_INPUT_REQUIRED");
});
