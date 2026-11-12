import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startMvpServer } from "../../dist/src/server.js";

let app, root: string;
const password = "OpenCode-Version-Config-2026!";
test.beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "topolumia-opencode-versions-browser-"));
  app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: {
    project: { workspacesRoot: path.join(root, "workspaces") }, sourceRefresh: { enabled: false }, agentSessions: { profiles: [
      { id: "opencode-acp", provider: "opencode", label: "OpenCode 1（旧版）", driver: "opencode-server-v1", command: process.execPath, versionArgs: ["-e", "console.log('1.19.0')"] },
      { id: "opencode-v2", provider: "opencode", label: "OpenCode 2", driver: "opencode-server-v2", command: process.execPath, versionArgs: ["-e", "console.log('2.2.7')"] },
    ] },
  } });
  app.collaboration.bootstrapAdmin({ username: "versions", password });
});
test.afterAll(async () => { await app?.close(); if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

test("the V1 and V2 editors retain independent configuration and V1 identity", async ({ page }) => {
  await page.request.post(`${app.url}/api/auth/login`, { data: { username: "versions", password } });
  await page.goto(`${app.url}/#/agent-settings`);
  const oldUrl = `${app.url}/api/agent-configuration/profiles/opencode-acp/native-config`;
  const old = await (await page.request.get(oldUrl)).json();
  expect(old.configKey).toBe("opencode");
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "OpenCode 2", exact: true }) });
  await card.getByRole("button", { name: "配置", exact: true }).click();
  const source = page.getByLabel("配置文件内容", { exact: true });
  const content = '// V2 native rules\n{"model":"lab/new","permissions":[{"action":"shell","resource":"rm *","effect":"deny"}],"providers":{"lab":{"settings":{"baseURL":"https://fixture.invalid"}}}}';
  await source.fill(content); await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await (await page.request.get(oldUrl)).json()).content).toBe(old.content);
  await card.getByRole("button", { name: "配置", exact: true }).click(); await expect(source).toHaveValue(content);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  const v1 = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "OpenCode 1（旧版）", exact: true }) });
  await v1.getByRole("button", { name: "配置", exact: true }).click();
  await expect(source).toHaveValue(old.content);
});
