import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../dist/src/server.js";

test("tool summaries expose independent bounded command, input and output panes", async ({
  page,
}) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "topolumia-tool-disclosure-"),
  );
  const app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: path.join(root, "db.sqlite"),
    userSettingsFile: path.join(root, "settings.json"),
    config: {
      sourceRefresh: { enabled: false },
      agentSessions: {
        profiles: [
          {
            id: "compact-codex",
            label: "Codex",
            provider: "codex",
            driver: "codex-app-server",
            command: process.execPath,
            args: [path.resolve("fixtures/trace-audit/native-wire.mjs")],
            env: { TOPOLUMIA_TRACE_AUDIT_CASE: "codex-compact-tools" },
          },
        ],
      },
    },
  });
  try {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const credentials = {
      username: "disclosure",
      password: "Disclosure-Fixture-Only-2026!",
    };
    await page.request.post(`${app.url}/api/auth/bootstrap`, {
      data: { ...credentials, displayName: "Researcher" },
    });
    await page.request.post(`${app.url}/api/auth/login`, { data: credentials });
    const created = await page.request.post(`${app.url}/api/agent-sessions`, {
      data: { profileId: "compact-codex", title: "论文阅读 · 工具详情" },
    });
    expect(created.ok()).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${app.url}/#/agents`);
    await expect(
      page.getByRole("heading", { name: "论文阅读 · 工具详情", exact: true }),
    ).toBeVisible();
    const input = page.getByRole("textbox", { name: "研究消息" });
    await input.fill("阅读论文并核对原文图表");
    await input.press("Enter");
    await expect(
      page.getByText("论文与图表检查完成。", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".conversation-status")).toHaveAttribute(
      "data-session-status",
      "ready",
    );
    const progress = page
      .locator(".message")
      .filter({ hasText: "先检查论文和环境。" });
    await expect(progress.locator(".message-actions")).toHaveCount(0);
    await expect(
      page.locator(".message:not(.user) .message-actions"),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "整理为科研笔记", exact: true }),
    ).toHaveCount(1);

    await page.locator(".activity-batch > summary").click();
    const calls = page.locator(".activity-batch-body > .tool-group");
    await expect(calls).toHaveCount(4);
    await expect(calls.locator(".tool-result-view")).toHaveCount(0);
    await expect(calls.filter({ hasText: "读取来源" })).toHaveCount(2);
    for (const width of [1440, 820]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const summary of await calls.locator(":scope > summary").all())
        await expect(summary).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: "test-results/agent-tools-single-rows.png",
      fullPage: true,
    });

    await calls.nth(0).locator(":scope > summary").click();
    const command = calls
      .nth(0)
      .getByRole("region", { name: "完整命令", exact: true });
    const terminalOutput = calls
      .nth(0)
      .getByRole("region", { name: "工具输出", exact: true });
    await expect(command).toContainText("pwsh.exe");
    await expect(command).toContainText("材料 12");
    for (const pane of [command, terminalOutput]) {
      const size = await pane.evaluate((node) => ({
        height: node.getBoundingClientRect().height,
        client: node.clientHeight,
        content: node.scrollHeight,
      }));
      expect(size.height).toBeLessThan(page.viewportSize()!.height / 2);
      expect(size.content).toBeGreaterThan(size.client);
      await pane.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      expect(await pane.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    }
    await calls.nth(2).locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    await expect(
      calls.nth(2).getByRole("heading", { name: "图表检查结果" }),
    ).toBeVisible();
    await expect(calls.nth(3).locator(".tool-result-view")).toHaveCount(0);
    for (const name of ["工具输入", "工具输出"]) {
      const pane = calls.nth(2).getByRole("region", { name, exact: true });
      const size = await pane.evaluate((node) => ({
        height: node.getBoundingClientRect().height,
        client: node.clientHeight,
        content: node.scrollHeight,
      }));
      expect(size.height).toBeLessThan(page.viewportSize()!.height / 2);
      expect(size.content).toBeGreaterThan(size.client);
    }
    await page.screenshot({
      path: "test-results/agent-tools-expanded-panes.png",
      fullPage: true,
    });
    await calls.nth(0).locator(":scope > summary").click();
    await calls.nth(2).locator(":scope > summary").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "test-results/agent-tools-mcp-panes.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await app.agentSessionGateway.closeAll();
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(resolve));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
});
