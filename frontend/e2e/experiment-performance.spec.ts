import { test, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../dist/src/server.js";

test("large archived records keep charts and raw-data rendering bounded", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-perf-browser-"));
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
    const password = "Synthetic-Performance-2026!";
    const user = app.collaboration.bootstrapAdmin({
      username: "perf-browser",
      password,
    });
    const actor = app.collaboration.actorForUser(
        user.id,
        app.config.project.id,
      ),
      c = app.researchCommands;
    const metrics = Array.from({ length: 12 }, (_, i) => "metric/" + i);
    const source = JSON.stringify({
      runs: Array.from({ length: 80 }, (_, run) => ({
        id: "source-" + run,
        name: "Run " + run,
        status: run === 0 ? "failed" : "finished",
        series: metrics.map((key, metric) => ({
          key,
          xKey: "step",
          points: Array.from({ length: 400 }, (_, step) => ({
            x: step * 12 + metric + run / 100,
            y: step === 0 ? 0.123456789012345 : Math.sin(step / 10) + run / 100,
          })),
        })),
      })),
    });
    const asset = await c.assets.upload(
      Readable.from([source]),
      {
        originalName: "synthetic.json",
        mediaType: "application/json",
        idempotencyKey: "synthetic",
      },
      actor,
    );
    const imported = await c.records.inspect("wandb", [asset.id], actor);
    const node = app.researchNodes.createNode(
      "experiment",
      { nodeName: "Large synthetic experiment" },
      actor,
    ).node;
    c.changes.direct(
      [
        {
          op: "addBlock",
          clientRef: "records",
          owner: { kind: "node", id: node.id },
          title: "Training records",
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
            { kind: "asset", assetId: asset.id, role: "source" },
          ],
        },
      ],
      actor,
    );
    await page.addInitScript(
      (project) =>
        window.localStorage.setItem("research-workbench-project", project),
      app.config.project.id,
    );
    await page.request.post(app.url + "/api/auth/login", {
      data: { username: "perf-browser", password },
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.addInitScript(() => {
      (window as any).__perfTasks = [];
      new PerformanceObserver((list) =>
        (window as any).__perfTasks.push(
          ...list.getEntries().map((entry) => entry.duration),
        ),
      ).observe({ type: "longtask", buffered: true });
    });
    const start = Date.now();
    await page.goto(
      app.url + "/#/topology/nodes/" + encodeURIComponent(node.id),
    );
    const figures = page.getByRole("figure");
    await expect(figures).toHaveCount(12);
    await expect(page.locator('figure[data-series-count="80"]')).toHaveCount(
      12,
    );
    const first = figures.first();
    await first.scrollIntoViewIfNeeded();
    await expect(first.locator("canvas")).toHaveCount(1);
    expect(await page.locator(".experiment-plots canvas").count()).toBeLessThan(
      12,
    );
    const openedMs = Date.now() - start;
    // Verify actual coloured paths on Canvas, not only chart wrapper elements.
    expect(
      await first.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
        const pixels = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let coloured = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (
            pixels[i + 3] &&
            Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) -
              Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) >
              80
          )
            coloured++;
        return coloured;
      }),
    ).toBeGreaterThan(200);
    const rangeBefore = await first
      .locator(".experiment-chart-surface")
      .getAttribute("data-x-range");
    await first.getByRole("button", { name: "放大曲线", exact: true }).click();
    await expect
      .poll(() =>
        first.locator(".experiment-chart-surface").getAttribute("data-x-range"),
      )
      .not.toBe(rangeBefore);
    const zoomed = await first
      .locator(".experiment-chart-surface")
      .getAttribute("data-x-range");
    await figures.last().scrollIntoViewIfNeeded();
    await expect(figures.last().locator("canvas")).toHaveCount(1);
    await expect(first.locator("canvas")).toHaveCount(0);
    await first.scrollIntoViewIfNeeded();
    await expect(first.locator("canvas")).toHaveCount(1);
    await expect(first.locator(".experiment-chart-surface")).toHaveAttribute(
      "data-x-range",
      zoomed!,
    );
    const box = await first.locator(".u-over").boundingBox();
    await page.mouse.move(
      box!.x + box!.width * 0.5,
      box!.y + box!.height * 0.5,
    );
    await expect(first.locator(".experiment-chart-tooltip")).toBeVisible();
    expect(
      await first.locator(".experiment-chart-tooltip span").count(),
    ).toBeLessThanOrEqual(13);
    const visibleCharts = await page
      .locator(".experiment-plots canvas")
      .count();
    const requests: any[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/experiments/table"))
        requests.push(request.postDataJSON());
    });
    await page.getByRole("button", { name: "实验数据", exact: true }).click();
    await expect(page.getByRole("columnheader")).toHaveCount(13);
    await expect(page.getByRole("table")).toHaveAttribute(
      "aria-rowcount",
      "1201",
    );
    expect(requests).toHaveLength(1);
    const rows = page.locator(".experiment-data-table tbody tr[aria-rowindex]");
    expect(await rows.count()).toBeLessThan(50);
    const heights = await rows.evaluateAll((rows) =>
      rows.map((row) => row.getBoundingClientRect().height),
    );
    expect(heights.every((height) => Math.abs(height - 27) < 1)).toBe(true);
    await page.locator(".experiment-data-table").evaluate((host) => {
      host.scrollTop = host.scrollHeight;
      host.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(rows.last()).toHaveAttribute("aria-rowindex", "1201");
    expect(await rows.count()).toBeLessThan(50);
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "复制表格", exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.split("\n")).toHaveLength(1201);
    expect(copied).toContain("0.123456789012345");
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].pointOffset).toBe(100);
    await expect(page.getByRole("columnheader")).toHaveCount(13);
    expect(errors).toEqual([]);
    await mkdir("runtime/self-review", { recursive: true });
    await writeFile(
      "runtime/self-review/experiment-browser-performance.json",
      JSON.stringify(
        {
          runs: 80,
          metrics: 12,
          points: 384000,
          openedMs,
          visibleCharts,
          rowsRendered: await rows.count(),
          longTasksMs: await page.evaluate(() => (window as any).__perfTasks),
        },
        null,
        2,
      ),
    );
    await page.screenshot({
      path: "runtime/self-review/experiment-performance-data.png",
      fullPage: true,
    });
  } finally {
    for (const runtime of app.runtimes.values()) {
      await runtime.agentSessionGateway.closeAll();
      await runtime.researchCommands.assets.close();
      await runtime.researchCommands.records.close();
      await runtime.agentMedia.close();
      await runtime.toolEnvironment.catalog.close();
      await runtime.toolEnvironment.research.close();
    }
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
