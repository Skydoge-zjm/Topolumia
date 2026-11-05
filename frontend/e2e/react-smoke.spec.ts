import { test, expect } from "@playwright/test";

test("React frontend renders the authenticated entry boundary", async ({ page }) => {
  await page.goto("/#/agents");
  await expect(page.locator("#root")).toBeVisible();
  await expect(page.getByText("登录研究工作台")).toBeVisible();
});

test("project management pages use the outer shell without a workspace sidebar", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByLabel("用户名").fill(process.env.TOPOLUMIA_E2E_USERNAME ?? "admin");
  await page.getByLabel("密码").fill(process.env.TOPOLUMIA_E2E_PASSWORD ?? "Topolumia-Reset-2026!");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".project-shell .sidebar")).toHaveCount(0);
  await page.getByRole("link", { name: "项目协作" }).click();
  await expect(page.getByRole("heading", { name: "项目协作" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".project-shell .sidebar")).toHaveCount(0);
  await expect(page.locator(".project-rail")).toHaveCount(0);
});

test("authenticated user reaches the React Agent workspace", async ({ page }) => {
  await page.goto("/#/agents");
  await page.getByLabel("用户名").fill(process.env.TOPOLUMIA_E2E_USERNAME ?? "admin");
  await page.getByLabel("密码").fill(process.env.TOPOLUMIA_E2E_PASSWORD ?? "Topolumia-Reset-2026!");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Research Project/ }).click();
  await expect(page.getByRole("heading", { name: "Agent 研究审阅" })).toBeVisible({ timeout: 10_000 });
});

test("Agent workspace keeps the desktop three-column layout", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/agents");
  await page.getByLabel("用户名").fill(process.env.TOPOLUMIA_E2E_USERNAME ?? "admin");
  await page.getByLabel("密码").fill(process.env.TOPOLUMIA_E2E_PASSWORD ?? "Topolumia-Reset-2026!");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Research Project/ }).click();
  await expect(page.getByRole("heading", { name: "Agent 研究审阅" })).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "test-results/agent-workspace-1440.png", fullPage: true });
  const grid = page.locator(".agent-grid");
  await expect(grid).toBeVisible();
  expect(await grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns)).toContain("230px");
});

test("Agent workspace remains usable at the 1280 desktop width", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/agents");
  await page.getByLabel("用户名").fill(process.env.TOPOLUMIA_E2E_USERNAME ?? "admin");
  await page.getByLabel("密码").fill(process.env.TOPOLUMIA_E2E_PASSWORD ?? "Topolumia-Reset-2026!");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Research Project/ }).click();
  await expect(page.getByRole("heading", { name: "Agent 研究审阅" })).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "test-results/agent-workspace-1280.png", fullPage: true });
  await expect(page.locator(".agent-grid")).toBeVisible();
});

test("React Agent can create a session and render a real Codex reply", async ({ page }) => {
  await page.request.post("/api/auth/login", { data: { username: process.env.TOPOLUMIA_E2E_USERNAME ?? "admin", password: process.env.TOPOLUMIA_E2E_PASSWORD ?? "Topolumia-Reset-2026!" } });
  const profiles = await page.request.get("/api/agent-profiles");
  const profileData = await profiles.json();
  const codex = profileData.profiles.find((profile: { provider: string }) => profile.provider === "codex");
  const created = await page.request.post("/api/agent-sessions", { data: { profileId: codex.id, title: "React UI smoke api" } });
  const session = await created.json();
  await page.goto("/#/agents");
  await expect(page.getByRole("heading", { name: "Agent 研究审阅" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".session-list .session").filter({ hasText: session.title }).first()).toBeVisible({ timeout: 10_000 });
  await page.locator(".session-list .session").filter({ hasText: session.title }).first().click();
  await expect(page.locator(".conversation textarea")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".conversation h2")).toHaveText(session.title, { timeout: 10_000 });
  await page.waitForTimeout(500);
  const composer = page.locator(".conversation textarea");
  await composer.fill("Reply with exactly UI_SMOKE and do not call tools.");
  await expect(composer).toHaveValue("Reply with exactly UI_SMOKE and do not call tools.");
  const sendButton = page.getByRole("button", { name: /发送/ });
  await expect(sendButton).toBeEnabled({ timeout: 10_000 });
  await sendButton.click();
  await expect(page.locator(".message-body").filter({ hasText: "UI_SMOKE" })).toBeVisible({ timeout: 60_000 });
  await page.request.post(`/api/agent-sessions/${encodeURIComponent(session.id)}/close`);
});
