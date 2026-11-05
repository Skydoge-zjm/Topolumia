import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { loadConfig, mvpRoot } from "../../src/config.js";
import { MlflowAdapter } from "../../src/adapters/experiments/mlflow-adapter.js";
import { TensorboardAdapter } from "../../src/adapters/experiments/tensorboard-adapter.js";
import { ExperimentTrackingGateway } from "../../src/services/experiments/experiment-tracking-gateway.js";

const runtimeRoot = path.join(mvpRoot, ".test-runtime");
const python = process.env.EXPERIMENT_TEST_PYTHON || path.join(
  mvpRoot,
  process.platform === "win32" ? ".venv-test/Scripts/python.exe" : ".venv-test/bin/python",
);
const verifier = path.join(mvpRoot, "scripts", "integration", "verify-experiment-test-env.py");
const tensorboardParser = path.join(mvpRoot, "scripts", "runtime", "tensorboard-event-parser.py");

let fixtureRoot;
let fixture;

function runProcess(command, args, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: mvpRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`process exited with ${code}\n${stderr || stdout}`));
    });
  });
}

function parseJsonOutput(stdout) {
  const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    try { return JSON.parse(line); } catch { /* continue past provider diagnostics */ }
  }
  throw new Error(`no JSON object in process output: ${stdout}`);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("failed to reserve a local test port");
  return port;
}

async function waitForMlflow(baseUrl, child, diagnostics, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`MLflow server exited before becoming ready\n${diagnostics()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/2.0/mlflow/experiments/search?max_results=1`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await delay(250);
  }
  throw new Error(`MLflow server readiness timeout\n${diagnostics()}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const exited = once(child, "exit");
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", resolve);
      killer.once("close", resolve);
    });
    await Promise.race([exited, delay(5_000)]);
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

before(async () => {
  try {
    await access(python);
  } catch {
    throw new Error(`isolated Python environment is missing: ${python}\nRun scripts/integration/setup-experiment-test-env.ps1 first.`);
  }
  await mkdir(runtimeRoot, { recursive: true });
  fixtureRoot = await mkdtemp(path.join(runtimeRoot, "integration-"));
  const generated = await runProcess(python, [verifier, "--output-dir", fixtureRoot]);
  fixture = parseJsonOutput(generated.stdout);
});

after(async () => {
  if (fixtureRoot) {
    await delay(250);
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
});

test("isolated environment generates a real W&B offline run", async () => {
  assert.equal(fixture.isolated, true);
  assert.equal(fixture.compatible, true);
  assert.match(fixture.python, /^3\.12\./);
  for (const name of ["mlflow", "tensorboard", "wandb", "pytest", "pillow"]) {
    assert.ok(fixture.packages[name], `${name} should report an installed version`);
  }
  assert.match(fixture.wandb.runId, /^[a-z0-9]+$/i);
  assert.equal((await stat(fixture.wandb.runDir)).isDirectory(), true);
  const offlineFiles = await readdir(path.dirname(fixture.wandb.runDir));
  assert.ok(offlineFiles.some((name) => name.endsWith(".wandb")), "W&B SDK should emit its offline run record");
});

test("TensorBoard adapter parses real protobuf events through the bundled sidecar", { timeout: 60_000 }, async () => {
  const config = await loadConfig({
    tensorboard: {
      logdir: fixture.tensorboard.runDir,
      pythonCommand: python,
      parserScript: tensorboardParser,
      parserTimeoutMs: 30_000,
      maxDepth: 2,
    },
  });
  const adapter = new TensorboardAdapter(config);
  const health = await adapter.health();
  assert.equal(health.status, "ready");
  const snapshot = await adapter.localSnapshot();
  assert.equal(snapshot.mode, "local");
  assert.equal(snapshot.runs.length, 1);
  const run = snapshot.runs[0];
  assert.ok(Math.abs(run.metricSummary["eval/psnr"].latest - 27.08) < 0.001);
  assert.ok(Math.abs(run.metricSummary["eval/lpips"].latest - 0.189) < 0.001);
  assert.equal(run.metricSummary["eval/psnr"].count, 501);
  assert.equal(run.metricSummary["eval/lpips"].count, 501);
  assert.ok(run.media.some((item) => item.tag === "qualitative/sample" && item.width === 32 && item.height === 32));
  const series = await adapter.getSeries(run.ref, {
    metricKeys: ["eval/psnr", "eval/lpips"],
    maxPoints: 10,
  });
  assert.deepEqual(series.series.map((item) => item.pointCount), [501, 501]);
  assert.deepEqual(series.series.map((item) => item.returnedPointCount), [10, 10]);
  assert.equal(series.series[0].points[0].x, 0);
  assert.equal(series.series[0].points.at(-1).x, 50_000);
});

test("MLflow adapter and unified gateway read a real local tracking server", { timeout: 90_000 }, async () => {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stdout = "";
  let stderr = "";
  const server = spawn(python, [
    "-m", "mlflow", "server",
    "--backend-store-uri", fixture.mlflow.trackingUri,
    "--default-artifact-root", fixture.mlflow.artifactRoot,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--workers", "1",
  ], {
    cwd: mvpRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-32_000); });
  server.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_000); });
  try {
    await waitForMlflow(baseUrl, server, () => `${stdout}\n${stderr}`);
    const config = await loadConfig({
      mlflow: {
        baseUrl,
        experimentName: fixture.mlflow.experimentName,
        timeoutMs: 10_000,
        pageSize: 20,
        maxRuns: 20,
      },
    });
    const adapter = new MlflowAdapter(config);
    const snapshot = await adapter.liveSnapshot();
    assert.equal(snapshot.mode, "live");
    assert.equal(snapshot.experiment.name, fixture.mlflow.experimentName);
    const run = snapshot.runs.find((item) => item.externalId === fixture.mlflow.runId);
    assert.ok(run, "generated MLflow run should be visible through REST");
    assert.equal(run.metrics.psnr, 27.08);
    assert.equal(run.metrics.lpips, 0.189);

    const series = await adapter.getSeries(run.ref, {
      metricKeys: ["psnr", "lpips"],
      maxPoints: 10,
    });
    assert.deepEqual(series.series.map((item) => item.pointCount), [501, 501]);
    assert.deepEqual(series.series.map((item) => item.returnedPointCount), [10, 10]);
    assert.equal(series.series[0].points[0].x, 0);
    assert.equal(series.series[0].points.at(-1).x, 50_000);

    const gateway = new ExperimentTrackingGateway(config, { providers: { mlflow: adapter } });
    await gateway.sync({ providers: ["mlflow"], reason: "integration-test", force: true });
    const context = await gateway.agentContext({
      refs: [run.ref],
      metrics: ["psnr", "lpips"],
      maxPoints: 10,
      includeCharts: true,
      accepts: ["text", "image/svg+xml"],
    });
    assert.equal(context.runs[0].ref, run.ref);
    assert.equal(context.series.length, 2);
    assert.equal(context.assets[0].mimeType, "image/svg+xml");
  } finally {
    await stopProcess(server);
  }
});
