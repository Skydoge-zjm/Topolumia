import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startMvpServer } from "../../dist/src/server.js";
let app: any, root: string, project: any, humanToken: string, agentToken: string;
const password = "History-Browser-2026!";
async function request(method: string, route: string, body?: any, token = humanToken) {
  const response = await fetch(app.url + route, { method, headers: { "content-type": "application/json", "x-rw-session": token, "x-rw-project-id": project.id }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(await response.text()); return response.json();
}
test.beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "topolumia-history-browser-"));
  app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: { sourceRefresh: { enabled: false } } });
  const user = app.collaboration.bootstrapAdmin({ username: "history-browser", password });
  humanToken = app.collaboration.login("history-browser", password).token;
  project = app.collaboration.createProject({ id: "history-browser-project", name: "Research history browser" }, app.collaboration.actorForUser(user.id, app.config.project.id));
  const runtime = await app.getRuntime(project.id);
  agentToken = app.collaboration.issueAgentCredential(app.collaboration.actorForUser(user.id, project.id), project.id, "history-browser-agent", { researchSessionId: "history-browser-session" });
  runtime.state.recordEvent({ type: "agentMessage", actor: "agent", nodeIds: [], sourceRefs: [], payload: { text: "RAW_REPLY_MUST_NOT_BECOME_A_RESEARCH_EVENT" } }, { skipValidation: true });
});
test.afterAll(async () => {
  for (const runtime of app.runtimes.values()) { await runtime.agentSessionGateway.closeAll(); await runtime.toolEnvironment.catalog.close(); await runtime.toolEnvironment.research.close(); }
  await app.sshEnvironments.close(); await app.sshConnections.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 3 });
});
test.beforeEach(async ({ page }) => {
  await page.request.post(app.url + "/api/auth/login", { data: { username: "history-browser", password } });
  await page.addInitScript(({ id }) => localStorage.setItem("research-workbench-project", id), { id: project.id });
});
test("manual research creation enters the research history automatically with a readable snapshot", async ({ page }) => {
  await page.goto(app.url + "/#/topology/new?kind=experiment");
  await page.getByLabel("节点名称", { exact: true }).fill("人工建立的复现实验");
  await page.getByLabel("摘要", { exact: true }).fill("验证复现设置是否正确；固定评估器和随机种子。");
  await page.getByRole("button", { name: "保存核心信息", exact: true }).click();
  await expect(page.getByRole("heading", { name: "人工建立的复现实验", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "研究记录", exact: true }).click();
  await expect(page.getByRole("button", { name: "科研历程", exact: true })).toHaveClass(/is-active/);
  await expect(page.locator("main")).not.toContainText("RAW_REPLY_MUST_NOT_BECOME_A_RESEARCH_EVENT");
  const entry = page.locator(".research-history-entry").filter({ hasText: "人工建立的复现实验" });
  await expect(entry).toContainText("创建了科研节点"); await entry.click();
  await expect(page.getByRole("heading", { name: "创建了科研节点", exact: true })).toBeVisible();
  await expect(page.locator(".research-history-snapshot")).toContainText("固定评估器和随机种子");
  await expect(page.getByRole("link", { name: "查看当前对象", exact: true })).toBeVisible();
  await page.screenshot({ path: "runtime/research-history-created.png", fullPage: true });
});
test("Agent proposals and user rejection or acceptance retain their separate meanings", async ({ page }) => {
  const propose = async (label: string) => {
    const receipt = await request("POST", "/api/research/candidates", { reason: `Agent 提议：${label}`, idempotencyKey: label,
      nodes: [{ kind: "inference", core: { nodeName: label, summary: "需要研究者审阅的实验推论" } }] }, agentToken);
    return { id: receipt.data.candidateId };
  };
  const rejected = await propose("未通过的实验推论");
  await request("POST", `/api/research/candidates/${rejected.id}/review`, { decision: "reject", reason: "需要补做区分实验", expectedRevision: 1 });
  const rejectedEvent = (await request("GET", `/api/research-history?proposalId=${rejected.id}&outcome=rejected`)).items[0];
  await page.goto(app.url + "/#/records/history/" + rejectedEvent.id);
  await expect(page.getByRole("heading", { name: "拒绝了科研提议", exact: true })).toBeVisible();
  await expect(page.locator("main")).toContainText("需要补做区分实验");
  await expect(page.locator("main")).toContainText("本次事件没有将这些变更写入正式科研拓扑");
  await expect(page.getByRole("link", { name: "查看当前对象", exact: true })).toHaveCount(0);
  const accepted = await propose("确认后的实验推论");
  await request("POST", `/api/research/candidates/${accepted.id}/review`, { decision: "accept", reason: "已核对实验依据", expectedRevision: 1 });
  const acceptedEvent = (await request("GET", `/api/research-history?proposalId=${accepted.id}&outcome=applied`)).items[0];
  await page.goto(app.url + "/#/records/history/" + acceptedEvent.id);
  await expect(page.getByRole("heading", { name: "确认了科研提议", exact: true })).toBeVisible();
  await expect(page.locator("main")).toContainText("发起方"); await expect(page.locator("main")).toContainText("Agent");
  await expect(page.locator(".research-history-snapshot")).toContainText("确认后的实验推论");
  await expect(page.getByRole("heading", { name: "提议处理过程", exact: true })).toBeVisible();
  const graph = await request("GET", "/api/topology");
  expect(graph.nodes.some((node: any) => node.label.zh === "未通过的实验推论")).toBe(false);
  expect(graph.nodes.some((node: any) => node.label.zh === "确认后的实验推论")).toBe(true);
  await page.screenshot({ path: "runtime/research-history-reviewed.png", fullPage: true });
});
test("node deletion uses the real user flow and leaves a durable research snapshot", async ({ page }) => {
  const target = await request("POST", "/api/research-nodes", { kind: "experiment", core: { nodeName: "重复实验节点", summary: "删除后仍应可以查看这份历史实验说明。" } });
  const other = await request("POST", "/api/research-nodes", { kind: "question", core: { nodeName: "关联研究问题" } });
  await request("POST", "/api/research-relations", { from: { kind: "node", id: other.node.id }, to: { kind: "node", id: target.node.id }, type: "tested_by", label: "实验检验", expectedEndpointRevisions: Object.entries({ [other.node.id]: other.nodeRevision, [target.node.id]: target.nodeRevision }).map(([id, revision]) => ({ object: { kind: "node", id }, revision })) });
  const group = (await request("POST", "/api/research-groups", { core:{nodeName:"待清理实验"},members:[{nodeId:target.node.id}] })).group;
  await page.goto(app.url + "/#/topology/nodes/" + encodeURIComponent(target.node.id));
  await page.getByRole("button", { name: "删除节点", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("1 条相连关系");
  await dialog.getByLabel("删除原因", { exact: true }).fill("与正式实验重复，清理此节点");
  await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.getByRole("heading", { name: "删除了科研节点", exact: true })).toBeVisible();
  await expect(page.locator(".research-history-snapshot").filter({ hasText: "重复实验节点" })).toContainText("删除后仍应可以查看这份历史实验说明");
  expect((await request("GET", `/api/research-groups/${encodeURIComponent(group.id)}`)).counts.directNodes).toEqual(0);
  expect((await request("GET", "/api/topology")).nodes.some((node: any) => node.id === target.node.id)).toBe(false);
  await page.reload(); await expect(page.locator("main")).toContainText("与正式实验重复，清理此节点");
  await page.screenshot({ path: "runtime/research-history-deleted.png", fullPage: true });
});
