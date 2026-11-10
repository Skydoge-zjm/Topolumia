import { test, expect, type Page } from "@playwright/test";
import { smokeCredentials, startSmokeApp, stopSmokeApp } from "./support/smoke-app";

let app: Awaited<ReturnType<typeof startSmokeApp>>;

test.beforeAll(async () => {
  app = await startSmokeApp();
});

test.afterAll(async () => {
  if (app) await stopSmokeApp(app.app, app.root);
});

async function login(page: Page) {
  await page.getByLabel("用户名").fill(smokeCredentials.username);
  await page.getByLabel("密码").fill(smokeCredentials.password);
  await page.getByRole("button", { name: "登录" }).click();
}

async function expectWorkspaceFits(page: Page) {
  const rail = page.getByRole("complementary").filter({
    has: page.getByRole("button", { name: "新建会话", exact: true }),
  });
  const composer = page.getByRole("textbox", { name: "研究消息" });
  await expect(rail).toBeVisible();
  await expect(composer).toBeVisible();
  const railBounds = await rail.boundingBox();
  const composerBounds = await composer.boundingBox();
  expect(railBounds!.x + railBounds!.width).toBeLessThanOrEqual(composerBounds!.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("React frontend renders the authenticated entry boundary", async ({ page }) => {
  await page.goto(`${app.app.url}/#/agents`);
  await expect(page.locator("#root")).toBeVisible();
  await expect(page.getByText("登录研究工作台")).toBeVisible();
});

test("project management pages use the outer shell without a workspace sidebar", async ({ page }) => {
  await page.goto(`${app.app.url}/#/projects`);
  await login(page);
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".project-shell .sidebar")).toHaveCount(0);
  await page.getByRole("link", { name: "项目协作" }).click();
  await expect(page.getByRole("heading", { name: "项目协作" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".project-shell .sidebar")).toHaveCount(0);
  await expect(page.locator(".project-rail")).toHaveCount(0);
});

test("authenticated user reaches the React Agent workspace", async ({ page }) => {
  await page.goto(`${app.app.url}/#/agents`);
  await login(page);
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Research Project/ }).click();
  await page.getByRole("link", { name: "Agent 会话", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Agent 会话", exact: true })).toBeVisible({ timeout: 10_000 });
});

test("Agent workspace keeps the desktop three-column layout", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${app.app.url}/#/agents`);
  await login(page);
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Research Project/ }).click();
  await page.getByRole("link", { name: "Agent 会话", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Agent 会话", exact: true })).toBeVisible({ timeout: 10_000 });
  await expectWorkspaceFits(page);
  await page.screenshot({ path: "test-results/agent-workspace-1440.png", fullPage: true });
});

test("Agent workspace remains usable at the 1280 desktop width", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.app.url}/#/agents`);
  await login(page);
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Research Project/ }).click();
  await page.getByRole("link", { name: "Agent 会话", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Agent 会话", exact: true })).toBeVisible({ timeout: 10_000 });
  await expectWorkspaceFits(page);
  await page.screenshot({ path: "test-results/agent-workspace-1280.png", fullPage: true });
});

test("React Agent can create a session and render a Codex fixture reply", async ({ page }) => {
  await page.request.post(`${app.app.url}/api/auth/login`, { data: smokeCredentials });
  const profiles = await page.request.get(`${app.app.url}/api/agent-profiles`);
  const profileData = await profiles.json();
  const codex = profileData.profiles.find((profile: { provider: string }) => profile.provider === "codex");
  const created = await page.request.post(`${app.app.url}/api/agent-sessions`, { data: { profileId: codex.id, title: "React UI smoke api" } });
  const session = await created.json();
  await page.goto(`${app.app.url}/#/agents`);
  await expect(page.getByRole("heading", { level: 1, name: "Agent 会话", exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: new RegExp(session.title) }).click();
  await expect(page.getByRole("heading", { name: session.title })).toBeVisible({ timeout: 10_000 });
  const composer = page.getByRole("textbox", { name: "研究消息" });
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.fill("Check the current experiment.");
  await page.getByRole("button", { name: /发送/ }).click();
  await expect(page.locator(".message-body").filter({ hasText: "已检查当前实验" })).toBeVisible({ timeout: 60_000 });
  await page.request.post(`${app.app.url}/api/agent-sessions/${encodeURIComponent(session.id)}/close`);
});
