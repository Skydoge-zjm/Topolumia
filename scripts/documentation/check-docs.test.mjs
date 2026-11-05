import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkDocumentation } from "./check-docs.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-docs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (file, content = "") => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };
  await write("README.md", "# Topolumia\n");
  return { root, write };
}

async function documentedProject(t) {
  const setup = await fixture(t), { write } = setup;
  await write("AGENTS.md", "[导航](docs/README.md)\n");
  await write("CLAUDE.md", "@AGENTS.md\n");
  for (const name of ["product/business", "product/requirements", "technical/architecture", "technical/modules", "technical/decisions"])
    await write(`docs/${name}/.gitkeep`);
  await write("docs/README.md", "[产品](product/overview.md#科研对象)\n[技术](technical/overview.md)\n[维护](playbooks/documentation.md)\n");
  await write("docs/product/overview.md", "# 科研对象\n");
  await write("docs/technical/overview.md", "# 技术\n");
  await write("docs/playbooks/documentation.md", "# 维护\n");
  return setup;
}

test("a checkout missing formal documentation or shared development entries fails", async t => {
  const { root } = await fixture(t);
  const errors = (await checkDocumentation(root)).errors.join("\n");
  assert.match(errors, /缺少正式文档目录/);
  assert.match(errors, /缺少入口：AGENTS.md/);
});

test("public navigation works with no local task or reference directories and ignores their contents when present", async t => {
  const { root, write } = await documentedProject(t);
  assert.deepEqual((await checkDocumentation(root)).errors, []);
  await write("docs/references/vendor/README.md", "[上游不存在的链接](missing.md)");
  await write("docs/work/completed/task/plan.md", "[临时记录的本机链接](missing.md)\n");
  await write("docs/technical/overview.md", "# 技术\n```md\n[示例](not-a-file.md)\n```\n");
  assert.deepEqual((await checkDocumentation(root)).errors, []);
});

test("formal documentation cannot depend on ignored files even when they exist locally", async t => {
  const { root, write } = await documentedProject(t);
  await write("docs/work/active/task/plan.md", "# 本机任务\n");
  await write("docs/references/vendor/README.md", "# 下载的参考资料\n");
  await write("docs/technical/overview.md", "[任务](../work/active/task/plan.md)\n[资料](../references/vendor/README.md)\n");
  const errors = (await checkDocumentation(root)).errors;
  assert.equal(errors.filter(error => error.includes("不能依赖本机资料")).length, 2);
});

test("community and design entries are checked for broken links and local-only dependencies", async t => {
  const { root, write } = await documentedProject(t);
  await write("CONTRIBUTING.md", "[开发](docs/playbooks/development.md)\n");
  await write("SECURITY.md", "[维护](docs/playbooks/documentation.md)\n");
  await write("DESIGN.md", "[本机参考](docs/references/private.md)\n");
  await write("docs/references/private.md", "# 本机资料\n");
  await write(".github/PULL_REQUEST_TEMPLATE.md", "[贡献](../CONTRIBUTING.md)\n");
  const errors = (await checkDocumentation(root)).errors;
  assert.ok(errors.some(error => error.startsWith("CONTRIBUTING.md") && error.includes("链接不存在")));
  assert.ok(errors.some(error => error.startsWith("DESIGN.md") && error.includes("不能依赖本机资料")));
  assert.ok(!errors.some(error => error.startsWith("SECURITY.md") || error.startsWith(".github/")));
  await write("docs/playbooks/development.md", "# 开发\n");
  await write("docs/README.md", "[产品](product/overview.md)\n[技术](technical/overview.md)\n[维护](playbooks/documentation.md)\n[开发](playbooks/development.md)\n");
  await write("DESIGN.md", "# 界面约定\n");
  assert.deepEqual((await checkDocumentation(root)).errors, []);
});

test("broken code links, stale anchors, orphan knowledge and bloated shared entries fail", async t => {
  const { root, write } = await documentedProject(t);
  await write("docs/product/overview.md", "# 科研对象\n[代码](../../src/deleted.ts)\n[过时章节](#不存在)\n");
  await write("docs/technical/modules/orphan.md", "# 未被导航链接的设计\n");
  await write("AGENTS.md", "[导航](docs/README.md)\n" + "重复规则\n".repeat(81));
  const errors = (await checkDocumentation(root)).errors.join("\n");
  for (const expected of [/链接不存在/, /锚点不存在/, /导航不可达/, /入口超预算/]) assert.match(errors, expected);
});

test("the documentation layout rejects obsolete knowledge trees and tool-specific duplicated entry", async t => {
  const { root, write } = await documentedProject(t);
  await write("docs/specifications/old.md", "# 已替代\n");
  await write("CLAUDE.md", "这里独立维护另一套规则。\n");
  const errors = (await checkDocumentation(root)).errors.join("\n");
  assert.match(errors, /旧文档目录/);
  assert.match(errors, /导入共同入口/);
});
