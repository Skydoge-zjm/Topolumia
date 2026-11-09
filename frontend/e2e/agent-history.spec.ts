import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../dist/src/server.js";

let app;
let root: string;
const start = (port = 0) => startMvpServer({ port, testMode: false,
  collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"),
  config: { project: { workspacesRoot: path.join(root, "workspaces") }, sourceRefresh: { enabled: false }, agentSessions: { maxEventsPerSession: 100, profiles: [{
    id: "claude-history", label: "Claude Code", provider: "claude", driver: "claude-cli-stream",
    command: process.execPath, launcherArgs: [path.resolve("dist/fixtures/native/claude-cli.js")],
  }, {
    id: "claude-text", label: "Claude Code", provider: "claude", driver: "claude-cli-stream", command: process.execPath,
    launcherArgs: [path.resolve("fixtures/trace-audit/native-wire.mjs")], env: { TOPOLUMIA_TRACE_AUDIT_CASE: "claude-text-blocks" },
  }, {
    id: "claude-nested", label: "Claude Code", provider: "claude", driver: "claude-cli-stream", command: process.execPath,
    launcherArgs: [path.resolve("fixtures/trace-audit/native-wire.mjs")], env: { TOPOLUMIA_TRACE_AUDIT_CASE: "claude-subagent" },
  }] } },
});
const stop = async () => {
  await app.agentSessionGateway.closeAll();
  app.server.closeAllConnections();
  await new Promise<void>(resolve => app.server.close(resolve));
};

test.beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "topolumia-claude-history-"));
  app = await start();
  await fetch(`${app.url}/api/auth/bootstrap`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "history", displayName: "History Tester", password: "History-Fixture-Only-2026!" }) });
});
test.afterAll(async () => {
  await stop();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("long Claude conversations retain their top, user input and tools across refresh, sync and restart", async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.request.post(`${app.url}/api/auth/login`, { data: { username: "history", password: "History-Fixture-Only-2026!" } });
  await page.goto(`${app.url}/#/agents`);
  const created = await page.request.post(`${app.url}/api/agent-sessions`, { data: { profileId: "claude-history", title: "Long Claude history" } });
  expect(created.ok()).toBe(true);
  const session = await created.json();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Long Claude history" })).toBeVisible();
  const input = page.getByRole("textbox", { name: "研究消息" });
  for (const [index, text] of ["long-stream original question", "long-stream follow-up question"].entries()) {
    await input.fill(text); await input.press("Enter");
    await expect.poll(async () => {
      const detail = await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json();
      return detail.turns.filter(turn => turn.status === "completed").length;
    }).toBe(index + 1);
    await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  }
  // The raw trace has rolled over several times; the rendered conversation has
  // both questions, both prefaces and all four successful tool calls.
  await page.reload();
  await expect(page.locator(".message.user")).toHaveCount(2);
  await expect(page.locator(".message").filter({ hasText: "先检查研究材料。" })).toHaveCount(2);
  for (const summary of await page.locator(".activity-batch > summary").all()) if (!await summary.evaluate(node => (node.parentElement as HTMLDetailsElement).open)) await summary.click();
  // Each of the two turns reads 0.md and 1.md independently.
  await expect(page.locator(".tool-group > summary").filter({ hasText: /^Read/ })).toHaveCount(4);
  await expect(page.locator(".tool-group").filter({ hasText: "已取消" })).toHaveCount(0);
  const scroll = page.locator(".conversation-scroll");
  await scroll.evaluate(node => { node.scrollTop = 0; });
  await expect(page.getByText("long-stream original question", { exact: true })).toBeInViewport();
  // A snapshot refresh while reading the top must not force a jump to the end.
  await page.getByRole("button", { name: "更多会话操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "刷新记录", exact: true }).click();
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(0);
  await expect(page.getByText("long-stream original question", { exact: true })).toBeInViewport();
  const detail = await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json();
  expect(detail.lastCursor).toBeGreaterThan(2_000);
  expect(detail.events.length).toBeLessThan(30);
  expect(detail.events.some(event => event.type.endsWith(".delta") || event.type === "tool.updated" || event.type === "native.trace")).toBe(false);
  expect(detail.conversationEvents.length).toBeLessThan(30);
  // A new backend instance must restore the same conversation from disk.
  const port = Number(new URL(app.url).port);
  await stop(); app = await start(port);
  await page.reload();
  await expect(page.locator(".message.user")).toHaveCount(2);
  await scroll.evaluate(node => { node.scrollTop = 0; });
  await expect(page.getByText("long-stream original question", { exact: true })).toBeInViewport();
  await page.screenshot({ path: "test-results/claude-history-restored.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("Claude reasoning blocks remain separate and identical phases are retained once per native block", async ({ page }) => {
  await page.request.post(`${app.url}/api/auth/login`, { data: { username: "history", password: "History-Fixture-Only-2026!" } });
  await page.goto(`${app.url}/#/agents`);
  const created = await page.request.post(`${app.url}/api/agent-sessions`, { data: { profileId: "claude-history", title: "Reasoning audit" } });
  expect(created.ok()).toBe(true);
  const session = await created.json();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Reasoning audit" })).toBeVisible();
  const input = page.getByRole("textbox", { name: "研究消息" });
  await input.fill("reasoning-blocks"); await input.press("Enter");
  await expect(page.getByText("Reasoning boundaries verified.", { exact: true })).toBeVisible();
  await page.reload();
  await page.locator(".activity-batch > summary").click();
  await expect(page.locator(".reasoning-detail")).toHaveCount(4);
  const summaries = page.locator(".tool-group > summary").filter({ hasText: /推理摘要/ });
  await expect(summaries).toHaveCount(4);
  for (const summary of await summaries.all()) await summary.click();
  await expect(page.locator(".reasoning-detail strong").filter({ hasText: /^Check source$/ })).toHaveCount(1);
  await expect(page.locator(".reasoning-detail strong").filter({ hasText: /^Check version$/ })).toHaveCount(1);
  await expect(page.locator(".reasoning-detail strong").filter({ hasText: /^Repeated native phase$/ })).toHaveCount(2);
  const headingLines = await page.locator(".reasoning-detail").first().locator("strong").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
  expect(headingLines[1]).toBeGreaterThan(headingLines[0]);
  const detail = await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json();
  expect(detail.conversationEvents.filter(e => e.type === "reasoning.summary.completed")).toHaveLength(4);
  await page.screenshot({ path: "test-results/claude-reasoning-blocks.png", fullPage: true });
});

test("message navigation previews and jumps to repeated questions without following new output away from the reading position", async ({ page }) => {
  test.setTimeout(60_000);
  await page.request.post(`${app.url}/api/auth/login`, { data: { username: "history", password: "History-Fixture-Only-2026!" } });
  const created = await page.request.post(`${app.url}/api/agent-sessions`, { data: { profileId: "claude-history", title: "Message navigation audit" } });
  expect(created.ok()).toBe(true);
  const session = await created.json();
  await page.goto(`${app.url}/#/agents`);
  await expect(page.getByRole("heading", { name: "Message navigation audit" })).toBeVisible();
  const input = page.getByRole("textbox", { name: "研究消息" });
  for (let count = 1; count <= 2; count++) {
    await input.fill("long-stream repeated navigation question"); await input.press("Enter");
    await expect.poll(async () => (await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json()).turns.filter(turn => turn.status === "completed").length).toBe(count);
  }
  const rail = page.getByRole("navigation", { name: "消息导航" });
  await expect(rail.getByRole("button")).toHaveCount(2);
  const first = rail.getByRole("button", { name: /^定位到第 1 条用户消息/ });
  const second = rail.getByRole("button", { name: /^定位到第 2 条用户消息/ });
  const preview = page.locator(".conversation-nav-preview");
  await first.hover();
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("long-stream repeated navigation question");
  await expect(preview).toContainText("科研结果与证据均已核对。");
  const previewBounds = await preview.boundingBox();
  const railBounds = await rail.boundingBox();
  expect(previewBounds!.x).toBeGreaterThan(railBounds!.x + railBounds!.width);
  await first.press("Escape");
  await expect(preview).toHaveCount(0);
  await first.click();
  await expect(page.locator(".message.user").first()).toBeInViewport();
  await expect(page.locator(".message.user").first()).toBeFocused();
  await expect(first).toHaveAttribute("aria-current", "location");
  const scroll = page.locator(".conversation-scroll");
  const readingPosition = await scroll.evaluate(node => node.scrollTop);

  app.agentSessionGateway.startTurn(session.id, { text: "New output while reading an earlier question" });
  await expect(rail.getByRole("button")).toHaveCount(3);
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  expect(await scroll.evaluate(node => node.scrollTop)).toBe(readingPosition);
  await expect(page.locator(".message.user").first()).toBeInViewport();

  await first.focus(); await first.press("ArrowDown");
  await expect(second).toBeFocused();
  await second.press("Enter");
  await expect(page.locator(".message.user").nth(1)).toBeInViewport();
  await expect(second).toHaveAttribute("aria-current", "location");
  // Keyboard activation closes its preview; leave the trigger before a new hover.
  await page.getByRole("heading", { name: "Message navigation audit" }).hover();
  await second.hover();
  await expect(preview).toBeVisible();
  await page.screenshot({ path: "runtime/tools-preview/agent-message-navigation-verified.png", fullPage: true });
});

test("Claude continuation after restart keeps one session, its history and its native binding", async ({ page }) => {
  await page.request.post(`${app.url}/api/auth/login`, { data: { username: "history", password: "History-Fixture-Only-2026!" } });
  await page.goto(`${app.url}/#/agents`);
  const response = await page.request.post(`${app.url}/api/agent-sessions`, { data: { profileId: "claude-history", title: "Continued Claude history" } });
  expect(response.ok()).toBe(true);
  const session = await response.json();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Continued Claude history" })).toBeVisible();
  const input = page.getByRole("textbox", { name: "研究消息" });
  await input.fill("long-stream first question"); await input.press("Enter");
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await expect(page.locator(".message.user")).toHaveCount(1);
  const original = await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json();
  const listCount = await page.locator(".session-list .session").count();

  const port = Number(new URL(app.url).port);
  await stop(); app = await start(port);
  await page.reload();
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "detached");
  await expect(page.getByText("long-stream first question", { exact: true })).toBeAttached();
  await input.fill("long-stream second question"); await input.press("Enter");
  await expect(page.locator(".message.user")).toHaveCount(2);
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await expect(page.locator(".session-list .session")).toHaveCount(listCount);
  await expect(page.locator(".session-list .session").filter({ hasText: "Continued Claude history" })).toHaveCount(1);
  await expect(page.locator(".message").filter({ hasText: "先检查研究材料。" })).toHaveCount(2);
  const continued = await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json();
  expect(continued.id).toBe(original.id);
  expect(continued.runtimeInstanceId).not.toBe(original.runtimeInstanceId);
  expect(continued.nativeSessionId).toBe(original.nativeSessionId);
  expect(continued.turns).toHaveLength(2);

  await page.getByRole("button", { name: "更多会话操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "结束运行 · 保留历史", exact: true }).click();
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "closed");
  await page.getByRole("button", { name: "继续会话", exact: true }).click();
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await expect(page.locator(".message.user")).toHaveCount(2);
  await input.fill("long-stream third question"); await input.press("Enter");
  await expect(page.locator(".message.user")).toHaveCount(3);
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await page.reload();
  await expect(page.locator(".message.user")).toHaveCount(3);
  await expect(page.locator(".session-list .session")).toHaveCount(listCount);
  await page.locator(".conversation-scroll").evaluate(node => { node.scrollTop = 0; });
  await expect(page.getByText("long-stream first question", { exact: true })).toBeInViewport();
  await page.screenshot({ path: "test-results/agent-session-continuity.png", fullPage: true });
});

test("mixed activity collapses to one compact summary and Trace contains only complete results", async ({ page }) => {
  await page.request.post(`${app.url}/api/auth/login`, { data: { username: "history", password: "History-Fixture-Only-2026!" } });
  await page.goto(`${app.url}/#/agents`);
  const created = await page.request.post(`${app.url}/api/agent-sessions`, { data: { profileId: "claude-history", title: "Dense activity audit" } });
  expect(created.ok()).toBe(true);
  const session = await created.json();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Dense activity audit" })).toBeVisible();
  const input = page.getByRole("textbox", { name: "研究消息" });
  await input.fill("dense-activity"); await input.press("Enter");
  await expect(page.getByText("Final audit answer.", { exact: true })).toBeVisible();
  const summary = page.locator(".activity-batch > summary");
  await expect(summary).toHaveCount(1);
  await expect(summary).toHaveText("调用了 4 次 Topolumia MCP；思考 3 次");
  await expect(summary).not.toContainText(/get_context|read_nodes|search/);
  await expect(summary.locator(".activity-summary-secondary")).toBeVisible();
  await expect(page.getByText("Final audit answer.", { exact: true })).toBeInViewport();
  await page.screenshot({ path: "test-results/agent-activity-compact.png", fullPage: true });
  await summary.focus(); await summary.press("Enter");
  await expect(page.locator(".activity-batch-body > .tool-group")).toHaveCount(7);
  await expect(page.locator(".activity-batch-body > .tool-group > summary [data-event-icon='mcp']")).toHaveCount(4);
  await expect(page.locator(".activity-batch-body > .tool-group > summary [data-event-icon='reasoning']")).toHaveCount(3);
  await expect(page.locator(".activity-batch-body")).toContainText("读取科研上下文");
  await page.getByRole("button", { name: "更多会话操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "运行 Trace", exact: true }).click();
  await expect(page.locator(".trace-group--tool")).toHaveCount(4);
  await expect(page.locator(".trace-group--tool > summary [data-event-icon='mcp']")).toHaveCount(4);
  expect(await page.locator(".trace-call").count()).toBe(0);
  for (const row of await page.locator(".trace-group--tool > summary").all()) await row.click();
  await expect(page.locator(".trace-final-output").filter({ hasText: "Final context output" })).toBeVisible();
  const detail = await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json();
  expect(detail.events.filter(event => event.type === "tool.completed")).toHaveLength(4);
  expect(detail.events.some(event => event.payload.delta !== undefined || ["native.trace", "tool.updated"].includes(event.type))).toBe(false);
  await page.screenshot({ path: "test-results/agent-trace-final-results.png", fullPage: true });
});

test("shared conversation UI preserves text blocks and nests subagent output with keyboard access", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.request.post(`${app.url}/api/auth/login`, { data: { username: "history", password: "History-Fixture-Only-2026!" } });
  await page.goto(`${app.url}/#/agents`);
  for (const [profileId, title] of [["claude-text", "Text block audit"], ["claude-nested", "Nested audit"]]) {
    const created = await page.request.post(`${app.url}/api/agent-sessions`, { data: { profileId, title } });
    expect(created.ok()).toBe(true);
    await page.reload();
    await page.getByRole("button", { name: new RegExp(`^${title} `) }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    const input = page.getByRole("textbox", { name: "研究消息" });
    await input.fill("Inspect fixture"); await input.press("Enter");
    if (profileId === "claude-text") {
      await expect(page.getByText("First block. Second block.", { exact: true })).toBeVisible();
      await expect(page.locator(".message:not(.user)")).toHaveCount(1);
    } else {
      await expect(page.getByText("Parent answer.", { exact: true })).toBeVisible();
      const group = page.locator(".subagent-group");
      await expect(group).toHaveCount(1);
      await expect(group.getByText("Child report.", { exact: true })).toBeHidden();
      const summary = group.locator(":scope > summary");
      await summary.focus(); await summary.press("Enter");
      await expect(group.getByText("Child report.", { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.locator(".subagent-group")).toHaveCount(1);
      await expect(page.getByText("Parent answer.", { exact: true })).toBeVisible();
      await expect(group.getByText("Child report.", { exact: true })).toBeVisible();
      await summary.focus(); await summary.press("Enter");
      await expect(group.getByText("Child report.", { exact: true })).toBeHidden();
      await summary.press("Enter");
      await expect(group.getByText("Child report.", { exact: true })).toBeVisible();
      await page.screenshot({ path: "test-results/native-trace-shared-conversation.png", fullPage: true });
    }
  }
  expect(errors).toEqual([]);
});
