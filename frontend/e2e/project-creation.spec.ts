import { runtimeArtifact } from "./support/runtime-artifacts";
import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startMvpServer } from "../../dist/src/server.js";

test("project creation links an existing directory and shows the default workspace path and supports changing it", async ({
  page,
}) => {
  test.setTimeout(90000);
  const root = await mkdtemp(
      path.join(os.tmpdir(), "topolumia-project-browser-"),
    ),
    code = path.join(root, "existing-code"),
    later = path.join(root, "later-code");
  await mkdir(code);
  await mkdir(later);
  await writeFile(path.join(code, "keep.py"), "print('unchanged')\n");
  const app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: path.join(root, "db.sqlite"),
    userSettingsFile: path.join(root, "settings.json"),
    config: {
      project: {
        root: path.join(root, "default"),
        workspacesRoot: path.join(root, "workspaces"),
      },
      sourceRefresh: { enabled: false },
      curator: { enabled: false },
    },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    app.collaboration.bootstrapAdmin({
      username: "project-browser",
      password: "Synthetic-Project-2026!",
    });
    await page.request.post(app.url + "/api/auth/login", {
      data: {
        username: "project-browser",
        password: "Synthetic-Project-2026!",
      },
    });
    await page.addInitScript(
      (project) => localStorage.setItem("research-workbench-project", project),
      app.config.project.id,
    );
    await page.goto(app.url + "/#/project-create");
    await page
      .getByRole("textbox", { name: "项目名称", exact: true })
      .fill("关联已有代码");
    await expect(page.getByRole("textbox", { name: "项目 ID" })).toHaveCount(0);
    await page.screenshot({
      path: runtimeArtifact("self-review/project-create-desktop.png"),
      fullPage: true,
    });
    await page
      .getByRole("radio", { name: "本机已有目录", exact: true })
      .check();
    await page
      .getByRole("textbox", { name: "本机目录", exact: true })
      .fill(path.join(root, "missing"));
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("目录不存在");
    await expect(
      page.getByRole("textbox", { name: "项目名称", exact: true }),
    ).toHaveValue("关联已有代码");
    await page
      .getByRole("textbox", { name: "本机目录", exact: true })
      .fill(root);
    await page.getByRole("button", { name: "浏览", exact: true }).click();
    const browser = page.getByRole("dialog", { name: "选择目录", exact: true });
    await browser
      .getByRole("button", { name: "existing-code", exact: true })
      .click();
    await expect(
      browser.getByRole("button", { name: "选择此目录", exact: true }),
    ).toBeEnabled();
    await browser.screenshot({
      path: runtimeArtifact("self-review/project-directory-browser.png"),
    });
    await browser
      .getByRole("button", { name: "选择此目录", exact: true })
      .click();
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "研究总览", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "项目工作目录" }),
    ).toContainText(code);
    expect(await readFile(path.join(code, "keep.py"), "utf8")).toBe(
      "print('unchanged')\n",
    );
    const linkedProject = await page.evaluate(() =>
      localStorage.getItem("research-workbench-project"),
    );
    expect(app.collaboration.projectById(linkedProject).workspace.kind).toBe(
      "local",
    );

    await page.goto(app.url + "/#/project-create");
    await page
      .getByRole("textbox", { name: "项目名称", exact: true })
      .fill("默认工作区项目");
    await page
      .getByRole("radio", { name: "Topolumia 默认工作区", exact: true })
      .check();
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "研究总览", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "管理工作目录", exact: true }).click();
    const setup = page.getByRole("dialog", {
      name: "项目工作目录",
      exact: true,
    });
    await setup
      .getByRole("radio", { name: "本机已有目录", exact: true })
      .check();
    await setup
      .getByRole("textbox", { name: "本机目录", exact: true })
      .fill(later);
    await setup
      .getByRole("button", { name: "保存工作目录", exact: true })
      .click();
    await expect(setup).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "项目工作目录" }),
    ).toContainText(later);
    await page.goto(app.url + "/#/project-create");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("radio", { name: "SSH 目录", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: runtimeArtifact("self-review/project-create-mobile.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
