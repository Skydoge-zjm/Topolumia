import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { startMvpServer } from "../../dist/src/server.js";

for (const provider of ["codex", "claude"] as const) {
  test(`${provider}: paste, remove, send and reload image messages with native image input`, async ({
    page,
    context,
  }) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), `topolumia-${provider}-image-input-`),
    );
    const capture = path.join(root, "native-input.jsonl");
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
              id: "image-agent",
              label: provider,
              provider,
              driver:
                provider === "codex" ? "codex-app-server" : "claude-cli-stream",
              command: process.execPath,
              ...(provider === "codex"
                ? {
                    args: [
                      path.resolve("fixtures/trace-audit/native-wire.mjs"),
                    ],
                  }
                : {
                    launcherArgs: [
                      path.resolve("fixtures/trace-audit/native-wire.mjs"),
                    ],
                  }),
              env: {
                TOPOLUMIA_TRACE_AUDIT_CASE: `${provider}-image-input`,
                TOPOLUMIA_TRACE_AUDIT_INPUT: capture,
              },
            },
          ],
        },
      },
    });
    try {
      const credentials = {
        username: "images",
        password: "Images-Fixture-Only-2026!",
      };
      await page.request.post(`${app.url}/api/auth/bootstrap`, {
        data: { ...credentials, displayName: "Researcher" },
      });
      await page.request.post(`${app.url}/api/auth/login`, {
        data: credentials,
      });
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const created = await page.request.post(`${app.url}/api/agent-sessions`, {
        data: { profileId: "image-agent", title: "论文截图讨论" },
      });
      expect(created.ok()).toBe(true);
      const session = await created.json();
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${app.url}/#/agents`);
      await expect(
        page.getByRole("heading", { name: "论文截图讨论", exact: true }),
      ).toBeVisible();
      const png = await page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 480;
        canvas.height = 240;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#e8f4ee";
        ctx.fillRect(0, 0, 480, 240);
        ctx.fillStyle = "#154f41";
        ctx.font = "24px sans-serif";
        ctx.fillText("Figure 1: Training results", 30, 50);
        ctx.fillStyle = "#86bea7";
        ctx.fillRect(40, 90, 100, 100);
        ctx.fillRect(180, 120, 100, 70);
        ctx.fillRect(320, 140, 100, 50);
        const blob = await new Promise<Blob>((resolve) =>
          canvas.toBlob((blob) => resolve(blob!), "image/png"),
        );
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ]);
        return canvas.toDataURL("image/png").split(",")[1];
      });
      const input = page.getByRole("textbox", { name: "研究消息" });
      const paste = async () => {
        await input.focus();
        await input.press("Control+V");
        await expect(page.locator(".composer-image")).toHaveCount(1);
      };
      await paste();
      await page.locator(".composer-image button").click();
      await expect(page.locator(".composer-image")).toHaveCount(0);
      await paste();
      await page.screenshot({
        path: `test-results/agent-image-input-${provider}.png`,
        fullPage: true,
      });
      await input.fill("请解释这张图");
      await input.press("Enter");
      await expect(
        page.getByText("Image input received.", { exact: true }),
      ).toBeVisible();
      await expect(
        page.locator(".message.user .message-attachments img"),
      ).toHaveCount(1);
      await expect(page.locator(".composer-image")).toHaveCount(0);
      // Attach a second image without accompanying text.
      await expect(page.locator(".conversation-status")).toHaveAttribute(
        "data-session-status",
        "ready",
      );
      await paste();
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(
        page.getByText("Image input received.", { exact: true }),
      ).toHaveCount(2);
      await page.reload();
      const historyImages = page.locator(
        ".message.user .message-attachments img",
      );
      await expect(historyImages).toHaveCount(2);
      await expect
        .poll(() =>
          historyImages.evaluateAll((nodes) =>
            nodes.every(
              (node) => (node as HTMLImageElement).naturalWidth > 0 && (node as HTMLImageElement).naturalWidth <= 384,
            ),
          ),
        )
        .toBe(true);
      const saved = await (
        await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)
      ).json();
      const expectedImages = await Promise.all(
        saved.conversationEvents
          .filter((event) => event.type === "user.message")
          .map(async (event) => {
            const attachment = event.payload.attachments[0];
            const response = await page.request.get(
              `${app.url}/api/agent-sessions/${session.id}/attachments/${attachment.id}`,
            );
            expect(response.ok()).toBe(true);
            return createHash("sha256")
              .update(await response.body())
              .digest("hex");
          }),
      );
      const frames = (await readFile(capture, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (provider === "codex") {
        const turns = frames.filter((frame) => frame.method === "turn/start");
        expect(turns).toHaveLength(2);
        for (const [index, turn] of turns.entries()) {
          const image = turn.params.input.find(
            (part) => part.type === "localImage",
          );
          expect(
            createHash("sha256")
              .update(await readFile(image.path))
              .digest("hex"),
          ).toBe(expectedImages[index]);
        }
      } else {
        const messages = frames.filter((frame) => frame.type === "user");
        expect(messages).toHaveLength(2);
        for (const [index, frame] of messages.entries()) {
          const source = frame.message.content.find(
            (part) => part.type === "image",
          ).source;
          expect(source.type).toBe("base64");
          expect(source.media_type).toBe("image/png");
          expect(
            createHash("sha256")
              .update(Buffer.from(source.data, "base64"))
              .digest("hex"),
          ).toBe(expectedImages[index]);
        }
      }
      expect(JSON.stringify(saved).includes(png)).toBe(false);
      const attachment = saved.conversationEvents.find(
        (event) => event.type === "user.message",
      ).payload.attachments[0];
      const other = await (
        await page.request.post(`${app.url}/api/agent-sessions`, {
          data: { profileId: "image-agent" },
        })
      ).json();
      const crossSession = await page.request.post(
        `${app.url}/api/agent-sessions/${other.id}/turns`,
        { data: { text: "", attachmentIds: [attachment.id] } },
      );
      expect(crossSession.status()).toBe(404);
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
}
