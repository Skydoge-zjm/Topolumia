import { runtimeArtifact } from "./support/runtime-artifacts";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../dist/src/server.js";

let app;
let root: string;
const password = "Agent-Audit-Only-2026!";
test.beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "topolumia-agent-browser-"));
  app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"),
    config: { sourceRefresh: { enabled: false }, agentSessions: { profiles: [{ id: "audit-fixture", label: "Audit Agent", provider: "fixture", driver: "acp-stdio", command: process.execPath,
      args: [path.resolve("dist/fixtures/acp/research-agent.js")] }, {
      id: "motion-fixture", label: "Motion Agent", provider: "fixture", driver: "acp-stdio", command: process.execPath,
      args: [path.resolve("dist/fixtures/acp/research-agent.js")], env: { RESEARCH_FIXTURE_PAUSE_MS: "700" },
    }] } } });
  await fetch(`${app.url}/api/auth/bootstrap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "audit", displayName: "Audit Researcher", password }) });
});
test.afterAll(async () => {
  await app.agentSessionGateway.closeAll();
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
test.beforeEach(async ({ page }) => {
  const response = await page.request.post(`${app.url}/api/auth/login`, { data: { username: "audit", password } });
  expect(response.ok()).toBe(true);
  await page.goto(`${app.url}/#/agents`);
});

test("Agent UI creates, streams, approves, cancels, closes and continues a session", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("button", { name: "新建会话" }).click();
  await page.getByRole("textbox", { name: "会话标题" }).fill("Browser audit session");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Browser audit session" })).toBeVisible();
  const input = page.getByRole("textbox", { name: "研究消息" });
  await input.fill("审批 command"); await input.press("Enter");
  await page.getByRole("button", { name: "允许本次" }).click();
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await expect(page.locator(".message-body").filter({ hasText: "现阶段只能记录" })).toBeVisible();
  await input.fill("slow inspect"); await input.press("Enter");
  await page.getByRole("button", { name: "停止 Agent" }).click();
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await page.getByRole("button", { name: "更多会话操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "结束运行 · 保留历史", exact: true }).click();
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "closed");
  await page.reload();
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "closed");
  await page.getByRole("button", { name: "继续会话" }).click();
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await input.fill("Inspect again"); await input.press("Enter");
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await expect(page.locator(".message-body").filter({ hasText: "现阶段只能记录" })).toHaveCount(2);
  await expect(page.locator(".message-body").filter({ hasText: "现阶段只能记录" }).last()).toBeVisible();
  await expect(page.locator(".message.user")).toHaveCount(3);
  await expect(page.locator(".session-list .session").filter({ hasText: "Browser audit session" })).toHaveCount(1);
  await page.screenshot({ path: "test-results/agent-workflow-audit.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("candidate review shows the proposed operations and applies the current revision", async ({ page }) => {
  const response = await page.request.post(`${app.url}/api/research/candidates`, { data: {
    reason: "Browser candidate review", nodes: [{ kind: "note", core: { nodeName: "Reviewed question", summary: "Reviewable candidate" } }],
  } });
  expect(response.ok()).toBe(true);
  const receipt = (await response.json()).data;
  await page.goto(`${app.url}/#/agents?candidate=${encodeURIComponent(receipt.candidateId)}`);
  const card = page.locator(".research-candidate").filter({ hasText: "Browser candidate review" });
  await expect(card).toContainText("Reviewable candidate");
  await card.getByRole("button", { name: "接受并保存", exact: true }).click();
  await expect(card.getByRole("link", { name: "查看已保存对象 · Reviewed question", exact: true })).toBeVisible();
  const topology = await (await page.request.get(`${app.url}/api/topology`)).json();
  expect(topology.nodes.some(node => node.id === receipt.nodes[0].nodeId)).toBe(true);
});

test("composer switches between stop and queue, persists pending messages and shows running activity", async ({ page }) => {
  const created = await page.request.post(`${app.url}/api/agent-sessions`, { data: { profileId: "audit-fixture", title: "Composer queue audit" } });
  expect(created.ok()).toBe(true);
  const session = await created.json();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Composer queue audit" })).toBeVisible();
  const input = page.getByRole("textbox", { name: "研究消息" });
  await input.fill("审批 command"); await input.press("Enter");
  const pendingApproval = page.locator(".agent-approval.is-pending");
  await expect(pendingApproval).toBeVisible();
  const stop = page.getByRole("button", { name: "停止 Agent", exact: true });
  await expect(stop).toBeVisible();
  await expect(stop).toBeEnabled();

  for (const text of ["Queued second question", "Queued third question"]) {
    await input.fill(text);
    await page.getByRole("button", { name: "排队发送", exact: true }).click();
    await expect(input).toHaveValue("");
  }
  const queue = page.getByRole("region", { name: "待发送消息" });
  await expect(queue).toContainText("2 条待发送");
  await expect(page.locator(".message.user")).toHaveCount(1);
  await page.screenshot({ path: runtimeArtifact("tools-preview/agent-composer-queue-verified.png"), fullPage: true });
  await page.reload();
  await expect(queue).toContainText("2 条待发送");
  await page.getByRole("button", { name: "允许本次", exact: true }).click();
  await expect(page.locator(".message.user")).toHaveCount(3);
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await expect(queue).toHaveCount(0);
  const detail = await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json();
  expect(detail.turns.map(turn => turn.input.find(part => part.type === "text")?.text)).toEqual(["审批 command", "Queued second question", "Queued third question"]);
  await expect(page.locator(".message:not(.user) > header").filter({ hasText: "Audit Agent" })).toHaveCount(0);

  await input.fill("审批 command again"); await input.press("Enter");
  await expect(pendingApproval).toBeVisible();
  for (const text of ["Retain after stop", "Remove pending message"]) {
    await input.fill(text); await page.getByRole("button", { name: "排队发送", exact: true }).click();
    await expect(input).toHaveValue("");
  }
  await page.getByRole("button", { name: "展开队列" }).click();
  await page.getByRole("button", { name: "移除待发送消息 2" }).click();
  await expect(queue.locator("li")).toHaveCount(1);
  await stop.click();
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await expect(queue).toContainText("已暂停");
  await expect(queue).toContainText("Retain after stop");
  await page.getByRole("button", { name: "继续队列", exact: true }).click();
  await expect(page.locator(".message.user")).toHaveCount(5);
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await expect(queue).toHaveCount(0);
  await expect(page.locator(".message.user").filter({ hasText: "Remove pending message" })).toHaveCount(0);
});

test("motion follows real work, keeps a single presence indicator and does not replay messages on refresh", async ({ page }) => {
  test.setTimeout(60_000);
  const created = await page.request.post(`${app.url}/api/agent-sessions`, { data: { profileId: "motion-fixture", title: "Production motion audit" } });
  expect(created.ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Production motion audit" })).toBeVisible();
  await page.evaluate(() => {
    const audit = window as typeof window & { agentMotionAudit?: Array<{ key: string; role: string }> };
    audit.agentMotionAudit = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      const node = this as HTMLElement;
      if (node.dataset.motionRole) audit.agentMotionAudit!.push({ key: node.dataset.motionKey!, role: node.dataset.motionRole });
      return animate.call(this, frames, options);
    };
  });
  const input = page.getByRole("textbox", { name: "研究消息" });
  await input.fill("slow motion inspect"); await input.press("Enter");
  const active = page.locator("[data-motion-active='true']");
  await expect(active).toHaveCount(1);
  const context = page.getByRole("button", { name: "上下文", exact: true });
  await context.click(); await page.getByRole("button", { name: "关闭研究上下文" }).click(); await context.click();
  await expect(page.getByRole("complementary", { name: "研究上下文" })).toBeVisible();
  await page.getByRole("button", { name: "关闭研究上下文" }).click();
  await expect(page.locator(".research-drawer")).toHaveCount(0);
  await expect(context).toBeFocused();
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await expect(active).toHaveCount(0);
  const counts = () => page.evaluate(() => (window as typeof window & { agentMotionAudit: Array<{ key: string; role: string }> }).agentMotionAudit);
  const initial = await counts();
  expect(initial.filter(item => item.role === "user")).toHaveLength(1);
  expect(initial.filter(item => item.role === "assistant")).toHaveLength(1);
  await page.getByRole("button", { name: "更多会话操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "刷新记录", exact: true }).click();
  expect(await counts()).toEqual(initial);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await input.fill("slow reduced motion inspect"); await input.press("Enter");
  await expect(page.locator(".conversation-body")).toHaveAttribute("data-motion-enabled", "true");
  await expect.poll(() => page.locator(".conversation-body").evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations === Infinity).length)).toBe(0);
  await context.click();
  await page.getByRole("button", { name: "停止 Agent", exact: true }).click();
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await expect(page.locator(".conversation-body")).toHaveAttribute("data-motion-enabled", "false");
  await page.getByRole("button", { name: "关闭研究上下文" }).click();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.screenshot({ path: runtimeArtifact("tools-preview/agent-motion-production-verified.png"), fullPage: true });
});

test("research workspace navigation and topology controls work", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const created = await page.request.post(`${app.url}/api/research-nodes`, { data: { kind: "experiment", core: { nodeName: "Browser experiment" } } });
  expect(created.ok()).toBe(true);
  await page.getByRole("link", { name: "研究总览" }).click();
  await expect(page.getByRole("heading", { name: "研究总览" })).toBeVisible();
  await page.getByRole("link", { name: "科研拓扑" }).click();
  await expect(page.getByRole("heading", { name: "科研拓扑" })).toBeVisible();
  const cards = page.locator(".research-graph-node-main");
  await expect(cards.first()).toBeVisible();
  await page.getByRole("button", { name: "适配视图", exact: true }).click();
  await cards.filter({ hasText: "Browser experiment" }).click();
  await expect(page.getByRole("heading", { name: "Browser experiment", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "科研拓扑", exact: true }).click();
  const search = page.getByRole("textbox", { name: "搜索科研对象", exact: true });
  await search.fill("no-such-topology-node-93842");
  await expect(cards).toHaveCount(0);
  await search.clear();
  await expect(cards.first()).toBeVisible();
  for (const [link, heading] of [["研究记录", "研究记录"], ["实验与复核", "实验"], ["工作区设置", "工作区设置"]]) {
    await page.getByRole("link", { name: link, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});
