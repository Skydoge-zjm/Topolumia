import { runtimeArtifact } from "./support/runtime-artifacts";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../dist/src/server.js";
import { parseNativeConfig } from "../../dist/src/services/agents/configuration/native-format.js";
let app: any, root: string;
const password = "Native-Config-Browser-2026!";
test.beforeAll(async () => {
  root = await mkdtemp(
    path.join(os.tmpdir(), "topolumia-native-config-browser-"),
  );
  const databaseFile = path.join(root, "db.sqlite");
  app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: databaseFile,
    userSettingsFile: path.join(root, "settings.json"),
    config: {
      sourceRefresh: { enabled: false },
      agentSessions: {
        profiles: ["codex", "claude", "opencode"].map((provider, index) => ({
          id: provider,
          label: ["Codex", "Claude Code", "OpenCode"][index],
          provider,
          command: process.execPath,
          versionArgs: ["--version"],
          model: "gpt-6-luna",
          models: [{ id: "gpt-6-luna", label: "Luna" }],
        })),
      },
    },
  });
  app.collaboration.bootstrapAdmin({
    username: "native-config-browser",
    password,
  });
});
test.afterAll(async () => {
  for (const runtime of app.runtimes.values()) {
    await runtime.agentSessionGateway.closeAll();
    await runtime.toolEnvironment.catalog.close();
    await runtime.toolEnvironment.research.close();
  }
  await app.sshEnvironments.close();
  await app.sshConnections.close();
  app.server.closeAllConnections();
  await new Promise<void>((resolve) => app.server.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});
test.beforeEach(async ({ page }) => {
  await page.request.post(app.url + "/api/auth/login", {
    data: { username: "native-config-browser", password },
  });
  await page.goto(app.url + "/#/agent-settings");
});
for (const [provider, label] of [
  ["codex", "Codex"],
  ["claude", "Claude Code"],
  ["opencode", "OpenCode"],
])
  test(`${label} edits its full native configuration and reloads the actual data file`, async ({
    page,
  }) => {
    const card = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: label, exact: true }) });
    await card.getByRole("button", { name: "配置", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("combobox", { name: "默认模型", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByLabel("配置文件内容", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "全部配置项", exact: true }),
    ).toHaveCount(0);
    const bounds = await dialog.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(700);
    expect(bounds!.height).toBeLessThanOrEqual(700);
    const content =
      provider === "codex"
        ? '# Native browser configuration\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n[features]\nresearch_custom_flag = true\n'
        : provider === "claude"
          ? JSON.stringify(
              {
                model: "gpt-6-luna",
                effortLevel: "high",
                permissions: { allow: ["Read"], deny: ["Read(.env)"] },
                env: { CUSTOM_PROVIDER: "lab" },
              },
              null,
              2,
            )
          : '// JSONC native config\n{"model":"lab/gpt-6-luna","permission":{"bash":"ask"},"provider":{"lab":{"options":{"baseURL":"https://lab.example/v1"}}},}\n';
    await dialog.getByLabel("配置文件内容", { exact: true }).fill(content);
    await dialog.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = await (
      await page.request.get(
        app.url + `/api/agent-configuration/profiles/${provider}/native-config`,
      )
    ).json();
    expect(saved.content).toBe(content);
    expect(await readFile(saved.path, "utf8")).toBe(content);
    expect(saved.path).toContain("agent-config");
    await page.reload();
    await card.getByRole("button", { name: "配置", exact: true }).click();
    await expect(page.getByLabel("配置文件内容", { exact: true })).toHaveValue(
      content,
    );
    expect(
      await page
        .getByLabel("配置文件内容", { exact: true })
        .evaluate((element) => getComputedStyle(element).fontFamily),
    ).not.toMatch(/monospace/i);
    await page.screenshot({
      path: runtimeArtifact(`agent-native-${provider}.png`),
      fullPage: true,
    });
  });
test("native text supports nested options, syntax errors and stale-save recovery", async ({
  page,
}) => {
  const card = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Codex", exact: true }) });
  await card.getByRole("button", { name: "配置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("配置文件内容", { exact: true })
    .fill(
      'model = "gpt-6-luna"\n[mcp_servers.papers]\ncommand = "python"\nargs = ["-m", "paper_server"]\n',
    );
  await dialog
    .getByRole("combobox", { name: "默认模型", exact: true })
    .fill("custom-model");
  const text = await dialog
    .getByLabel("配置文件内容", { exact: true })
    .inputValue();
  expect(parseNativeConfig("codex", text)).toMatchObject({
    model: "custom-model",
    mcp_servers: {
      papers: { command: "python", args: ["-m", "paper_server"] },
    },
  });
  const stale = await (
    await page.request.get(
      app.url + "/api/agent-configuration/profiles/codex/native-config",
    )
  ).json();
  await page.request.put(
    app.url + "/api/agent-configuration/profiles/codex/native-config",
    {
      data: {
        content: stale.content + "\n# Another writer\n",
        expectedRevision: stale.revision,
      },
    },
  );
  await dialog.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("配置已被修改");
  page.once("dialog", (dialog) => dialog.accept());
  await dialog.getByRole("button", { name: "重新载入", exact: true }).click();
  await expect(dialog.getByLabel("配置文件内容", { exact: true })).toHaveValue(
    /Another writer/,
  );
  await dialog
    .getByLabel("配置文件内容", { exact: true })
    .fill('model = "unterminated');
  await expect(
    dialog.getByRole("button", { name: "保存配置", exact: true }),
  ).toBeDisabled();
});
test("common model edits update native files and Agent settings stay out of workspace settings", async ({
  page,
}) => {
  const card = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Claude Code", exact: true }),
  });
  await card.getByRole("button", { name: "配置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "默认模型", exact: true })
    .fill("gpt-6-luna");
  await dialog.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await (
    await page.request.get(
      app.url + "/api/agent-configuration/profiles/claude/native-config",
    )
  ).json();
  expect(
    parseNativeConfig("claude", await readFile(saved.path, "utf8")).model,
  ).toBe("gpt-6-luna");
  await page.getByRole("link", { name: "工作区设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Codex 沙箱", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "审批策略", exact: true }),
  ).toHaveCount(0);
});
