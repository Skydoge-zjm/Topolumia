import { test, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../dist/src/server.js";
import { exportXlsxTable } from "../../dist/src/services/topology/table-importers.js";

test("notes, multi-run records, versioned material links and temporary comparisons share one workspace", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(
    path.join(os.tmpdir(), "topolumia-record-browser-"),
  );
  const app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: path.join(root, "db.sqlite"),
    userSettingsFile: path.join(root, "settings.json"),
    config: {
      project: { workspacesRoot: path.join(root, "workspaces") },
      sourceRefresh: { enabled: false },
      curator: { enabled: false },
      agentSessions: { profiles: [] },
    },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const password = "Native-Records-Browser-2026!",
      user = app.collaboration.bootstrapAdmin({
        username: "record-browser",
        password,
      });
    const actor = app.collaboration.actorForUser(
        user.id,
        app.config.project.id,
      ),
      c = app.researchCommands;
    await page.addInitScript(
      (project) =>
        window.localStorage.setItem("research-workbench-project", project),
      app.config.project.id,
    );
    await page.request.post(app.url + "/api/auth/login", {
      data: { username: "record-browser", password },
    });
    await page.goto(app.url + "/#/topology/new?kind=note");
    await page
      .getByRole("textbox", { name: "节点名称", exact: true })
      .fill("微调实验分析");
    await page
      .getByRole("textbox", { name: "笔记正文", exact: true })
      .fill("## 待研究\n核对不同运行的实际条件和结果。");
    await page
      .getByRole("textbox", { name: "标签 · 逗号分隔", exact: true })
      .fill("微调，个人标签");
    await page.getByRole("button", { name: "保存笔记", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "微调实验分析", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("核对不同运行的实际条件和结果。", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("核对不同运行的实际条件和结果。", { exact: true }),
    ).toBeVisible();
    const note = c.nodes
      .nodes()
      .find((node) => node.core.nodeName === "微调实验分析");
    expect(note.kind).toBe("note");
    expect(note.core.tags).toEqual(["微调", "个人标签"]);
    expect(
      c.nodes.blocks(note.id).filter((block) => block.role === "body"),
    ).toHaveLength(1);
    await page.locator(".note-body-workspace").getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByRole("textbox", { name: "笔记正文", exact: true }).fill("尚未保存的研究结论");
    page.once("dialog", dialog => dialog.dismiss());
    await page.getByRole("button", { name: "关系与来源", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "笔记正文", exact: true })).toHaveValue("尚未保存的研究结论");
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "关系与来源", exact: true }).click();
    await expect(page.getByRole("heading", { name: "科研关系", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "研究材料", exact: true }).click();
    await expect(page.getByText("核对不同运行的实际条件和结果。", { exact: true })).toBeVisible();

    const experiment = app.researchNodes.createNode(
      "experiment",
      { nodeName: "Rank 4 微调" },
      actor,
    ).node;
    await page.goto(
      app.url + "/#/topology/nodes/" + encodeURIComponent(experiment.id),
    );
    await page.getByRole("button", { name: "添加内容块", exact: true }).click();
    await page
      .getByRole("textbox", { name: "内容块标题", exact: true })
      .fill("训练过程");
    await page.getByRole("button", { name: "内容类型", exact: true }).click();
    await page
      .getByRole("option", { name: "实验记录", exact: true })
      .click();
    const history = (run: number) =>
      JSON.stringify({
        id: "source-run-" + run,
        name: "Run " + run,
        status: run === 1 ? "failed" : "finished",
        history: Array.from({ length: run === 1 ? 45 : 120 }, (_, step) => ({
          _step: step,
          "train/loss": 1 / (step + run),
          "train/accuracy": step / 200,
          "eval/psnr": 20 + step / 100,
          "eval/ssim": step / 250,
        })),
      });
    await page.getByRole("button", { name: "导入记录文件", exact: true }).click();
    await page.getByLabel("上传运行记录", { exact: true }).setInputFiles(
      [1, 2, 3].map((run) => ({
        name: "run-" + run + ".json",
        mimeType: "application/json",
        buffer: Buffer.from(history(run)),
      })),
    );
    await page.getByRole("button", { name: "读取记录", exact: true }).click();
    await expect(page.getByRole("cell", { name: /Run 3/ })).toBeVisible();
    await page.getByRole("button", { name: "保存内容块", exact: true }).click();
    await expect(page.getByRole("figure")).toHaveCount(4);
    await expect(page.locator('figure[data-series-count="3"]')).toHaveCount(4);
    const recordCard = page.locator(".content-block-card").filter({ has: page.getByRole("heading", { name: "训练过程", exact: true }) });
    await recordCard.getByRole("button", { name: "编辑内容块", exact: true }).click();
    await page.getByRole("textbox", { name: "内容块标题", exact: true }).fill("训练过程（修订）");
    await page.getByRole("button", { name: "保存内容块", exact: true }).click();
    await expect(page.getByRole("heading", { name: "训练过程（修订）", exact: true })).toBeVisible();
    await expect(page.getByRole("figure")).toHaveCount(4);
    await page.setViewportSize({ width: 1440, height: 1100 });
    const loss = page.getByRole("figure", { name: "train/loss", exact: true });
    await loss.scrollIntoViewIfNeeded();
    await expect(loss.locator("canvas")).toHaveCount(1);
    const chartBox = await loss
      .locator(".experiment-chart-surface")
      .boundingBox();
    await page.mouse.move(
      chartBox!.x + chartBox!.width * 0.55,
      chartBox!.y + chartBox!.height * 0.45,
    );
    await expect(loss.locator(".experiment-chart-tooltip")).toBeVisible();
    await expect
      .poll(async () => {
        const active = page.locator(".experiment-metric-chart:has(canvas)");
        return (
          (await active.count()) > 1 &&
          (await active.locator(".experiment-chart-tooltip").count()) ===
            (await active.count())
        );
      })
      .toBe(true);
    await page.getByRole("button", { name: "数据表", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "实验数据", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("columnheader")).toHaveCount(5);
    await expect(
      page.getByRole("cell", { name: "1", exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "曲线", exact: true }).click();

    await page.getByRole("button", { name: "添加内容块", exact: true }).click();
    await page
      .getByRole("textbox", { name: "内容块标题", exact: true })
      .fill("微调配置");
    await page.getByRole("button", { name: "内容类型", exact: true }).click();
    await page.getByRole("option", { name: "文件", exact: true }).click();
    await page.getByLabel("上传文件", { exact: true }).setInputFiles(
      [1, 2, 3].map((run) => ({
        name: "run-" + run + ".yaml",
        mimeType: "text/yaml",
        buffer: Buffer.from(`rank: 4\nbatch_size: ${run === 1 ? 32 : 16}\n`),
      })),
    );
    await page.getByRole("button", { name: "保存内容块", exact: true }).click();
    await expect(page.locator(".asset-text-preview")).toContainText(
      "batch_size: 32",
    );
    await page.getByRole("button", { name: "运行与材料", exact: true }).click();
    const run1 = page
      .locator(".experiment-run-item")
      .filter({ hasText: "Run 1" });
    await run1.getByRole("button", { name: "关联材料", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "材料中的具体项", exact: true })
      .click();
    await page.getByRole("option", { name: "run-1.yaml", exact: true }).click();
    await dialog.getByRole("button", { name: "关联", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(
      c.records.overview(experiment.id, actor).materialLinks[0].selection.kind,
    ).toBe("asset");

    const tableView = c.changes.direct(
      [
        {
          op: "addBlock",
          owner: { kind: "node", id: experiment.id },
          clientRef: "table",
          title: "运行配置表",
          type: "table",
          payload: {
            columns: [
              { key: "run", label: "Run" },
              { key: "batch", label: "Batch size" },
            ],
            rows: [
              { run: "Run 1", batch: 32 },
              { run: "Run 2", batch: 16 },
            ],
          },
        },
      ],
      actor,
    );
    const table = tableView.blocks.find(
      (block) => block.id === tableView.allocation["block:table"],
    );
    await page.reload();
    await page.getByRole("button", { name: "运行与材料", exact: true }).click();
    await page
      .locator(".experiment-run-item")
      .filter({ hasText: "Run 2" })
      .getByRole("button", { name: "关联材料", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "研究材料", exact: true }).click();
    await page.getByRole("option", { name: "运行配置表", exact: true }).click();
    await dialog
      .getByRole("button", { name: "材料中的具体项", exact: true })
      .click();
    await page
      .getByRole("option", { name: "表格中的一行", exact: true })
      .click();
    await dialog
      .getByRole("spinbutton", { name: "行号", exact: true })
      .fill("2");
    await dialog.getByRole("button", { name: "关联", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    c.changes.direct(
      [
        {
          op: "updateBlock",
          owner: { kind: "node", id: experiment.id },
          blockId: table.id,
          expectedRevision: 1,
          patch: {
            payload: {
              ...table.payload,
              rows: [
                { run: "Run 1", batch: 64 },
                { run: "Run 2", batch: 8 },
              ],
            },
          },
        },
      ],
      actor,
    );
    await page.reload();
    await page.getByRole("button", { name: "运行与材料", exact: true }).click();
    await page.getByRole("button", { name: "运行配置表", exact: true }).click();
    await expect(
      page.getByRole("dialog").getByRole("cell", { name: "16", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭 / Close", exact: true })
      .click();

    const workbook = Buffer.from(
      exportXlsxTable(
        {
          columns: [
            { key: "condition", label: "Condition" },
            { key: "batch", label: "Batch size" },
          ],
          rows: [
            { condition: "batch32", batch: 32 },
            { condition: "batch16", batch: 16 },
          ],
        },
        "Config",
      ),
    );
    const uploadedWorkbook = await c.assets.upload(
      Readable.from([workbook]),
      {
        originalName: "configs.xlsx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        idempotencyKey: "browser-workbook",
      },
      actor,
    );
    c.changes.direct(
      [
        {
          op: "addBlock",
          owner: { kind: "node", id: experiment.id },
          clientRef: "workbook",
          title: "上传配置表",
          type: "spreadsheet",
          payload: { format: "xlsx" },
          representations: [
            {
              kind: "asset",
              assetId: uploadedWorkbook.id,
              label: "configs.xlsx",
              role: "source",
            },
          ],
        },
      ],
      actor,
    );
    await page.reload();
    await page.getByRole("button", { name: "运行与材料", exact: true }).click();
    await page
      .locator(".experiment-run-item")
      .filter({ hasText: "Run 3" })
      .getByRole("button", { name: "关联材料", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "研究材料", exact: true }).click();
    await page.getByRole("option", { name: "上传配置表", exact: true }).click();
    await dialog
      .getByRole("button", { name: "材料中的具体项", exact: true })
      .click();
    await page
      .getByRole("option", { name: "文件表格行：configs.xlsx", exact: true })
      .click();
    await dialog
      .getByRole("spinbutton", { name: "文件中的行号", exact: true })
      .fill("3");
    await expect(
      dialog.getByRole("cell", { name: "16", exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "关联", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "上传配置表", exact: true }).click();
    await expect(
      page.getByRole("dialog").getByRole("cell", { name: "16", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭 / Close", exact: true })
      .click();

    const other = app.researchNodes.createNode(
      "experiment",
      { nodeName: "Rank 8 微调" },
      actor,
    ).node;
    const source = await c.assets.upload(
      Readable.from([
        Buffer.from(
          JSON.stringify({
            runs: Array.from({ length: 25 }, (_, index) =>
              JSON.parse(history(index + 4)),
            ),
          }),
        ),
      ]),
      {
        originalName: "baseline.json",
        mediaType: "application/json",
        idempotencyKey: "browser-baseline",
      },
      actor,
    );
    const imported = await c.records.inspect("wandb", [source.id], actor);
    c.changes.direct(
      [
        {
          op: "addBlock",
          owner: { kind: "node", id: other.id },
          clientRef: "record",
          title: "训练过程",
          type: "experimentRecord",
          payload: {
            provider: "wandb",
            runs: imported.runs.map((run) => ({
              sourceId: run.sourceId,
              label: run.label,
              status: run.status,
              assetIds: run.assetIds,
            })),
          },
          representations: [
            { kind: "asset", assetId: source.id, role: "source" },
          ],
        },
      ],
      actor,
    );
    const nodeCount = c.nodes.nodes().length,
      blockCount = c.store.all("blocks").length;
    await expect(page.getByRole("button", { name: /比较运行/ })).toHaveCount(0);
    await page.goto(app.url + "/#/topology");
    await page.getByRole("button", { name: "选择节点", exact: true }).click();
    await page
      .getByRole("checkbox", { name: "选择 Rank 4 微调", exact: true })
      .check();
    await page
      .getByRole("checkbox", { name: "选择 Rank 8 微调", exact: true })
      .check();
    await page
      .getByRole("button", { name: "进入比较（2）", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("figure")).toHaveCount(4);
    await expect(dialog.locator('figure[data-series-count="28"]')).toHaveCount(
      4,
    );
    await mkdir("runtime/self-review", { recursive: true });
    await page.screenshot({
      path: "runtime/self-review/experiment-record-comparison.png",
      fullPage: true,
    });
    await dialog
      .getByRole("button", { name: "关闭 / Close", exact: true })
      .click();
    expect(c.nodes.nodes().length).toBe(nodeCount);
    expect(c.store.all("blocks").length).toBe(blockCount);
    expect(c.store.all("candidates").length).toBe(0);
    await page.goto(
      app.url + "/#/topology/nodes/" + encodeURIComponent(experiment.id),
    );
    await page.screenshot({
      path: "runtime/self-review/experiment-record-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect((await page.locator(".sidebar").boundingBox())!.height).toBeLessThan(
      90,
    );
    await expect(page.getByRole("figure")).toHaveCount(4);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "runtime/self-review/experiment-record-mobile.png",
      fullPage: true,
    });
    page.once("dialog", dialog => dialog.accept());
    await page.locator(".content-block-card").filter({ has: page.getByRole("heading", { name: "训练过程（修订）", exact: true }) }).getByRole("button", { name: "删除内容块", exact: true }).click();
    await expect(page.getByRole("heading", { name: "训练过程（修订）", exact: true })).toHaveCount(0);
    await expect(page.getByRole("figure")).toHaveCount(0);
    expect(c.records.overview(experiment.id, actor).runs.every(run => run.records.length === 0)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    for (const runtime of app.runtimes.values()) {
      await runtime.agentSessionGateway.closeAll();
      await runtime.researchCommands.records.close();
      await runtime.researchCommands.assets.close();
      await runtime.agentMedia.close();
      await runtime.toolEnvironment.catalog.close();
      await runtime.toolEnvironment.research.close();
    }
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
