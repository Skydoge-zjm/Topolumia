import { test, expect } from "@playwright/test";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeArtifact } from "./support/runtime-artifacts";
import {
  smokeCredentials,
  startSmokeApp,
  stopSmokeApp,
} from "./support/smoke-app";

test("a copied project opens from its directory with its original identity and research", async ({
  page,
}) => {
  const first = await startSmokeApp();
  let second: Awaited<ReturnType<typeof startSmokeApp>> | undefined;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const directory = path.join(first.root, "original-research"),
      moved = path.join(first.root, "copied-research");
    await mkdir(directory);
    await writeFile(path.join(directory, "train.py"), "print('preserved')\n");
    await page.request.post(first.app.url + "/api/auth/login", {
      data: smokeCredentials,
    });
    const created = await page.request.post(first.app.url + "/api/projects", {
      data: { name: "可移动研究项目", workspace: { kind: "local", directory } },
    });
    expect(created.status()).toBe(201);
    const project = (await created.json()).project;
    const note = await page.request.post(
      first.app.url + "/api/research-nodes",
      {
        headers: { "x-rw-project-id": project.id },
        data: { kind: "note", core: { nodeName: "随目录保留的研究笔记" } },
      },
    );
    expect(note.status()).toBe(201);
    const noteId = (await note.json()).node.id;
    await first.app.close();
    await cp(directory, moved, { recursive: true });
    second = await startSmokeApp();
    await page.request.post(second.app.url + "/api/auth/login", {
      data: smokeCredentials,
    });
    await page.goto(second.app.url + "/#/project-create");
    await page
      .getByRole("radio", { name: "本机已有目录", exact: true })
      .check();
    const field = page.getByRole("textbox", { name: "本机目录", exact: true });
    await field.fill(moved);
    await field.blur();
    await expect(
      page.getByText("发现项目：可移动研究项目", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "项目名称", exact: true }),
    ).toHaveValue(project.name);
    await expect(
      page.getByText(path.join(moved, ".topolumia"), { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: runtimeArtifact("self-review/project-open-existing-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 375, height: 812 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: runtimeArtifact("self-review/project-open-existing-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "打开项目", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "研究总览", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        localStorage.getItem("research-workbench-project"),
      ),
    ).toBe(project.id);
    const notes = await page.request.get(
      second.app.url +
        "/api/research-nodes/" +
        encodeURIComponent(noteId) +
        "?projectId=" +
        project.id,
    );
    expect(notes.status()).toBe(200);
    expect(await notes.text()).toContain("随目录保留的研究笔记");
    expect(await readFile(path.join(moved, "train.py"), "utf8")).toBe(
      "print('preserved')\n",
    );
    expect(errors).toEqual([]);
  } finally {
    if (second) await stopSmokeApp(second.app, second.root);
    await stopSmokeApp(first.app, first.root);
  }
});
