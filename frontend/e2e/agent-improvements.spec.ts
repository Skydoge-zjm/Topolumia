import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startMvpServer } from "../../dist/src/server.js";

let app, root: string;
const password = "Workbench-Fixture-Only-2026!";
test.beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "topolumia-workbench-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  await writeFile(path.join(workspace, "README.md"), "# Control protocol\n\nScientific evidence must retain its source version and exact character range.\n", "utf8");
  app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"),
    config: { project: { root: workspace, name: "Workbench UI verification" }, sourceRefresh: { enabled: false }, agentSessions: { profiles: [{
      id: "workbench-claude", label: "Claude Code", provider: "claude", driver: "claude-cli-stream", command: process.execPath,
      launcherArgs: [path.resolve("dist/fixtures/native/claude-cli.js")], model: "gpt-6-luna", models: [{ id: "gpt-6-luna", label: "Luna" }],
    }] } } });
  await writeFile(path.join(app.config.project.root, "README.md"), "# Control protocol\n\nScientific evidence must retain its source version and exact character range.\n", "utf8");
  await fetch(`${app.url}/api/auth/bootstrap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "workbench", displayName: "Workbench Tester", password }) });
});
test.afterAll(async () => { await app.agentSessionGateway.closeAll(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
test.beforeEach(async ({ page }) => { await page.request.post(`${app.url}/api/auth/login`, { data: { username: "workbench", password } }); await page.request.post(`${app.url}/api/sync`, { data: {} }); });
async function create(page, title: string) {
  const response = await page.request.post(`${app.url}/api/agent-sessions`, { data: { profileId: "workbench-claude", title } }); expect(response.ok()).toBe(true);
  const session = await response.json(); await page.goto(`${app.url}/#/agents`);
  await page.locator(".session").filter({ hasText: title }).click(); await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible(); return session;
}
async function send(page, text: string) { const input = page.getByRole("textbox", { name: "研究消息" }); await input.fill(text); await input.press("Enter"); await expect(page.getByText("正在发送，可继续输入", { exact: true })).toHaveCount(0); }
async function done(page) { await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready"); }

test("compact layout, focus mode, account-scoped drafts and narrow-window conversation access", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await create(page, "Draft one"); await create(page, "Draft two");
  await page.locator(".session").filter({ hasText: "Draft one" }).click();
  const input = page.getByRole("textbox", { name: "研究消息" }); await input.fill("Persistent first draft");
  expect(await page.locator(".conversation-scroll").evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(400);
  expect(await input.evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(64);
  await page.reload(); await expect(input).toHaveValue("Persistent first draft");
  await page.locator(".session").filter({ hasText: "Draft two" }).click(); await expect(input).toHaveValue(""); await input.fill("Second draft");
  await page.locator(".session").filter({ hasText: "Draft one" }).click(); await expect(input).toHaveValue("Persistent first draft");
  const width = await page.locator(".conversation-scroll").evaluate(node => node.clientWidth);
  await page.getByRole("button", { name: "专注会话", exact: true }).click();
  expect(await page.locator(".conversation-scroll").evaluate(node => node.clientWidth)).toBeGreaterThan(width + 200);
  await expect(page.getByRole("button", { name: "新建会话", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "退出专注模式", exact: true }).click();
  await page.setViewportSize({ width: 900, height: 720 });
  await page.getByRole("button", { name: "展开会话列表", exact: true }).click();
  await expect(page.locator(".session-rail.is-floating")).toBeVisible();
  await page.locator(".session").filter({ hasText: "Draft two" }).click(); await expect(input).toHaveValue("Second draft");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".conversation-scroll")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "test-results/agent-workbench-narrow.png", fullPage: true });
});

test("reading anchors survive session switches and refresh; search returns to the original message", async ({ page }) => {
  test.setTimeout(60_000);
  const session = await create(page, "Reading anchors");
  for (const [index, text] of ["long-stream anchor one", "long-stream anchor two"].entries()) { await send(page, text); await expect.poll(async () => (await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json()).turns.filter(turn => turn.status === "completed").length).toBe(index + 1); await done(page); }
  const scroll = page.locator(".conversation-scroll"); await scroll.hover(); await page.mouse.wheel(0, -100000);
  await expect(page.locator(".message.user").getByText("long-stream anchor one", { exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: /回到最新/ })).toBeVisible();
  const top = await scroll.evaluate(node => node.scrollTop);
  await create(page, "Other reading session"); await page.locator(".session").filter({ hasText: "Reading anchors" }).click();
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeCloseTo(top, 0);
  await page.reload(); await expect(page.getByRole("heading", { name: "Reading anchors" })).toBeVisible();
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeCloseTo(top, 0);
  await page.getByRole("button", { name: "搜索当前会话" }).click();
  await page.getByRole("textbox", { name: "会话内搜索" }).fill("anchor two"); await page.getByRole("button", { name: "下一项匹配" }).click();
  await expect(page.locator(".message.user").getByText("long-stream anchor two", { exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "关闭搜索" }).click();
  await page.getByRole("textbox", { name: "搜索会话" }).fill("anchor one"); await page.getByRole("button", { name: "搜索消息全文" }).click();
  await page.locator(".session-search-result").filter({ hasText: "anchor one" }).click();
  await expect(page.locator(".message.user").getByText("long-stream anchor one", { exact: true })).toBeInViewport();
  const response = await page.request.post(`${app.url}/api/agent-sessions/${session.id}/turns`, { data: { text: "approval-check" } }); expect(response.ok()).toBe(true);
  await page.getByRole("button", { name: "等待 1 项操作授权 · 查看" }).click();
  await expect(page.locator(".agent-approval.is-pending > header")).toBeInViewport();
  await page.locator(".agent-approval.is-pending").getByRole("button", { name: "拒绝本次" }).click(); await done(page);
});

test("queued edits retain FIFO and model; native session grants can be reset in place", async ({ page }) => {
  const session = await create(page, "Queue and permissions"); await send(page, "approval-check");
  const card = page.locator(".agent-approval.is-pending"); await expect(card).toBeVisible();
  await send(page, "Queued second"); await send(page, "Queued third");
  const queue = page.getByRole("region", { name: "待发送消息" }); await expect(queue).toContainText("2 条待发送");
  await page.getByRole("button", { name: "编辑待发送消息 1" }).click();
  await page.getByRole("textbox", { name: "编辑待发送消息", exact: true }).fill("Revised queued second");
  await queue.getByRole("button", { name: "保存", exact: true }).click(); await expect(queue).toContainText("Revised queued second");
  await page.reload(); await expect(queue).toContainText("Revised queued second"); await page.getByRole("button", { name: "展开队列" }).click();
  await page.getByRole("button", { name: "移除待发送消息 2" }).click();
  await card.getByRole("button", { name: "允许本次", exact: true }).click();
  await expect(page.locator(".message.user")).toHaveCount(2); await done(page);
  const detail = await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json();
  expect(detail.turns[1].input[0].text).toBe("Revised queued second"); expect(detail.turns[1].model).toBe("gpt-6-luna");
  await send(page, "approval-edits"); await card.getByRole("button", { name: "本会话自动允许编辑" }).click(); await done(page);
  await page.getByRole("button", { name: "已允许会话编辑" }).click();
  const before = await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json();
  await page.getByRole("button", { name: "重置会话授权" }).click(); await done(page);
  const after = await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json();
  expect(after.id).toBe(session.id); expect(after.runtimeInstanceId).not.toBe(before.runtimeInstanceId); expect(after.permissionGrants).toEqual([]); expect(after.turns).toHaveLength(3);
  await expect(page.getByRole("button", { name: "已允许会话编辑" })).toHaveCount(0);
});

test("scientific replies expose real source evidence, copyable code and reviewable full research notes", async ({ page, context }) => {
  test.setTimeout(60_000); await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await create(page, "Scientific record"); await send(page, "scientific-note");
  const answer = page.locator(".message:not(.user)"); await expect(answer).toContainText("实验结果记录"); await done(page);
  await expect(answer.locator(".katex")).toHaveCount(1); await expect(answer.locator(".hljs-string")).toBeVisible();
  await answer.getByRole("button", { name: "复制代码", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("print('scientific-evidence')");
  await answer.getByRole("button", { name: "实验协议", exact: true }).click();
  await expect(page.locator(".agent-source-preview pre")).toContainText("Scientific evidence must retain its source version");
  await page.getByRole("button", { name: "关闭来源预览" }).click();
  await expect(page.locator(".evidence-read").filter({ hasText: "来源内容" })).toContainText("file:README.md");
  await page.getByRole("button", { name: "关闭研究上下文" }).click(); await answer.hover();
  await answer.getByRole("button", { name: "整理为科研笔记", exact: true }).click(); await expect(answer).toContainText("已提交研究变更审阅");
  await page.getByRole("button", { name: "上下文", exact: true }).click(); await page.getByRole("tab", { name: "研究变更", exact: true }).click();
  await expect(page.locator(".candidate-change")).toContainText("Scientific record"); await page.getByRole("button", { name: "接受", exact: true }).click();
  const topology = await (await page.request.get(app.url + "/api/topology")).json();
  const note = topology.nodes.find(node => node.data?.noteMarkdown?.includes("结果需要进一步复核")); expect(note).toBeTruthy();
  await page.goto(app.url + "/#/topology/nodes/" + encodeURIComponent(note.id));
  await expect(page.locator(".research-markdown")).toContainText("结果需要进一步复核");
  await expect(page.locator(".research-markdown .katex")).toHaveCount(1); await page.screenshot({ path: "test-results/agent-scientific-note.png", fullPage: true });
  await page.getByRole("link", { name: "研究记录", exact: true }).click();
  await page.getByRole("button", { name: "纪要与记录", exact: true }).click();
  await expect(page.locator(".research-record-timeline")).not.toContainText("结果需要进一步复核");
});

test("renaming, pinning, archiving and restoring preserve the same conversation", async ({ page }) => {
  const session = await create(page, "Metadata original");
  await page.locator(".conversation-scroll").evaluate(node => node.setAttribute("data-kept", "true"));
  const row = () => page.locator(".session-row").filter({ has: page.locator(".session").filter({ hasText: /Metadata/ }) });
  await row().getByRole("button", { name: "会话操作", exact: true }).click(); await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  await page.getByRole("textbox", { name: "会话名称" }).fill("Metadata renamed"); await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Metadata renamed" })).toBeVisible(); await expect(page.locator(".conversation-scroll")).toHaveAttribute("data-kept", "true");
  await row().getByRole("button", { name: "会话操作", exact: true }).click(); await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
  await page.reload(); expect((await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json()).pinned).toBe(true);
  await row().getByRole("button", { name: "会话操作", exact: true }).click(); await page.getByRole("menuitem", { name: "归档会话", exact: true }).click();
  await page.getByRole("button", { name: /^归档/ }).click(); await page.locator(".session").filter({ hasText: "Metadata renamed" }).click();
  await expect(page.locator(".archived-session-banner")).toBeVisible(); await page.getByRole("button", { name: "恢复会话", exact: true }).click();
  const detail = await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json(); expect(detail.id).toBe(session.id); expect(detail.archived).toBe(false);
});
