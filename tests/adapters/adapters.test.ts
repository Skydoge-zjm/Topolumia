import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { parseNumstat, parsePorcelainV2Z } from "../../src/adapters/sources/git-adapter.js";
import { FilesystemAdapter, isPathInside } from "../../src/adapters/sources/filesystem-adapter.js";
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
