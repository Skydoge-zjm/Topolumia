import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config.js";
import {
  ResearchEnvironmentProbes,
  parseNvidiaGpuCsv,
  parseNvccVersion,
} from "../../src/services/environments/research-environment-probes.js";

const python = {
  executable: "/study/.venv/bin/python",
  version: "3.12.8",
  prefix: "/study/.venv",
  basePrefix: "/python",
  kind: "venv",
  projectVenv: "/study/.venv/bin/python",
};
const ok = (stdout) => ({ ok: true, stdout, stderr: "", timedOut: false });
const packet = (value) =>
  ok(`library output\nTOPOLUMIA_PYTHON_PROBE:${JSON.stringify(value)}\n`);
async function config() {
  return loadConfig({
    project: { root: process.cwd() },
    toolCommands: {
      conda: "/fixture/conda",
      uv: "/fixture/uv",
      nvidia: "/fixture/nvidia-smi",
      cuda: "/fixture/nvcc",
    },
  });
}

test("NVIDIA driver compatibility and installed Toolkit remain separate and zero free memory is preserved", async () => {
  let cudaLabel = "CUDA Version";
  const probes = new ResearchEnvironmentProbes(
    await config(),
    async (_command, args) => {
      if (args[0]?.startsWith("--query-gpu"))
        return ok('0, "NVIDIA Research GPU, A", 580.99, 24576, 0\n');
      if (!args.length)
        return ok(`${cudaLabel}: 13.0\nprivate-process-name-not-for-UI`);
      return ok("Cuda compilation tools, release 12.8, V12.8.93");
    },
  );
  const driver = await probes.probe("nvidia");
  const toolkit = await probes.probe("cuda");
  assert.equal(driver.version, "580.99");
  assert.equal(driver.driverCudaMax, "13.0");
  assert.equal(driver.gpus[0].freeMiB, 0);
  assert.equal(driver.gpus[0].name, "NVIDIA Research GPU, A");
  assert.equal(toolkit.version, "12.8.93");
  assert.ok(!JSON.stringify(driver).includes("private-process-name"));
  cudaLabel = "CUDA UMD Version";
  assert.equal((await probes.probe("nvidia")).driverCudaMax, "13.0");
  assert.throws(() => parseNvidiaGpuCsv("garbage"));
  assert.throws(() => parseNvccVersion("Node.js v22.18.0"));
});

test("Conda and uv return bounded relevant metadata and only execute read-only queries", async () => {
  const calls = [];
  const probes = new ResearchEnvironmentProbes(
    await config(),
    async (command, args) => {
      calls.push({ command, args });
      return args[0] === "info"
        ? ok(
            JSON.stringify({
              conda_version: "25.7.0",
              root_prefix: "/conda",
              active_prefix: "/conda/envs/study",
              envs: Array.from({ length: 100 }, (_, index) => `/env/${index}`),
              channels: ["private-token-channel"],
            }),
          )
        : ok("uv 0.8.0 (fixture)");
    },
  );
  const conda = await probes.probe("conda");
  const uv = await probes.probe("uv");
  assert.equal(conda.status, "ready");
  assert.equal(uv.version, "0.8.0");
  assert.equal(
    conda.facts.filter((item) => item.labelEn.startsWith("Environment "))
      .length,
    32,
  );
  assert.ok(!JSON.stringify(conda).includes("private-token-channel"));
  assert.deepEqual(
    calls.map((call) => call.args),
    [["info", "--json"], ["--version"]],
  );
});

test("Jupyter and framework checks use the selected Python, with CPU-only, missing and timeout results distinguished", async () => {
  const cfg = await config();
  cfg.researchEnvironment = { kind: "custom", prefix: "", pythonCommand: "/selected/python" };
  const calls = [];
  const probes = new ResearchEnvironmentProbes(
    cfg,
    async (command, args, options) => {
      calls.push({ command, mode: args.at(-1), options });
      const mode = args.at(-1);
      if (mode === "identity") return packet({ status: "ready", python });
      if (mode === "jupyter")
        return packet({
          status: "ready",
          version: "4.4.0",
          frontend: "jupyterlab",
          packages: { jupyterlab: "4.4.0", ipykernel: "6.30.0" },
          python,
        });
      if (mode === "torch")
        return packet({
          status: "ready",
          version: "2.8.0+cpu",
          gpuAvailable: false,
          gpuTest: "unavailable",
        });
      if (mode === "jax") return packet({ status: "not_installed" });
      return { ok: false, stdout: "", stderr: "", timedOut: true };
    },
  );
  const [first, second] = await Promise.all([
    probes.identity(),
    probes.identity(),
  ]);
  assert.equal(first.executable, python.executable);
  assert.equal(first, second);
  assert.equal(calls.filter((call) => call.mode === "identity").length, 1);
  const jupyter = await probes.probe("jupyter");
  assert.equal(jupyter.location, python.executable);
  assert.ok(
    !calls.some((call) => ["torch", "jax", "tensorflow"].includes(call.mode)),
    "Ordinary checks must not import ML frameworks",
  );
  const result = await probes.inspectPython();
  assert.equal(result.python.executable, python.executable);
  assert.deepEqual(
    result.frameworks.map((item) => item.status),
    ["ready", "not_installed", "timeout"],
  );
  assert.equal(result.frameworks[0].gpuTest, "unavailable");
  assert.ok(calls.every((call) => call.command === "/selected/python"));
  assert.equal(
    calls.find((call) => call.mode === "jax").options.env
      .XLA_PYTHON_CLIENT_PREALLOCATE,
    "false",
  );
});

test("GPU operation failures and malformed process output remain explicit failures", async () => {
  const probes = new ResearchEnvironmentProbes(
    await config(),
    async (_command, args) => {
      if (args.at(-1) === "identity")
        return packet({ status: "ready", python });
      return packet({
        status: "error",
        version: "2.8.0",
        gpuAvailable: true,
        gpuTest: "failed",
        detail: "GPU operation failed",
      });
    },
  );
  assert.equal((await probes.inspectPython()).frameworks[0].gpuTest, "failed");
  const malformed = new ResearchEnvironmentProbes(await config(), async () =>
    ok("not a probe result"),
  );
  await assert.rejects(malformed.identity(), /有效结果/);
});

test("Conda diagnostics activate the selected prefix using fixed argv, including paths with spaces", async () => {
  const cfg = await config();
  cfg.researchEnvironment = { kind: "conda", prefix: "/research/env with spaces", pythonCommand: "python" };
  let invocation;
  const probes = new ResearchEnvironmentProbes(cfg, async (command, args, options) => {
    invocation = { command, args, options };
    return packet({ status: "ready", python });
  });
  await probes.python("identity");
  assert.equal(invocation.command, "/fixture/conda");
  assert.deepEqual(invocation.args.slice(0, 5), ["run", "--no-capture-output", "--prefix", "/research/env with spaces", "python"]);
  assert.equal(invocation.options.killTree, true);
});
