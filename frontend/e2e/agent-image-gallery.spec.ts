import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../dist/src/server.js";

test("Codex image views form a thumbnail gallery with a dismissible full image and scoped file access", async ({
  page,
}) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "topolumia-image-gallery-"),
  );
  const images: string[] = [];
  // Real PNG files with varied dimensions exercise image loading and object-fit.
  for (let index = 0; index < 6; index++) {
    const png = await page.evaluate((index) => {
      const canvas = document.createElement("canvas");
      canvas.width = index % 2 ? 600 : 900;
      canvas.height = index % 2 ? 720 : 500;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#f4faf7";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#154f41";
      ctx.font = "bold 30px sans-serif";
      ctx.fillText(`Figure ${index + 1} · Research workflow`, 32, 60);
      for (let step = 0; step < 3; step++) {
        ctx.fillStyle = ["#cce9dc", "#b2dccc", "#92cdb7"][step];
        ctx.fillRect(40, 110 + step * 110, canvas.width - 80, 80);
        ctx.fillStyle = "#154f41";
        ctx.font = "24px sans-serif";
        ctx.fillText(
          ["Read source", "Inspect evidence", "Review findings"][step],
          64,
          160 + step * 110,
        );
      }
      return canvas.toDataURL("image/png").split(",")[1];
    }, index);
    const file = path.join(root, `figure-${index + 1}.png`);
    await writeFile(file, Buffer.from(png, "base64"));
    images.push(file);
  }
  const notImage = path.join(root, "notes.png");
  await writeFile(notImage, "This is private text, not a PNG.");
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
            id: "gallery-codex",
            label: "Codex",
            provider: "codex",
            driver: "codex-app-server",
            command: process.execPath,
            args: [path.resolve("fixtures/trace-audit/native-wire.mjs")],
            env: {
              TOPOLUMIA_TRACE_AUDIT_CASE: "codex-image-views",
              TOPOLUMIA_TRACE_AUDIT_IMAGES: JSON.stringify([
                ...images,
                notImage,
              ]),
            },
          },
        ],
      },
    },
  });
  try {
    const credentials = {
      username: "gallery",
      password: "Gallery-Fixture-Only-2026!",
    };
    await page.request.post(`${app.url}/api/auth/bootstrap`, {
      data: { ...credentials, displayName: "Researcher" },
    });
    await page.request.post(`${app.url}/api/auth/login`, { data: credentials });
    const created = await page.request.post(`${app.url}/api/agent-sessions`, {
      data: { profileId: "gallery-codex", title: "论文图像检查" },
    });
    expect(created.ok()).toBe(true);
    const session = await created.json();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${app.url}/#/agents`);
    await expect(
      page.getByRole("heading", { name: "论文图像检查", exact: true }),
    ).toBeVisible();
    const input = page.getByRole("textbox", { name: "研究消息" });
    await input.fill("检查论文图像");
    await input.press("Enter");
    await expect(
      page.getByText("图像检查完成。", { exact: true }),
    ).toBeVisible();
    const galleries = page.locator(".image-view-group");
    await expect(galleries).toHaveCount(2);
    await expect(galleries.nth(0).locator("summary")).toHaveText(
      "查看6张图像完成",
    );
    await expect(galleries.nth(0).locator(".agent-image-tile")).toHaveCount(0);
    await galleries.nth(0).locator("summary").click();
    const thumbs = galleries.nth(0).locator(".agent-image-thumbnail img");
    await expect(thumbs).toHaveCount(6);
    await expect
      .poll(() =>
        thumbs.evaluateAll((nodes) =>
          nodes.every((node) => (node as HTMLImageElement).naturalWidth > 0),
        ),
      )
      .toBe(true);
    const rows = await thumbs.evaluateAll(
      (nodes) =>
        new Set(
          nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
        ).size,
    );
    expect(rows).toBeGreaterThan(1);
    await page.screenshot({
      path: "test-results/agent-image-gallery.png",
      fullPage: true,
    });

    const tile = galleries
      .nth(0)
      .getByRole("button", { name: "放大查看 figure-2.png", exact: true });
    await tile.click();
    const dialog = page.getByRole("dialog", { name: "figure-2.png" });
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        dialog
          .locator("img")
          .evaluate((node: HTMLImageElement) => node.naturalWidth),
      )
      .toBe(600);
    expect((await dialog.locator("img").boundingBox())!.height).toBeGreaterThan(
      (await thumbs.nth(1).boundingBox())!.height,
    );
    await page.screenshot({
      path: "test-results/agent-image-full.png",
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "关闭大图", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(tile).toBeFocused();
    await tile.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    const snapshot = await (
      await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)
    ).json();
    const event = snapshot.conversationEvents.find(
      (event) =>
        event.type === "tool.completed" &&
        event.payload.item?.path === images[0],
    );
    const imageUrl = `${app.url}/api/agent-sessions/${session.id}/images/${event.id}`;
    expect((await fetch(imageUrl)).status).toBe(401);
    const content = await page.request.get(imageUrl);
    expect(content.headers()["content-type"]).toBe("image/png");
    expect(content.headers()["x-content-type-options"]).toBe("nosniff");
    expect(
      (
        await page.request.get(
          `${imageUrl}?path=${encodeURIComponent(notImage)}`,
        )
      ).status(),
    ).toBe(200);
    expect(
      (
        await page.request.get(
          `${app.url}/api/agent-sessions/${session.id}/images/unknown`,
        )
      ).status(),
    ).toBe(404);
    await galleries.nth(1).locator("summary").click();
    await expect(galleries.nth(1).getByText("图像无法读取")).toBeVisible();
    await rm(images[0]);
    expect((await page.request.get(imageUrl)).status()).toBe(200);

    await page.getByRole("button", { name: "语言", exact: true }).click();
    await page.getByRole("option", { name: "English", exact: true }).click();
    await expect(galleries.nth(0).locator("summary")).toHaveText(
      "View 6 imagesDone",
    );
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
