import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exportSource } from "./export-source.mjs";

const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function write(name, text = name) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  for (const name of ["README.md", "LICENSE", "package.json", "package-lock.json"]) await write(name);
  return { root, write };
}

test("exports current source and formal documentation without local task records, references or Git history", async t => {
  const { root, write } = await fixture(t);
  const keep = ["src/server.ts", "config/topolumia.config.example.json", "fixtures/research/paper-notes.md", "frontend/src/App.tsx", "frontend/public/favicon.svg", ".github/workflows/ci.yml", "tsconfig.backend.check.json", "eslint.backend.config.js", "AGENTS.md", "CLAUDE.md", "DESIGN.md", "CONTRIBUTING.md", "SECURITY.md", ".github/PULL_REQUEST_TEMPLATE.md", ".github/ISSUE_TEMPLATE/bug_report.yml", ".github/ISSUE_TEMPLATE/feature_request.yml", ".github/ISSUE_TEMPLATE/config.yml", "docs/playbooks/getting-started.md", "docs/playbooks/images/getting-started/topology.jpg", "docs/README.md", "docs/product/overview.md", "docs/technical/modules/example/README.md", "docs/playbooks/development.md", "docs/technical/architecture/system.svg", "scripts/runtime/probe-remote-environment.py", "scripts/runtime/probe-research-python.py", "scripts/runtime/ssh-protect-secret.ps1", "scripts/runtime/tensorboard-event-parser.py"];
  const exclude = [".git/config", "docs/.git/config", "docs/work/active/task/plan.md", "docs/work/completed/task/result.json", "docs/references/vendor/SKILL.md", "docs/references/vendor/helper.py", "docs/private.md", "docs/technical/trace.log", "docs/technical/.env", "docs/design.md", "design-references/reference.png", "README_zh.md", "managed-wrappers/README_zh.md", "src/adapters/README.md", "runtime/session.json", "scripts/runtime/runtime/private.json", "scripts/runtime/.env", "src/workspaces/research/private.json", "src/.test-runtime/private.json", "src/.topolumia-transfer/private.json", "src/.topolumia-skills/private.json", "config/topolumia.config.json", ".env", "src/.env.local", "frontend/.npmrc", "frontend/dist/index.html", "frontend/dist/assets/app.js", "dist/src/server.js", "frontend/node_modules/a.js", "src/credentials/api.json", "private.pem"];
  for (const name of [...keep, ...exclude]) await write(name);
  const result = await exportSource(root);
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(result.fileCount, keep.length + 4);
  for (const name of keep) assert.ok(manifest.files.some(file => file.path === name));
  for (const name of exclude) assert.ok(!manifest.files.some(file => file.path === name));
  await write("src/server.ts", "current working copy");
  const next = await exportSource(root);
  assert.equal(await readFile(path.join(next.destination, "src/server.ts"), "utf8"), "current working copy");
});

test("refuses a linked source file or linked output directory", async t => {
  const { root, write } = await fixture(t);
  await write("private/file.txt");
  await mkdir(path.join(root, "src"));
  // Directory junctions work on Windows without requiring symlink privileges.
  await symlink(path.join(root, "private"), path.join(root, "src", "linked"), "junction");
  await assert.rejects(exportSource(root), /links must be reviewed/);
  await rm(path.join(root, "src", "linked"));
  await symlink(path.join(root, "private"), path.join(root, "artifacts", "github", "topolumia"), "junction");
  await assert.rejects(exportSource(root), /linked source export/);
});

test("Git archives retain formal documentation and runtime scripts while excluding local material", async t => {
  const { root, write } = await fixture(t);
  await write(".gitattributes", await readFile(new URL("../../.gitattributes", import.meta.url), "utf8"));
  const keep = ["DESIGN.md", "CONTRIBUTING.md", "SECURITY.md", ".github/PULL_REQUEST_TEMPLATE.md", ".github/ISSUE_TEMPLATE/bug_report.yml", ".github/ISSUE_TEMPLATE/feature_request.yml", ".github/ISSUE_TEMPLATE/config.yml", "docs/playbooks/getting-started.md", "docs/playbooks/images/getting-started/topology.jpg", "docs/README.md", "docs/product/overview.md", "docs/technical/overview.md", "scripts/runtime/probe-research-python.py"];
  const exclude = ["docs/work/task.md", "docs/references/vendor.md", "docs/product/draft.tmp", "design-references/reference.png", "runtime/session.json"];
  for (const name of [...keep, ...exclude]) await write(name);
  await exec("git", ["init", "--quiet", root]);
  await exec("git", ["-C", root, "add", "--force", "."]);
  const { stdout: tree } = await exec("git", ["-C", root, "write-tree"]);
  const { stdout: archive } = await exec("git", ["-C", root, "archive", "--format=tar", tree.trim()], { encoding: "buffer" });
  const names = new Set();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    names.add(header.subarray(0, 100).toString().replace(/\0.*$/s, ""));
    const bytes = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, "").trim(), 8) || 0;
    offset += 512 + Math.ceil(bytes / 512) * 512;
  }
  for (const name of keep) assert.ok(names.has(name), `Missing public file: ${name}`);
  for (const name of exclude) assert.ok(!names.has(name), `Included local file: ${name}`);
});
