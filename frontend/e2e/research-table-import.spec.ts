import { runtimeArtifact } from "./support/runtime-artifacts";
import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../dist/src/server.js";
import { exportXlsxTable } from "../../dist/src/services/topology/table-importers.js";
import { styledTexFixture, styledXlsxFixture } from "../../dist/fixtures/research/styled-table-fixture.js";

test("imports real TeX and XLSX table files and renders both in a literature node", async ({ page }) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-table-browser-"));
  const fixtures = path.join(root, "fixtures");
  await mkdir(fixtures);
  const texPath = path.join(fixtures, "sr3-table2.tex");
  const xlsxPath = path.join(fixtures, "sr3-table2.xlsx");
  const slash = String.fromCharCode(92), rowEnd = slash + slash;
  const tex = [
    slash + "begin{table}",
    slash + "caption{SR3 ImageNet super-resolution results}",
    slash + "begin{tabular}{lrrrr}",
    slash + "toprule",
    "Model & FID $\\downarrow$ & IS $\\uparrow$ & PSNR $\\uparrow$ & SSIM $\\uparrow$ " + rowEnd,
    slash + "midrule",
    "Reference & 1.9 & 240.8 & -- & -- " + rowEnd,
    "Regression & 15.2 & 121.1 & 27.9 & 0.801 " + rowEnd,
    "SR3 & 5.2 & 180.1 & 26.4 & 0.762 " + rowEnd,
    slash + "bottomrule",
    slash + "end{tabular}",
    slash + "end{table}",
  ].join("\n");
  await writeFile(texPath, tex, "utf8");
  const xlsx = exportXlsxTable({
    columns: [{ key: "c1", label: "Model" }, { key: "c2", label: "FID ↓" }, { key: "c3", label: "IS ↑" }, { key: "c4", label: "PSNR ↑" }, { key: "c5", label: "SSIM ↑" }],
    rows: [
      { c1: "Reference", c2: 1.9, c3: 240.8, c4: "—", c5: "—" },
      { c1: "Regression", c2: 15.2, c3: 121.1, c4: 27.9, c5: 0.801 },
      { c1: "SR3", c2: 5.2, c3: 180.1, c4: 26.4, c5: 0.762 },
    ],
  }, "SR3 Table 2");
  await writeFile(xlsxPath, Buffer.from(xlsx));

  const app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: { project: { workspacesRoot: path.join(root, "workspaces") }, sourceRefresh: { enabled: false } } });
  const admin = app.collaboration.bootstrapAdmin({ username: "table-preview", password: "Table-Preview-2026!" });
  const password = "Table-Preview-2026!";
  const project = app.collaboration.createProject({ id: "table-preview-project", name: "Table preview project" }, app.collaboration.actorForUser(admin.id, app.config.project.id));
  const runtime = await app.getRuntime(project.id);
  const actor = app.collaboration.actorForUser(admin.id, project.id);
  const node = runtime.researchNodes.createNode("paper", { nodeName: "SR3", paperTitle: "Image Super-Resolution via Iterative Refinement", year: 2022, venue: "ICLR 2022" }, actor);

  try {
    await page.request.post(app.url + "/api/auth/login", { data: { username: "table-preview", password } });
    await page.addInitScript(({ id }) => localStorage.setItem("research-workbench-project", id), { id: project.id });
    await page.goto(app.url + "/#/topology/nodes/" + encodeURIComponent(node.node.id));

    await page.getByRole("button", { name: "添加内容块", exact: true }).click();
    await page.getByLabel("内容块标题", { exact: true }).fill("Table 2 · TeX 原表");
    await page.getByRole("button", { name: "内容类型", exact: true }).click();
    await page.getByRole("option", { name: "表格", exact: true }).click();
    await page.getByLabel("或导入 TeX / XLSX / CSV 表格", { exact: true }).setInputFiles(texPath);
    await page.getByRole("button", { name: "保存内容块", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Table 2 · TeX 原表", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "表格数据", exact: true }).click();
    await expect(page.getByRole("cell", { name: "5.2", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "ImageNet 64→256", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "XLSX", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "TEX", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "渲染预览", exact: true }).click();
    await expect(page.getByRole("table")).toHaveCount(0);
    const compiledImage = page.getByRole("img", { name: "TeX 编译表格预览", exact: true });
    await expect(compiledImage).toBeVisible();
    await expect.poll(() => compiledImage.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    await page.getByRole("button", { name: "添加内容块", exact: true }).click();
    await page.getByLabel("内容块标题", { exact: true }).fill("Table 2 · XLSX 原表");
    await page.getByRole("button", { name: "内容类型", exact: true }).click();
    await page.getByRole("option", { name: "电子表格", exact: true }).click();
    await page.getByLabel("上传 XLSX / CSV", { exact: true }).setInputFiles(xlsxPath);
    await page.getByRole("button", { name: "保存内容块", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Table 2 · XLSX 原表", exact: true })).toBeVisible();
    const xlsxPreview = page.locator(".imported-table-preview").filter({ hasText: "sr3-table2.xlsx" });
    await expect(xlsxPreview.getByRole("cell", { name: "SR3", exact: true })).toBeVisible();
    await expect(xlsxPreview.getByRole("cell", { name: "26.4", exact: true })).toBeVisible();
    await expect(xlsxPreview.getByText("SR3 Table 2", { exact: true })).toBeVisible();
    await page.screenshot({ path: runtimeArtifact("research-node-tex-xlsx-preview.png"), fullPage: true });
  } finally {
    for (const item of app.runtimes.values()) { await item.agentSessionGateway.closeAll(); await item.toolEnvironment.catalog.close(); await item.toolEnvironment.research.close(); }
    await app.sshEnvironments.close(); await app.sshConnections.close(); app.server.closeAllConnections();
    await new Promise<void>(resolve => app.server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("merged and styled TeX/XLSX retain their real layout, bold text, colors and numeric display", async ({ page }) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-styled-table-browser-"));
  const artifacts = runtimeArtifact("research-table-preview-fixtures");
  await mkdir(artifacts, { recursive: true });
  const texPath = path.join(artifacts, "sr3-styled.tex"), xlsxPath = path.join(artifacts, "sr3-styled.xlsx");
  await writeFile(texPath, styledTexFixture(), "utf8");
  await writeFile(xlsxPath, styledXlsxFixture());
  const app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: { project: { workspacesRoot: path.join(root, "workspaces") }, sourceRefresh: { enabled: false } } });
  const admin = app.collaboration.bootstrapAdmin({ username: "styled-table-preview", password: "Styled-Table-2026!" });
  const project = app.collaboration.createProject({ id: "styled-preview-project", name: "Styled table preview" }, app.collaboration.actorForUser(admin.id, app.config.project.id));
  const runtime = await app.getRuntime(project.id);
  const node = runtime.researchNodes.createNode("paper", { nodeName: "SR3", paperTitle: "Merged cells and styled table preview" }, app.collaboration.actorForUser(admin.id, project.id));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.request.post(app.url + "/api/auth/login", { data: { username: "styled-table-preview", password: "Styled-Table-2026!" } });
    await page.addInitScript(({ id }) => localStorage.setItem("research-workbench-project", id), { id: project.id });
    await page.goto(app.url + "/#/topology/nodes/" + encodeURIComponent(node.node.id));
    await page.getByRole("button", { name: "添加内容块", exact: true }).click();
    await page.getByLabel("内容块标题", { exact: true }).fill("TeX · merged and bold");
    await page.getByRole("button", { name: "内容类型", exact: true }).click();
    await page.getByRole("option", { name: "表格", exact: true }).click();
    await page.getByLabel("或导入 TeX / XLSX / CSV 表格", { exact: true }).setInputFiles(texPath);
    await page.getByRole("button", { name: "保存内容块", exact: true }).click();
    const tex = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "TeX · merged and bold", exact: true }) });
    const compiled = tex.getByRole("img", { name: "TeX 编译表格预览", exact: true });
    await expect(compiled).toBeVisible();
    await expect.poll(() => compiled.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(tex.getByRole("table")).toHaveCount(0);
    await tex.getByRole("tab", { name: "表格数据", exact: true }).click();
    await expect(compiled).toHaveCount(0);
    await expect(tex.locator('[data-cell="A1"]')).toHaveAttribute("colspan", "2");
    await expect(tex.locator('[data-cell="C1"]')).toHaveAttribute("colspan", "3");
    await expect(tex.locator('[data-cell="A3"]')).toHaveAttribute("rowspan", "2");
    await expect(tex.locator('[data-cell="A4"]')).toHaveCount(0);
    await expect(tex.locator('[data-cell="C5"]')).toHaveText("5.20");
    await tex.getByRole("tab", { name: "渲染预览", exact: true }).click();
    await expect(tex.getByRole("table")).toHaveCount(0);
    await page.getByRole("button", { name: "添加内容块", exact: true }).click();
    await page.getByLabel("内容块标题", { exact: true }).fill("XLSX · merged and styled");
    await page.getByRole("button", { name: "内容类型", exact: true }).click();
    await page.getByRole("option", { name: "电子表格", exact: true }).click();
    await page.getByLabel("上传 XLSX / CSV", { exact: true }).setInputFiles(xlsxPath);
    await page.getByRole("button", { name: "保存内容块", exact: true }).click();
    const xlsx = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "XLSX · merged and styled", exact: true }) });
    await expect(xlsx.locator('[data-cell="A1"]')).toHaveAttribute("colspan", "2");
    await expect(xlsx.locator('[data-cell="C1"]')).toHaveAttribute("colspan", "3");
    await expect(xlsx.locator('[data-cell="A3"]')).toHaveAttribute("rowspan", "2");
    await expect(xlsx.locator('[data-cell="A4"]')).toHaveCount(0);
    await expect(xlsx.locator('[data-cell="A1"]')).toHaveCSS("background-color", "rgb(21, 94, 99)");
    await expect(xlsx.locator('[data-cell="A1"]')).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(xlsx.locator('[data-cell="C5"]')).toHaveText("5.20");
    await expect(xlsx.locator('[data-cell="C5"]')).toHaveCSS("font-weight", "700");
    await expect(xlsx.locator('[data-cell="C5"]')).toHaveCSS("background-color", "rgb(220, 252, 231)");
    await expect(xlsx.locator('[data-cell="C5"]')).toHaveCSS("text-align", "right");
    await expect(xlsx.locator('[data-cell="C5"]')).toHaveCSS("border-top-style", "solid");
    await expect(xlsx.locator('[data-cell="E5"]')).toHaveText("76.2%");
    await expect(xlsx.locator('[data-cell="B5"]').getByText("SR", { exact: true })).toHaveCSS("font-weight", "700");
    await expect(xlsx.locator('[data-cell="B5"]').getByText("3", { exact: true })).toHaveCSS("color", "rgb(220, 38, 38)");
    await expect(xlsx.locator('[data-cell="A6"]')).toHaveAttribute("colspan", "5");
    await expect(xlsx.locator('[data-cell="A6"]')).toHaveCSS("white-space", "pre-wrap");
    await xlsx.getByRole("tab", { name: "表格数据", exact: true }).click();
    await expect(xlsx.locator('[data-cell="C5"]')).toHaveText("5.2");
    await expect(xlsx.locator('[data-cell="E5"]')).toHaveText("0.762");
    await expect(xlsx.getByRole("table")).toHaveCount(1);
    await xlsx.getByRole("tab", { name: "渲染预览", exact: true }).click();
    await page.screenshot({ path: runtimeArtifact("research-node-styled-tables.png"), fullPage: true });
  } finally {
    for (const item of app.runtimes.values()) { await item.agentSessionGateway.closeAll(); await item.toolEnvironment.catalog.close(); await item.toolEnvironment.research.close(); }
    await app.sshEnvironments.close(); await app.sshConnections.close(); app.server.closeAllConnections();
    await new Promise<void>(resolve => app.server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
