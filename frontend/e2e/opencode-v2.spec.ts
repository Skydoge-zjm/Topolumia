import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startMvpServer } from "../../dist/src/server.js";
import { runtimeArtifact } from "./support/runtime-artifacts";

let app, root: string;
const password = "OpenCode-V2-Browser-2026!";
test.beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "topolumia-opencode-v2-browser-"));
  const fixture = path.resolve("dist/fixtures/native/opencode/v2/server.js");
  app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: {
    project: { workspacesRoot: path.join(root, "workspaces") }, sourceRefresh: { enabled: false }, agentSessions: { profiles: [
      { id: "opencode-v2", provider: "opencode", label: "OpenCode 2", driver: "opencode-server-v2", command: process.execPath,
        args: [fixture], versionArgs: [fixture, "--version"], model: "fixture/model/with-slash", approvalPolicy: "on-request" },
    ] },
  } });
  app.collaboration.bootstrapAdmin({ username: "opencode-v2", password });
});
test.afterAll(async () => { await app?.close(); if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
test.beforeEach(async ({ page }) => { await page.request.post(`${app.url}/api/auth/login`, { data: { username: "opencode-v2", password } }); });

test("OpenCode 2 completes research turns and exposes saved project approvals", async ({ page }) => {
  const response = await page.request.post(`${app.url}/api/agent-sessions`, { data: { profileId: "opencode-v2", title: "OpenCode 2 验收" } });
  expect(response.ok(), await response.text()).toBe(true);
  const session = await response.json();
  await page.goto(`${app.url}/#/agents`);
  await expect(page.getByRole("heading", { name: "OpenCode 2 验收", exact: true })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "研究消息" });
  await composer.fill("Check research context"); await composer.press("Enter");
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await expect(page.getByText("OpenCode 2 verified.", { exact: true })).toBeVisible();
  await composer.fill("approval-check"); await composer.press("Enter");
  const pending = page.locator(".agent-approval.is-pending"); await expect(pending).toBeVisible();
  await expect(pending).toContainText("python");
  await expect(pending.getByRole("button", { name: "本会话允许", exact: true })).toHaveCount(0);
  await page.reload(); await expect(pending).toBeVisible();
  await pending.getByText("保存授权规则…", { exact: true }).click();
  await pending.getByRole("button", { name: "允许并保存到项目", exact: true }).click();
  await expect(pending).toHaveCount(0);
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await expect(page.locator(".agent-approval.is-resolved")).toContainText("持久规则");
  const detail = await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json();
  expect(detail.nativeDriver).toBe("opencode-server-v2");
  expect(detail.turns).toHaveLength(2); expect(detail.pendingApprovals).toEqual([]);
  await page.screenshot({ path: runtimeArtifact("opencode-v2-acceptance.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(composer).toBeVisible();
  await page.screenshot({ path: runtimeArtifact("opencode-v2-acceptance-mobile.png"), fullPage: true });
});
