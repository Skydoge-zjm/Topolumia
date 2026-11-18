import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeArtifact } from "./support/runtime-artifacts";
import {
  smokeCredentials,
  startSmokeApp,
  stopSmokeApp,
} from "./support/smoke-app";

test("project deletion confirms impact, retains original files and allows deleting the last project", async ({
  page,
}) => {
  const { app, root } = await startSmokeApp();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const directory = path.join(root, "existing-code");
    await mkdir(directory);
    await writeFile(path.join(directory, "keep.py"), "print('original')\n");
    await page.request.post(app.url + "/api/auth/login", {
      data: smokeCredentials,
    });
    const created = await page.request.post(app.url + "/api/projects", {
      data: { name: "待删除研究项目", workspace: { kind: "local", directory } },
    });
    expect(created.status()).toBe(201);
    const project = (await created.json()).project;
    await page.goto(app.url + "/#/projects");
    await page
      .getByRole("button", { name: "待删除研究项目", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "研究总览", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "项目列表", exact: true }).click();
    await page
      .getByRole("button", { name: "删除项目：待删除研究项目", exact: true })
      .click();
    let dialog = page.getByRole("dialog", { name: "删除项目", exact: true });
    await expect(dialog).toContainText("研究数据、会话历史和工作目录会保留");
    await expect(
      dialog.getByRole("button", { name: "确认删除", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: runtimeArtifact("self-review/project-delete-desktop.png"),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "待删除研究项目", exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await page
      .getByRole("button", { name: "删除项目：待删除研究项目", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("textbox", { name: "输入项目名称以确认" }),
    ).toBeVisible();
    await dialog.getByRole("textbox").fill(project.name);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: runtimeArtifact("self-review/project-delete-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 812, height: 375 });
    await dialog.getByRole("button", { name: "确认删除", exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "确认删除", exact: true })).toBeInViewport();
    await page.setViewportSize({ width: 375, height: 812 });
    await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("项目已删除。");
    await expect(
      page.getByRole("button", { name: "待删除研究项目", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("research-workbench-project"),
      ),
    ).toBeNull();
    expect(await readFile(path.join(directory, "keep.py"), "utf8")).toBe(
      "print('original')\n",
    );
    await page
      .getByRole("button", { name: "删除项目：Research Project", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill("Research Project");
    await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(
      page.getByText("当前账号还没有可访问的研究项目。", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("当前账号还没有可访问的研究项目。", { exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "创建项目", exact: true }).click();
    await page
      .getByRole("textbox", { name: "项目名称", exact: true })
      .fill("新的研究项目");
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "研究总览", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await stopSmokeApp(app, root);
  }
});
