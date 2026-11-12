import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../dist/src/server.js";

let app: any, root: string, question: string, hypothesis: string, experiment: string;
const password = "Research-Overview-2026!";
test.beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "topolumia-overview-"));
  app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: { project: { workspacesRoot: path.join(root, "workspaces") }, sourceRefresh: { enabled: false }, curator: { enabled: false }, agentSessions: { profiles: [] } } });
  const user = app.collaboration.bootstrapAdmin({ username: "overview", password });
  const actor = app.collaboration.actorForUser(user.id, app.config.project.id);
  const runtime = app.runtimes.get(app.config.project.id);
  const make = (kind: string, name: string) => app.researchNodes.createNode(kind, { nodeName: name }, actor).node.id;
  question = make("note", "Does conditioning reduce distortion?");
  hypothesis = make("note", "Conditioning is the main effect");
  make("note", "Seed variance explains the gain");
  experiment = make("experiment", "Ablation G1");
  make("paper", "Unlinked survey");
  runtime.records.save({ type: "meeting", title: "Weekly sync", status: "draft", timezone: "UTC", occurredAt: "2026-10-01T09:00:00Z", body: "Notes",
    actions: [{ text: "Rerun G1 with three seeds", assignee: "Lin", dueDate: "2026-10-10", status: "open" }] }, actor);
});
test.afterAll(async () => {
  for (const runtime of app.runtimes.values()) { await runtime.agentSessionGateway.closeAll(); await runtime.researchCommands.assets.close(); await runtime.agentMedia.close(); await runtime.toolEnvironment.catalog.close(); await runtime.toolEnvironment.research.close(); }
  await app.sshEnvironments.close(); await app.sshConnections.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

test("signed-out visitors land on the entry page and reach the overview after signing in", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(app.url + "/#/overview");
  await expect(page.getByRole("heading", { name: "登录研究工作台" })).toBeVisible();
  await page.getByRole("link", { name: "首页" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /论证/ })).toBeVisible();
  await page.getByRole("link", { name: /登录研究工作台/ }).click();
  await page.getByLabel("用户名").fill("overview");
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible({ timeout: 10_000 });
  for (const [from, to, type] of [[experiment, hypothesis, "tested_by"], [question, hypothesis, "informs"]]) {
    const { nodes } = await (await page.request.get(app.url + "/api/topology")).json();
    const revision = (id: string) => Number(nodes.find((node: any) => node.id === id)?.data?.researchRevision ?? 1);
    const response = await page.request.post(app.url + "/api/research-relations", { data: { from: { kind: "node", id: from }, to: { kind: "node", id: to }, type,
      expectedEndpointRevisions: [from, to].map(id => ({ object: { kind: "node", id }, revision: revision(id) })) } });
    expect(response.ok(), await response.text()).toBe(true);
  }

  await page.goto(app.url + "/#/overview");
  await expect(page.getByRole("heading", { name: "研究总览" })).toBeVisible();
  const structure = page.getByRole("region", { name: "研究结构" });
  await expect(structure.getByText("科研对象").locator("..")).toContainText("5");
  await expect(structure.getByText("科研关系").locator("..")).toContainText("2");
  const argument = page.getByRole("region", { name: "对象关联" });
  await expect(argument.getByRole("meter", { name: "已关联的实验", exact: true })).toHaveAttribute("aria-valuenow", "1");
  await expect(argument.getByRole("meter", { name: "已关联的实验", exact: true })).toHaveAttribute("aria-valuemax", "1");
  await expect(argument.getByRole("meter", { name: "已关联的笔记", exact: true })).toHaveAttribute("aria-valuenow", "2");
  await expect(argument.getByRole("meter", { name: "已关联的笔记", exact: true })).toHaveAttribute("aria-valuemax", "3");
  await expect(argument.getByRole("link", { name: "Unlinked survey" })).toBeVisible();
  await expect(page.getByRole("region", { name: "研究笔记" }).getByRole("link", { name: "Does conditioning reduce distortion?" })).toBeVisible();
  await expect(page.getByRole("region", { name: "待办行动" }).getByRole("link", { name: "Rerun G1 with three seeds" })).toBeVisible();
  await expect(page.getByRole("link", { name: /逾期行动/ })).toContainText("1");
  await expect(page.getByRole("region", { name: "最近科研活动" }).locator(".research-history-entry").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("overview.png"), fullPage: true });
  expect(errors).toEqual([]);
});
