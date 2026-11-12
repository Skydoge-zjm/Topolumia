import { runtimeArtifact } from "./support/runtime-artifacts";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../dist/src/server.js";

test("optional record blocks update an existing chart and preserve fixed data snapshots", async ({
  page,
}) => {
  test.setTimeout(60000);
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-live-browser-"));
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
    const password = "Synthetic-Live-2026!",
      user = app.collaboration.bootstrapAdmin({
        username: "live-browser",
        password,
      });
    const actor = app.collaboration.actorForUser(
        user.id,
        app.config.project.id,
      ),
      c = app.researchCommands;
    const created = c.changes.direct(
      [
        {
          op: "addNode",
          kind: "experiment",
          clientRef: "node",
          core: { nodeName: "Results only" },
        },
        {
          op: "addBlock",
          clientRef: "table",
          owner: { kind: "node", id: "@node" },
          title: "Final scores",
          type: "table",
          payload: {
            columns: [{ key: "score", label: "Score" }],
            rows: [{ score: 0.9 }],
          },
        },
      ],
      actor,
    );
    const nodeId = created.allocation["node:node"],
      owner = { kind: "node", id: nodeId };
    await page.addInitScript(
      (project) => localStorage.setItem("research-workbench-project", project),
      app.config.project.id,
    );
    await page.request.post(app.url + "/api/auth/login", {
      data: { username: "live-browser", password },
    });
    await page.goto(
      app.url + "/#/topology/nodes/" + encodeURIComponent(nodeId),
    );
    await expect(
      page.getByRole("cell", { name: "0.9", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "记录工作区", exact: true }),
    ).toHaveCount(0);
    const records = c.changes.direct(
      [
        {
          op: "addBlock",
          owner,
          clientRef: "one",
          title: "Live records",
          type: "experimentRecord",
          payload: { provider: "wandb", runs: [] },
        },
        {
          op: "addBlock",
          owner,
          clientRef: "two",
          title: "Other records",
          type: "experimentRecord",
          payload: { provider: "tensorboard", runs: [] },
        },
      ],
      actor,
    );
    const blockId = records.allocation["block:one"];
    await page.reload();
    const card = page.locator(".content-block-card").filter({
      has: page.getByRole("heading", { name: "Live records", exact: true }),
    });
    await expect(card.getByText("等待实验记录", { exact: true })).toBeVisible();
    const batch = (offset: number) => ({
      version: 1,
      provider: "wandb",
      streamId: "native",
      writerId: "writer",
      generation: "1",
      events: [0, 1].flatMap((run) =>
        Array.from({ length: 20 }, (_, i) => ({
          seq: offset * 40 + run * 20 + i,
          sourceRunId: "Run " + run,
          kind: "scalar",
          key: "loss",
          xKey: "step",
          x: offset * 20 + i,
          value: (run + 1) / (offset * 20 + i + 1),
        })),
      ),
    });
    c.ingestion.receive(blockId, batch(0), actor);
    const figure = card.getByRole("figure", { name: "loss", exact: true });
    await expect(figure).toBeVisible({ timeout: 10000 });
    await figure.scrollIntoViewIfNeeded();
    await expect(figure.locator("canvas")).toHaveCount(1);
    await figure.getByRole("button", { name: "放大曲线", exact: true }).click();
    const surface = figure.locator(".experiment-chart-surface"),
      range = await surface.getAttribute("data-x-range");
    await figure.locator("canvas").evaluate((canvas) => {
      (window as any).__liveCanvas = canvas;
    });
    await card.getByRole("button", { name: "Run 0", exact: true }).click();
    // Legend changes alter the structure once; subsequent data changes retain this instance.
    await expect(figure).toHaveAttribute("data-series-count", "1");
    await figure.locator("canvas").evaluate((canvas) => {
      (window as any).__liveCanvas = canvas;
    });
    const nextPlot = page.waitForResponse(
      (response) =>
        response.url().includes("/experiments/plot") &&
        response.request().postDataJSON().blockId === blockId,
    );
    c.ingestion.receive(blockId, batch(1), actor);
    const grown = await (await nextPlot).json();
    expect(grown.series.every((line: any) => line.pointCount === 40)).toBe(
      true,
    );
    await expect
      .poll(() =>
        card
          .getByRole("button", { name: "Run 0", exact: true })
          .getAttribute("aria-pressed"),
      )
      .toBe("false");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).__liveCanvas ===
            document.querySelector(".content-block-card canvas"),
        ),
      )
      .toBe(true);
    await expect(surface).toHaveAttribute("data-x-range", range!);
    await expect(
      page
        .locator(".content-block-card")
        .filter({
          has: page.getByRole("heading", {
            name: "Other records",
            exact: true,
          }),
        })
        .getByText("等待实验记录", { exact: true }),
    ).toBeVisible();
    await card.getByRole("button", { name: "数据表", exact: true }).click();
    await expect(
      card.getByRole("columnheader", { name: "loss", exact: true }),
    ).toBeVisible();
    const snapshotCount = c.ingestion.status(blockId, actor).snapshots.length;
    c.ingestion.receive(blockId, batch(2), actor);
    await expect.poll(() => c.ingestion.status(blockId, actor).snapshots.length).toBe(snapshotCount);
    await expect(card.getByText("60 点 / 指标（最多）", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "曲线", exact: true }).click();
    await expect(
      card.getByRole("button", { name: "Run 0", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(card.getByRole("button", { name: "数据接入", exact: true })).toHaveCount(0);
    const source = c.projectRecords.configure({ hostId: "local", hostLabel: "Synthetic host", provider: "wandb", directory: root }, actor);
    c.ingestion.receive(source.id, { ...batch(0), events: batch(0).events.slice(0, 20).map(event => ({ ...event, sourceRunId: "Discovered retry" })) }, actor);
    c.projectRecords.save({ ...source, enabled: false });
    await card.getByRole("button", { name: "添加运行", exact: true }).click();
    const picker = page.getByRole("dialog");
    await picker.getByRole("checkbox", { name: "Discovered retry", exact: true }).check();
    await picker.getByRole("button", { name: "添加所选运行 (1)", exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Discovered retry", exact: true })).toBeVisible();
    await card.getByRole("button", { name: "固定当前版本", exact: true }).click();
    await expect(card.getByRole("button", { name: "读取最新数据", exact: true })).toBeVisible();
    await card.screenshot({ path: runtimeArtifact("self-review/managed-record-workspace.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await card.screenshot({ path: runtimeArtifact("self-review/managed-record-mobile.png") });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    const snapshotId = c.ingestion.snapshot(blockId, actor).id;
    const note = c.changes.direct(
      [
        {
          op: "addNode",
          clientRef: "analysis",
          kind: "note",
          core: { nodeName: "Snapshot analysis" },
        },
        {
          op: "addBlock",
          owner: { kind: "node", id: "@analysis" },
          clientRef: "body",
          title: "Analysis",
          type: "richText",
          role: "body",
          payload: {
            format: "markdown",
            body: "Analysis based on fixed records.",
          },
          sourceRefs: [{ kind: "experimentSnapshot", value: snapshotId }],
        },
      ],
      actor,
    );
    await page.goto(
      app.url +
        "/#/topology/nodes/" +
        encodeURIComponent(note.allocation["node:analysis"]),
    );
    await page.getByRole("button", { name: "查看快照", exact: true }).click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("columnheader", { name: "loss", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭 / Close", exact: true })
      .click();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
