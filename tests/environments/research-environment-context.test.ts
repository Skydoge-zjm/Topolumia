import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readResearchEnvironmentContext } from "../../src/services/environments/research-environment-context.js";

function fixture() {
  const prefix = path.resolve("training env");
  const executable = path.join(prefix, process.platform === "win32" ? "python.exe" : "bin/python");
  const timestamp = "2020-01-01T00:00:00.000Z";
  const inspection = { name: "training env", status: "completed", checkedAt: timestamp, components: [
    { id: "python", status: "ready", version: "3.12.8", checkedAt: timestamp, python: { executable, prefix, kind: "conda" } },
    { id: "torch", status: "ready", version: "2.9.0", cudaVersion: "12.8", gpuAvailable: true, gpuTest: "passed", checkedAt: timestamp,
      detail: "private-raw-diagnostic", raw: "private-raw-diagnostic" },
    { id: "cuda", status: "ready", version: "13.0", origin: "host", checkedAt: timestamp },
    { id: "nvidia", status: "ready", version: "580.1", driverCudaMax: "13.0", checkedAt: timestamp,
      gpus: Array.from({ length: 16 }, (_, index) => ({ index, name: "NVIDIA test GPU", totalMiB: 24000, freeMiB: 20000 })) },
  ] };
  const runtime = {
    config: { project: { id: "study", root: path.resolve("research workspace") }, researchEnvironment: { kind: "conda", prefix },
      toolCommands: { conda: path.resolve("manager/conda"), uv: "uv" },
      tensorboard: { logdir: "runs", pythonCommand: "private-service-python" },
      wandb: { baseUrl: "https://api.wandb.ai", entity: "lab", project: "study", token: "private-api-key" } },
    userSettings: { settings: { researchLocation: "local", remoteEnvironment: null } },
    toolEnvironment: { research: { view: () => inspection, start: () => assert.fail("must not run probes") },
      results: new Map([["node", { version: "private-node-version" }], ["git", { status: "ready", version: "2.50.0", checkedAt: timestamp }]]),
      commandRunner: () => assert.fail("must not run commands") },
  };
  const actor = { projectId: "study", user: { id: "owner" }, permissions: ["research.view"] };
  return { runtime, actor, inspection, prefix, executable };
}

test("environment brief preserves the selected invocation and separates CUDA layers without probes or raw context", async (t) => {
  const f = fixture();
  const before = JSON.stringify(f.runtime.config);
  const result = await readResearchEnvironmentContext(f);
  assert.equal(result.host.kind, "local");
  assert.equal(result.workingDirectory, f.runtime.config.project.root);
  assert.equal(result.environment.python.executable, f.executable);
  assert.deepEqual(result.execution.pythonPrefix.args, ["run", "--no-capture-output", "--prefix", f.prefix, f.executable]);
  assert.equal(result.inspection.stale, true);
  assert.equal(result.components.find(item => item.id === "torch").cudaVersion, "12.8");
  assert.equal(result.components.find(item => item.id === "cuda").version, "13.0");
  assert.equal(result.hardware.driverCudaMax, "13.0");
  assert.equal(result.hardware.stale, true);
  assert.equal(result.hardware.gpus.length, 4);
  assert.equal(result.hardware.additionalGpuCount, 12);
  assert.equal(result.tracking.tensorboard.location, "topolumia-service");
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private-|basePrefix|package_inventory/);
  assert.ok(serialized.length < 5000, String(serialized.length));
  t.diagnostic(`Cached training environment brief: ${serialized.length} JSON characters for 16 GPUs (4 summarized).`);
  assert.equal(JSON.stringify(f.runtime.config), before);
});

test("uninspected selections are explicit and selection changes produce a new binding", async () => {
  const f = fixture();
  const previous = await readResearchEnvironmentContext(f);
  f.runtime.config.researchEnvironment = { kind: "custom", pythonCommand: "/project/.venv/bin/python" };
  f.runtime.toolEnvironment.research.view = () => ({ name: "custom", status: "idle", checkedAt: null, components: [] });
  const result = await readResearchEnvironmentContext({ ...f, locale: "en" });
  assert.equal(result.environment.python.executable, "/project/.venv/bin/python");
  assert.equal(result.environment.python.version, null);
  assert.equal(result.inspection.stale, true);
  assert.deepEqual(result.components, []);
  assert.equal(result.execution.pythonPrefix.command, "/project/.venv/bin/python");
  assert.deepEqual(result.execution.pythonPrefix.args, []);
  assert.notEqual(result.bindingVersion, previous.bindingVersion);
  assert.match(result.guidance, /your own tools/);
});

test("environment reads enforce research permission and project scope before reading SSH configuration", async () => {
  const f = fixture();
  for (const actor of [null, { ...f.actor, permissions: [] }, { ...f.actor, projectId: "other" }])
    await assert.rejects(readResearchEnvironmentContext({ ...f, actor }), error => ["AUTH_REQUIRED", "FORBIDDEN", "PROJECT_SCOPE_MISMATCH"].includes(error.code));
  await assert.rejects(readResearchEnvironmentContext({ ...f, locale: "invalid" }), { code: "ENVIRONMENT_LOCALE_INVALID" });
});
