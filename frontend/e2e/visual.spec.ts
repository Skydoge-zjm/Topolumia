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
  await page.goto(`${app.app.url}/#/agents`);
  await page.getByLabel("用户名").fill(smokeCredentials.username);
  await page.getByLabel("密码").fill(smokeCredentials.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Research Project/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Agent 会话", exact: true })).toBeVisible({ timeout: 10_000 });
  const created = await page.request.post(`${app.app.url}/api/agent-sessions`, {
    data: { profileId: "smoke-codex", title: "视觉回归会话" },
  });
  expect(created.status()).toBe(201);
  const session = await created.json();
  const turn = await page.request.post(`${app.app.url}/api/agent-sessions/${session.id}/turns`, {
    data: { text: "Check the current experiment." },
  });
  expect(turn.status()).toBe(202);
  await expect.poll(async () => {
    const detail = await (await page.request.get(`${app.app.url}/api/agent-sessions/${session.id}`)).json();
    return detail.turns[0]?.status;
  }).toBe("completed");
  await page.reload();
  await page.getByRole("button", { name: /视觉回归会话/ }).first().click();
  await expect(page.getByRole("heading", { level: 2, name: "视觉回归会话", exact: true })).toBeVisible();
  await expect(page.getByText(/^已检查当前实验。/)).toBeVisible();
}

test("Agent workspace visual baseline at 1440", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await expect(page).toHaveScreenshot("agent-workspace-1440.png", { fullPage: true, animations: "disabled", maxDiffPixelRatio: 0.02, mask: [page.locator(".session-list"), page.locator(".context-scroll")] });
});

test("Agent workspace visual baseline at 1280", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  await expect(page).toHaveScreenshot("agent-workspace-1280.png", { fullPage: true, animations: "disabled", maxDiffPixelRatio: 0.02, mask: [page.locator(".session-list"), page.locator(".context-scroll")] });
});
