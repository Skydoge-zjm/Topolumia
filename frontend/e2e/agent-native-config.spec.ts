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
    const engine = page.getByRole("tab", { name: new RegExp("^" + label) });
    await engine.click();
    const settings = page.getByTestId("agent-configuration-page");
    await expect(settings.getByRole("tab", { name: "完整配置项" })).toBeVisible();
    if (provider === "codex") {
      const desktop = await settings.boundingBox();
      await page.setViewportSize({ width: 1920, height: 960 });
      const wide = await settings.boundingBox();
      const main = await page.getByRole("main").evaluate((element) => ({
        left: element.getBoundingClientRect().left,
        width: element.clientWidth,
      }));
      expect(wide!.width).toBeGreaterThan(desktop!.width + 250);
      const leftGap = wide!.x - main.left;
      const rightGap = main.left + main.width - wide!.x - wide!.width;
      expect(leftGap).toBeGreaterThan(32);
      expect(Math.abs(leftGap - rightGap)).toBeLessThan(2);
    }
    await settings.getByRole("tab", { name: /^原生文件/ }).click();
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
    await settings.getByLabel("配置文件内容", { exact: true }).fill(content);
    await settings.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(settings.getByText(/原生配置已保存/)).toBeVisible();
    const saved = await (
      await page.request.get(
        app.url + `/api/agent-configuration/profiles/${provider}/native-config`,
      )
    ).json();
    expect(saved.content).toBe(content);
    expect(await readFile(saved.path, "utf8")).toBe(content);
    expect(saved.path).toContain("agent-config");
    await page.reload();
    await engine.click();
    await settings.getByRole("tab", { name: /^原生文件/ }).click();
    await expect(page.getByLabel("配置文件内容", { exact: true })).toHaveValue(
      content,
    );
    expect(
      await page
        .getByLabel("配置文件内容", { exact: true })
        .evaluate((element) => getComputedStyle(element).fontFamily),
    ).toMatch(/monospace/i);
    await page.screenshot({
      path: runtimeArtifact(`agent-native-${provider}.png`),
      fullPage: true,
    });
  });
test("native text supports nested options, syntax errors and stale-save recovery", async ({
  page,
}) => {
  await page.getByRole("tab", { name: /^Codex/ }).click();
  const settings = page.getByTestId("agent-configuration-page");
  await settings.getByRole("tab", { name: /^原生文件/ }).click();
  await settings
    .getByLabel("配置文件内容", { exact: true })
    .fill(
      'model = "gpt-6-luna"\n[mcp_servers.papers]\ncommand = "python"\nargs = ["-m", "paper_server"]\n',
    );
  await settings.getByRole("tab", { name: "常用设置", exact: true }).click();
  await settings
    .getByRole("combobox", { name: "默认模型", exact: true })
    .fill("custom-model");
  await settings.getByRole("tab", { name: /^原生文件/ }).click();
  const text = await settings
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
  await settings.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(settings.getByRole("alert")).toContainText("配置已被修改");
  page.once("dialog", (dialog) => dialog.accept());
  await settings.getByRole("button", { name: "重新载入", exact: true }).click();
  await expect(settings.getByLabel("配置文件内容", { exact: true })).toHaveValue(
    /Another writer/,
  );
  await settings
    .getByLabel("配置文件内容", { exact: true })
    .fill('model = "unterminated');
  await expect(
    settings.getByRole("button", { name: "保存配置", exact: true }),
  ).toBeDisabled();
});
test("common model edits update native files and Agent settings stay out of workspace settings", async ({
  page,
}) => {
  await page.getByRole("tab", { name: /^Claude Code/ }).click();
  const settings = page.getByTestId("agent-configuration-page");
  const configPath = settings.locator('code[title$="settings.json"]');
  const copy = settings.getByRole("button", { name: "复制配置文件路径" });
  await expect(configPath).toHaveCSS("white-space", "nowrap");
  await expect(configPath).toHaveCSS("text-overflow", "ellipsis");
  await expect(copy).toBeVisible();
  const pathBounds = await configPath.boundingBox();
  expect(pathBounds!.width).toBeGreaterThan(400);
  const save = settings.getByRole("button", { name: "保存配置", exact: true });
  await expect(save).toBeDisabled();
  await expect(settings.locator("form > footer")).toHaveCSS(
    "background-color",
    "rgb(250, 251, 251)",
  );
  await expect(settings.getByRole("tablist", { name: "Agent 引擎" })).toHaveCSS(
    "background-color",
    "rgb(247, 250, 248)",
  );
  await settings.getByRole("radio", { name: "指定模型" }).check();
  await settings
    .getByRole("combobox", { name: "默认模型", exact: true })
    .fill("inline-model");
  await expect(save).toBeEnabled();
  await expect(save).toHaveCSS("background-color", "rgb(19, 77, 54)");
  await expect(save).toHaveCSS("color", "rgb(255, 255, 255)");
  await save.click();
  await expect(settings.getByText(/原生配置已保存/)).toBeVisible();
  const saved = await (
    await page.request.get(
      app.url + "/api/agent-configuration/profiles/claude/native-config",
    )
  ).json();
  expect(
    parseNativeConfig("claude", await readFile(saved.path, "utf8")).model,
  ).toBe("inline-model");
  await page.getByRole("link", { name: "工作区设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Codex 沙箱", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "审批策略", exact: true }),
  ).toHaveCount(0);
});
