import { runtimeArtifact } from "./support/runtime-artifacts";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../dist/src/server.js";

test("imports MLflow records through the browser and reads durable curves and exact points without the peer", async ({ page }) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-mlflow-browser-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const experimentId = "41", nativeRunId = "native-mlflow-selected";
  const runLabel = "MLflow 完整历史记录", experimentName = "MLflow 隔离实验";
  const history = [
    { key: "train/loss", step: 0, value: 1.23456789012345, timestamp: 1_800_000_000_000 },
    { key: "train/loss", step: 1, value: 0.5, timestamp: 1_800_000_001_000 },
    { key: "train/loss", step: 1, value: 0.375, timestamp: 1_800_000_002_000 },
    { key: "train/loss", step: 0, value: 0.875, timestamp: 1_800_000_003_000 },
    { key: "train/loss", step: 2, value: 0.125, timestamp: 1_800_000_004_000 },
  ];
  const selectedRun = {
    info: { run_id: nativeRunId, experiment_id: experimentId, run_name: runLabel, status: "FINISHED" },
    data: {
      metrics: [history[4]],
      params: [{ key: "learning_rate", value: "0.0003" }],
      tags: [{ key: "purpose", value: "isolated browser integration" }],
    },
  };
  const unselectedRun = { ...selectedRun, info: { ...selectedRun.info, run_id: "native-mlflow-unselected", run_name: "不应导入的运行" } };
  const peerErrors: string[] = [], fetchedRuns: string[] = [], pageErrors: string[] = [];
  // Only the external MLflow REST peer is simulated. Topolumia's HTTP routes,
  // ingestion, SQLite storage, queries and built React application stay real.
  const peer = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://mlflow-peer");
      let payload: unknown;
      if (url.pathname === "/api/2.0/mlflow/experiments/search") {
        payload = { experiments: [{ experiment_id: experimentId, name: "Isolated MLflow records" }] };
      } else if (url.pathname === "/api/2.0/mlflow/runs/search" && request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk.toString("utf8");
        const input = JSON.parse(body) as { experiment_ids: string[] };
        if (JSON.stringify(input.experiment_ids) !== JSON.stringify([experimentId])) throw new Error("Unexpected MLflow experiment selection");
        payload = { runs: [selectedRun, unselectedRun] };
      } else if (url.pathname === "/api/2.0/mlflow/runs/get" && url.searchParams.get("run_id") === nativeRunId) {
        fetchedRuns.push(nativeRunId);
        payload = { run: selectedRun };
      } else if (url.pathname === "/api/2.0/mlflow/metrics/get-history" && url.searchParams.get("run_id") === nativeRunId && url.searchParams.get("metric_key") === "train/loss") {
        const cursor = url.searchParams.get("page_token");
        if (!cursor) payload = { metrics: history.slice(0, 3), next_page_token: "remaining-points" };
        else if (cursor === "remaining-points") payload = { metrics: history.slice(3) };
        else throw new Error("Unexpected MLflow metric cursor");
      } else if (url.pathname === "/api/2.0/mlflow/artifacts/list" && url.searchParams.get("run_id") === nativeRunId) {
        payload = { files: [] };
      } else throw new Error(`Unexpected MLflow request: ${request.method} ${url.pathname}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    })().catch((error: unknown) => {
      peerErrors.push(error instanceof Error ? error.message : String(error));
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error_code: "FIXTURE_REQUEST_INVALID" }));
    });
  });
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  const address = peer.address();
  if (!address || typeof address === "string") throw new Error("MLflow peer did not bind a local port");
  const peerUrl = `http://127.0.0.1:${address.port}`;
  let peerClosed = false;
  const closePeer = async () => {
    if (peerClosed) return;
    peer.closeAllConnections();
    await new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve()));
    peerClosed = true;
  };
  let app: Awaited<ReturnType<typeof startMvpServer>> | undefined;
  page.on("pageerror", error => pageErrors.push(error.message));
  try {
    app = await startMvpServer({
      port: 0, testMode: false,
      collaborationFile: path.join(root, "db.sqlite"),
      userSettingsFile: path.join(root, "settings.json"),
      config: {
        publicRoot: path.resolve("frontend/dist"),
        project: { root: workspace, workspacesRoot: path.join(root, "workspaces") },
        filesystem: { roots: [workspace] },
        sourceRefresh: { enabled: false }, curator: { enabled: false }, agentSessions: { profiles: [] },
      },
    });
    const username = "mlflow-browser", password = "Mlflow-Browser-Isolated-2026!";
    app.collaboration.bootstrapAdmin({ username, password });
    const headers = { "x-rw-project-id": app.config.project.id };
    const login = await page.request.post(app.url + "/api/auth/login", { data: { username, password } });
    expect(login.ok(), await login.text()).toBe(true);
    // Configure through the persistent tool settings service, including its
    // normal apply step, so later runtime resolution uses this isolated peer.
    const configured = await page.request.patch(app.url + "/api/tools-environment/tools/mlflow", {
      headers, data: { baseUrl: peerUrl, experimentId, experimentName: "Isolated MLflow records", tokenEnv: "TOPOLUMIA_E2E_MLFLOW_TOKEN" },
    });
    expect(configured.ok(), await configured.text()).toBe(true);
    await page.addInitScript(project => {
      localStorage.setItem("research-workbench-project", project);
      localStorage.setItem("topolumia-locale", "zh");
    }, app.config.project.id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(app.url + "/#/experiments?view=records");
    await page.getByRole("button", { name: "从 MLflow 导入", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "从 MLflow 导入", exact: true });
    await dialog.getByRole("checkbox", { name: runLabel, exact: true }).check();
    await expect(dialog.getByRole("checkbox", { name: "不应导入的运行", exact: true })).not.toBeChecked();
    const screenshots = runtimeArtifact("self-review/backend-types");
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, "mlflow-import-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog.getByRole("button", { name: "导入所选运行 (1)", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "mlflow-import-narrow.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const importedResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/research/experiments/mlflow/import" && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "导入所选运行 (1)", exact: true }).click();
    const imported = await importedResponse;
    expect(imported.status(), await imported.text()).toBe(201);
    expect(imported.request().postDataJSON()).toEqual({ runIds: [nativeRunId] });
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: runLabel, exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "不应导入的运行", exact: true })).toHaveCount(0);
    expect(fetchedRuns).toEqual([nativeRunId]);
    expect(peerErrors).toEqual([]);
    await closePeer();

    await page.getByRole("checkbox", { name: runLabel, exact: true }).check();
    await page.getByRole("button", { name: "加入实验 (1)", exact: true }).click();
    const assign = page.getByRole("dialog", { name: "将训练记录加入实验", exact: true });
    await assign.getByRole("textbox", { name: "实验名称", exact: true }).fill(experimentName);
    await assign.getByRole("button", { name: "确认加入", exact: true }).click();
    await expect(page.getByRole("heading", { name: experimentName, exact: true })).toBeVisible();
    const loss = page.getByRole("figure", { name: "train/loss", exact: true });
    await loss.scrollIntoViewIfNeeded();
    await expect(loss.getByRole("img", { name: "train/loss · 1 次运行", exact: true })).toBeVisible();
    await expect(loss.locator("canvas")).toHaveCount(1);
    await expect(loss.getByRole("button", { name: "放大曲线", exact: true })).toBeEnabled();
    const expectExactPoints = async () => {
      await page.getByRole("button", { name: "数据表", exact: true }).click();
      const data = page.getByRole("region", { name: "实验数据", exact: true });
      await expect(data.getByRole("columnheader")).toHaveText(["step", "train/loss"]);
      const rows = data.getByRole("row").filter({ has: page.getByRole("cell") });
      await expect(rows).toHaveCount(5);
      const expected = [
        ["0", "1.23456789012345"], ["1", "0.5"], ["1", "0.375"], ["0", "0.875"], ["2", "0.125"],
      ];
      for (const [index, values] of expected.entries()) await expect(rows.nth(index).getByRole("cell")).toHaveText(values);
    };
    await expectExactPoints();
    // A fresh browser load must read the imported project records even though
    // MLflow is now unavailable; native duplicate and reset steps stay intact.
    await page.reload();
    await loss.scrollIntoViewIfNeeded();
    await expect(loss.locator("canvas")).toHaveCount(1);
    await expectExactPoints();
    expect(pageErrors).toEqual([]);
  } finally {
    try { await app?.close(); }
    finally {
      await closePeer();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});
