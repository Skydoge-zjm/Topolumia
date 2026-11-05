import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startMvpServer } from "../../dist/src/server.js";

test("Topolumia tool actions are bilingual and JSON results render as content while copying the original result", async ({ page, context }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-tool-output-"));
  const app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: { sourceRefresh: { enabled: false }, agentSessions: { profiles: [{ id: "structured-claude", label: "Claude Code", provider: "claude", driver: "claude-cli-stream", command: process.execPath, launcherArgs: [path.resolve("fixtures/trace-audit/native-wire.mjs")], env: { TOPOLUMIA_TRACE_AUDIT_CASE: "claude-structured-tools" }, model: "gpt-6-luna" }] } } });
  try {
    const password = "Tool-Output-Fixture-Only-2026!";
    await page.request.post(`${app.url}/api/auth/bootstrap`, { data: { username: "output", displayName: "Output Tester", password } });
    await page.request.post(`${app.url}/api/auth/login`, { data: { username: "output", password } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const response = await page.request.post(`${app.url}/api/agent-sessions`, { data: { profileId: "structured-claude", title: "科研工具结果" } }); expect(response.ok()).toBe(true);
    const session = await response.json();
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(`${app.url}/#/agents`);
    await expect(page.getByRole("heading", { name: "科研工具结果", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "研究消息" }).fill("Inspect structured results"); await page.getByRole("textbox", { name: "研究消息" }).press("Enter");
    await expect(page.getByText("Structured tool outputs verified.", { exact: true })).toBeVisible();
    await page.locator(".activity-batch > summary").click();
    const summaries = page.locator(".tool-group > summary");
    await expect(summaries.filter({ hasText: "读取科研上下文" })).toHaveCount(1); await expect(summaries.filter({ hasText: "搜索节点" })).toHaveCount(1);
    await expect(summaries.filter({ hasText: "mcp__topolumia__" })).toHaveCount(0); await expect(summaries.filter({ hasText: "mcp__papers__search" })).toHaveCount(1);
    await summaries.filter({ hasText: "搜索节点" }).click(); await expect(page.getByText("条件化实验", { exact: true })).toBeVisible();
    await summaries.filter({ hasText: "读取来源" }).click();
    const source = page.locator(".tool-group").filter({ has: page.locator(".research-source-result") });
    await expect(source.getByRole("heading", { name: "实验计划" })).toBeVisible(); await expect(source.getByRole("columnheader", { name: "组别" })).toBeVisible();
    await expect(source.locator(".tool-output")).toHaveCount(0);
    const snapshot = await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json();
    const output = snapshot.events.find(event => event.type === "tool.completed" && event.payload.title === "mcp__topolumia__read_source").payload.rawOutput;
    await source.getByRole("button", { name: "复制输出", exact: true }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(output);
    await expect(source.locator(":scope > .tool-body")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: "test-results/agent-structured-tool-results-zh.png", fullPage: true });
    await page.getByRole("button", { name: "语言", exact: true }).click(); await page.getByRole("option", { name: "English", exact: true }).click();
    await expect(summaries.filter({ hasText: "Search nodes" })).toHaveCount(1); await expect(source.getByText("Source and version", { exact: true })).toBeVisible();
    await page.reload(); await expect(source.getByRole("heading", { name: "实验计划" })).toBeVisible();
    await expect(summaries.filter({ hasText: "mcp__papers__search" })).toHaveCount(1);
    await page.screenshot({ path: "test-results/agent-structured-tool-results.png", fullPage: true });
  } finally { await app.agentSessionGateway.closeAll(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
