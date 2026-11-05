import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/#/agents");
  await page.getByLabel("用户名").fill(process.env.TOPOLUMIA_E2E_USERNAME ?? "admin");
  await page.getByLabel("密码").fill(process.env.TOPOLUMIA_E2E_PASSWORD ?? "Topolumia-Reset-2026!");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Research Project/ }).click();
  await expect(page.getByRole("heading", { name: "Agent 研究审阅" })).toBeVisible({ timeout: 10_000 });
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
