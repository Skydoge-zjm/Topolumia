import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../dist/src/server.js";

test("research proposals appear after their turn and can be previewed, accepted, deferred and rejected inline", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const root = await mkdtemp(
    path.join(os.tmpdir(), "topolumia-inline-review-"),
  );
  const app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: path.join(root, "db.sqlite"),
    userSettingsFile: path.join(root, "settings.json"),
    config: {
      project: {
        id: "inline-review",
        name: "Review fixture",
        root: path.join(root, "workspace"),
        workspacesRoot: path.join(root, "workspaces"),
      },
      filesystem: { roots: [path.join(root, "workspace")] },
      sourceRefresh: { enabled: false },
      curator: { enabled: false },
      agentSessions: {
        profiles: [
          {
            id: "review-codex",
            label: "Codex",
            provider: "codex",
            driver: "codex-app-server",
            command: process.execPath,
            args: [path.resolve("dist/fixtures/native/codex-app-server.js")],
          },
        ],
      },
    },
  });
  let restoreSave: (() => void) | undefined;
  try {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const credentials = {
      username: "review",
      password: "Review-Fixture-Only-2026!",
    };
    await page.request.post(`${app.url}/api/auth/bootstrap`, {
      data: { ...credentials, displayName: "Researcher" },
    });
    await page.request.post(`${app.url}/api/auth/login`, { data: credentials });
    await page.addInitScript(() =>
      localStorage.setItem("research-workbench-project", "inline-review"),
    );
    const created = await page.request.post(`${app.url}/api/agent-sessions`, {
      data: { profileId: "review-codex", title: "论文阅读与审阅" },
    });
    expect(created.ok()).toBe(true);
    const session = await created.json();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${app.url}/#/agents`);
    await expect(
      page.getByRole("heading", { name: "论文阅读与审阅", exact: true }),
    ).toBeVisible();
    const input = page.getByRole("textbox", { name: "研究消息" });
    await input.fill("inline-review first");
    await input.press("Enter");
    await expect(
      page.getByText("候选已提出，正在完成结果说明。", { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(".agent-turn-changes .research-candidate"),
    ).toHaveCount(0);
    await expect(
      page.getByText("本轮 1 的科研候选已准备好，请审阅。", { exact: true }),
    ).toBeVisible();
    const section = page.getByRole("region", {
      name: "本轮科研变更",
      exact: true,
    });
    await expect(section).toHaveCount(1);
    await expect(section.locator(".research-candidate")).toHaveCount(2);
    const gateway = app.runtimes.get(app.config.project.id).agentSessionGateway;
    const store = gateway.historyStore,
      originalSave = store.upsert.bind(store);
    restoreSave = () => { store.upsert = originalSave; };
    let saveAllowed = false;
    store.upsert = async (value) => {
      if (!saveAllowed) throw new Error("Fixture disk unavailable");
      return originalSave(value);
    };
    await page.request.post(
      `${app.url}/api/agent-sessions/${session.id}/persist`,
    );
    await expect(page.locator(".agent-history-error")).toContainText(
      "会话历史保存失败",
    );
    await page.route("**/api/agent-sessions/*/persist", async (route) => {
      saveAllowed = true;
      await route.continue();
    });
    await page.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect(page.locator(".agent-history-error")).toHaveCount(0);
    store.upsert = originalSave;
    expect(
      await section.evaluate(
        (node) => node.previousElementSibling?.textContent,
      ),
    ).toContain("本轮 1");
    const paper = section.getByRole("article", {
      name: "论文阅读结果 1",
      exact: true,
    });
    await expect(paper).toContainText("新增 2 个");
    await paper.getByText("查看实际内容与来源", { exact: true }).click();
    await expect(
      paper.getByText("The method and evidence are preserved for review.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      paper.getByText("These findings require independent validation.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/agent-inline-research-pending.png",
      fullPage: true,
    });

    await paper
      .getByRole("button", { name: "接受并保存", exact: true })
      .click();
    await expect(paper).toHaveAttribute("data-status", "applied");
    await expect(
      paper.getByRole("button", { name: "接受并保存", exact: true }),
    ).toHaveCount(0);
    await expect(
      paper.getByRole("link", { name: "查看已保存对象 · Reviewed paper 1", exact: true }),
    ).toBeVisible();
    const question = section.getByRole("article", {
      name: "后续研究问题",
      exact: true,
    });
    await question.getByRole("button", { name: "暂缓", exact: true }).click();
    await expect(question).toHaveAttribute("data-status", "deferred");
    await question.getByRole("button", { name: "拒绝", exact: true }).click();
    await expect(question).toHaveAttribute("data-status", "rejected");
    await expect(question).toContainText("未写入科研拓扑");

    await input.fill("inline-review second");
    await input.press("Enter");
    await expect(
      page.getByText("本轮 2 的科研候选已准备好，请审阅。", { exact: true }),
    ).toBeVisible();
    await expect(section).toHaveCount(2);
    await expect(section.nth(0).locator(".research-candidate")).toHaveCount(2);
    await expect(section.nth(1).locator(".research-candidate")).toHaveCount(1);
    expect(
      await section
        .nth(1)
        .evaluate((node) => node.previousElementSibling?.textContent),
    ).toContain("本轮 2");
    await section
      .nth(1)
      .getByRole("button", { name: "拒绝", exact: true })
      .click();
    await expect(section.nth(1).locator(".research-candidate")).toHaveAttribute(
      "data-status",
      "rejected",
    );
    await page.reload();
    await expect(section).toHaveCount(2);
    await expect(
      page.locator(
        ".agent-turn-changes .research-candidate[data-status=applied]",
      ),
    ).toHaveCount(1);
    await expect(
      page.locator(
        ".agent-turn-changes .research-candidate[data-status=rejected]",
      ),
    ).toHaveCount(2);
    await page.getByRole("button", { name: "语言", exact: true }).click();
    await page.getByRole("option", { name: "English", exact: true }).click();
    await expect(
      page.getByRole("region", {
        name: "Proposed research changes",
        exact: true,
      }),
    ).toHaveCount(2);
    const contextResponse = await page.request.get(
      `${app.url}/api/agent-sessions/${session.id}/context?projectId=${encodeURIComponent(app.config.project.id)}`,
    );
    const context = await contextResponse.json();
    expect(contextResponse.ok(), JSON.stringify(context.error ?? {})).toBe(
      true,
    );
    expect(
      new Set(context.candidates.map((candidate) => candidate.turnId)).size,
    ).toBe(2);
    expect(
      context.candidates.filter((candidate) => candidate.status === "applied"),
    ).toHaveLength(1);
    await page.screenshot({
      path: "test-results/agent-inline-research-reviewed.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    restoreSave?.();
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
