import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { parseNumstat, parsePorcelainV2Z } from "../../src/adapters/sources/git-adapter.js";
import { FilesystemAdapter, isPathInside } from "../../src/adapters/sources/filesystem-adapter.js";
import { mapMlflowRun } from "../../src/adapters/experiments/mlflow-adapter.js";
import { MlflowAdapter } from "../../src/adapters/experiments/mlflow-adapter.js";
import { DockerAdapter } from "../../src/adapters/execution/docker-adapter.js";
import { resolveInvocation } from "../../src/lib/command.js";

test("Git porcelain v2 parser keeps branch and file state", () => {
  const input = [
    "# branch.oid abcdef123456",
    "# branch.head feature/sr",
    "# branch.upstream origin/feature/sr",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb scripts/train sr.py",
    "? artifacts/new.json",
    "",
  ].join("\0");
  const parsed = parsePorcelainV2Z(input);
  assert.equal(parsed.oid, "abcdef123456");
  assert.equal(parsed.head, "feature/sr");
  assert.equal(parsed.ahead, 2);
  assert.equal(parsed.behind, 1);
  assert.deepEqual(parsed.changes.map((change) => change.path), ["scripts/train sr.py", "artifacts/new.json"]);
});

test("Git numstat parser separates staged state", () => {
  assert.deepEqual(parseNumstat("12\t3\tsrc/model.py\n-\t-\tweights.bin\n", true), [
    { path: "src/model.py", added: 12, deleted: 3, binary: false, staged: true },
    { path: "weights.bin", added: null, deleted: null, binary: true, staged: true },
  ]);
});

test("filesystem adapter scans allowlisted text and produces stable hashes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adapter-mvp-fs-"));
  try {
    await writeFile(path.join(root, "notes.md"), "# Stable content\n", "utf8");
    await writeFile(path.join(root, "ignored.exe"), "not selected", "utf8");
    const config = await loadConfig({
      project: { root },
      filesystem: { roots: [root], maxFiles: 10, maxDepth: 2 },
    });
    const adapter = new FilesystemAdapter(config);
    const first = await adapter.snapshot();
    const second = await adapter.snapshot();
    assert.equal(first.files.length, 1);
    assert.equal(first.files[0].ref, "file:notes.md");
    assert.equal(first.files[0].hash, second.files[0].hash);
    assert.match(first.files[0].excerpt, /Stable content/);
    assert.equal(first.skipped.extension, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("path containment rejects siblings with a common prefix", () => {
  const parent = path.resolve("C:/research/project");
  assert.equal(isPathInside(parent, path.resolve(parent, "notes/file.md")), true);
  assert.equal(isPathInside(parent, path.resolve("C:/research/project-other/file.md")), false);
});

test("MLflow mapping keeps run facts separate and selects latest metric step", () => {
  const mapped = mapMlflowRun({
    info: { run_id: "run-1", run_name: "G1", experiment_id: "7", status: "FINISHED", end_time: 1_786_821_100_000 },
    data: {
      metrics: [
        { key: "lpips", value: 0.21, step: 10 },
        { key: "lpips", value: 0.19, step: 20 },
      ],
      params: [{ key: "group", value: "G1" }],
      tags: [{ key: "research.role", value: "conditioning" }],
    },
  });
  assert.equal(mapped.ref, "mlflow:run:run-1");
  assert.equal(mapped.group, "G1");
  assert.equal(mapped.metrics.lpips, 0.19);
  assert.equal(mapped.params.group, "G1");
});

test("MLflow live adapter follows run-search pagination", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    requests.push({ method: request.method, url: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.url.startsWith("/api/2.0/mlflow/experiments/search")) {
      response.end(JSON.stringify({ experiments: [{ experiment_id: "9", name: "diffusion-sr-reproduction" }] }));
      return;
    }
    if (request.url === "/api/2.0/mlflow/runs/search" && !body.page_token) {
      response.end(JSON.stringify({
        runs: [{ info: { run_id: "r1", experiment_id: "9", status: "FINISHED" }, data: { params: [{ key: "group", value: "G0" }] } }],
        next_page_token: "page-2",
      }));
      return;
    }
    if (request.url === "/api/2.0/mlflow/runs/search" && body.page_token === "page-2") {
      response.end(JSON.stringify({
        runs: [{ info: { run_id: "r2", experiment_id: "9", status: "FINISHED" }, data: { params: [{ key: "group", value: "G1" }] } }],
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const config = await loadConfig({ mlflow: { baseUrl: `http://127.0.0.1:${address.port}`, pageSize: 1 } });
    const adapter = new MlflowAdapter(config);
    const snapshot = await adapter.snapshot();
    assert.equal(snapshot.mode, "live");
    assert.deepEqual(snapshot.runs.map((run) => run.externalId), ["r1", "r2"]);
    assert.equal(requests.filter((item) => item.url === "/api/2.0/mlflow/runs/search").length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Docker preview is deterministic and rejects unregistered inputs", async () => {
  const config = await loadConfig();
  const adapter = new DockerAdapter(config);
  const first = adapter.preview("diffusion-sr-factorial-preview", {
    dataset: "DIV2K-valid-x4",
    steps: 50,
    seeds: [13, 42, 73],
  });
  const second = adapter.preview("diffusion-sr-factorial-preview", {
    dataset: "DIV2K-valid-x4",
    steps: 50,
    seeds: [13, 42, 73],
  });
  assert.equal(first.id, second.id);
  assert.equal(first.previewOnly, true);
  assert.ok(first.argv.includes("--network"));
  assert.ok(first.argv.includes("none"));
  assert.throws(
    () => adapter.preview("diffusion-sr-factorial-preview", { dataset: "../../secret", steps: 50, seeds: [1] }),
    (error) => error.code === "INVALID_EXECUTION_INPUT",
  );
});

test("ACP profile launches bridge Windows .cmd shims without enabling a generic shell", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific process invocation");
    return;
  }
  const shim = path.join(os.tmpdir(), "research-workbench-agent.cmd");
  const invocation = await resolveInvocation(shim, ["acp"], { allowCmdShim: true });
  assert.equal(invocation.executable.toLowerCase(), (process.env.ComSpec || "cmd.exe").toLowerCase());
  assert.deepEqual(invocation.args.slice(0, 4), ["/d", "/s", "/c", "call"]);
  assert.equal(invocation.args[4], shim);
  assert.equal(invocation.args[5], "acp");
});
