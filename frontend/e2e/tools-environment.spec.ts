import { test, expect } from "@playwright/test";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../dist/src/server.js";

let app;
let root: string;
let provider: http.Server;
let providerUrl: string;
let hits = 0;
let packageReads = 0;
let prefixes: string[];
test.beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "topolumia-tools-browser-"));
  provider = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" });
    const name = new URL(req.url!, "http://fixture").searchParams.get(
      "experiment_name",
    );
    res.end(JSON.stringify({ experiment: { experiment_id: "1", name } }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const databaseFile = path.join(root, "db.sqlite");
  app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: databaseFile,
    userSettingsFile: path.join(root, "settings.json"),
    config: {
      project: { workspacesRoot: path.join(root, "workspaces") },
      collaboration: { databaseFile },
      sourceRefresh: { enabled: false },
      docker: { command: process.execPath },
      toolCommands: {
        conda: process.execPath,
        uv: process.execPath,
        nvidia: process.execPath,
        cuda: process.execPath,
      },
      agentSessions: {
        profiles: ["Codex", "Claude Code", "OpenCode"].map((label, index) => ({
          id: ["codex-audit", "claude-audit", "opencode-audit"][index],
          label,
          provider: ["codex", "claude", "opencode"][index],
          driver: "acp-stdio",
          command: process.execPath,
          args: [path.resolve("dist/fixtures/acp/research-agent.js")],
          versionArgs: ["--version"],
          model: "gpt-6-luna",
          models: [{ id: "gpt-6-luna", label: "6 Luna" }],
        })),
      },
    },
  });
  prefixes = [
    path.join(root, "conda base"),
    path.join(root, "analysis"),
    path.join(root, "training"),
  ];
  for (const prefix of prefixes) {
    const executable = path.join(
      prefix,
      process.platform === "win32" ? "python.exe" : "bin/python",
    );
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
  }
  app.toolEnvironment.commandRunner = async (_command, args) => {
    if (args[0] === "info")
      return {
        ok: true,
        stdout: JSON.stringify({
          conda_version: "26.1.0",
          root_prefix: prefixes[0],
          envs: prefixes,
        }),
        stderr: "",
      };
    if (args[0] === "list") {
      packageReads++;
      return {
        ok: true,
        stdout: JSON.stringify([
          { name: "openssl", version: "3.4.0", channel: "conda-forge" },
          ...Array.from({ length: 122 }, (_, i) => ({
            name: `pkg-${String(i).padStart(3, "0")}`,
            version: `${i}.0.0`,
            channel: i % 2 ? "pypi" : "conda-forge",
          })),
        ]),
        stderr: "",
      };
    }
    const mode = args.at(-1);
    if (!["identity", "packages"].includes(mode))
      return { ok: false, stdout: "", stderr: "" };
    const prefix = args.includes("--prefix")
      ? args[args.indexOf("--prefix") + 1]
      : prefixes[0];
    const payload = {
      status: "ready",
      python: {
        executable: path.join(
          prefix,
          process.platform === "win32" ? "python.exe" : "bin/python",
        ),
        prefix,
        basePrefix: prefixes[0],
        version: prefix === prefixes[2] ? "3.11.8" : "3.12.9",
        kind: "conda",
      },
      packages: {
        wandb: prefix === prefixes[2] ? "0.19.0" : "0.20.1",
        tensorboard: "2.19.0",
      },
      executables: {},
    };
    return {
      ok: true,
      stdout: `TOPOLUMIA_PYTHON_PROBE:${JSON.stringify(payload)}\n`,
      stderr: "",
    };
  };
  app.collaboration.bootstrapAdmin({
    username: "tools-audit",
    password: "Tools-Browser-Audit-2026!",
  });
});
test.afterAll(async () => {
  await app?.toolEnvironment.catalog.close();
  await app?.toolEnvironment.research.close();
  await app?.agentSessionGateway.closeAll();
  app?.server.closeAllConnections();
  if (app)
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  provider?.closeAllConnections();
  if (provider)
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

test("progressive environment tree preserves browsing context and keeps connection configuration reachable", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.request.post(`${app.url}/api/auth/login`, {
    data: { username: "tools-audit", password: "Tools-Browser-Audit-2026!" },
  });
  const before = (
    await (await page.request.get(`${app.url}/api/settings`)).json()
  ).settings.researchEnvironment;
  await page.goto(`${app.url}/#/tools`);
  const tree = page.getByRole("table", { name: "科研环境列表" });
  await expect(tree).toBeVisible();
  await expect(tree.getByRole("row")).toHaveCount(4);
  await expect(
    page.getByRole("button", { name: "展开环境 analysis" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Conda", exact: true }).click();
  await page
    .getByRole("button", { name: "展开环境 analysis", exact: true })
    .click();
  await expect(tree.getByText("0.20.1", { exact: true })).toBeVisible();
  expect(
    (await (await page.request.get(`${app.url}/api/settings`)).json()).settings
      .researchEnvironment,
  ).toEqual(before);
  await expect(
    page.getByRole("button", { name: "查看所有包及版本", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/environment-tree-desktop.png",
    fullPage: true,
  });
  await page.locator("summary").filter({ hasText: "项目服务连接" }).click();
  await page
    .getByRole("button", { name: "查看 MLflow 详情", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "MLflow", exact: true });
  await dialog
    .getByRole("textbox", { name: "服务地址", exact: true })
    .fill(providerUrl);
  await dialog.getByRole("button", { name: "保存并测试", exact: true }).click();
  await expect(dialog.getByText("可用", { exact: true }).first()).toBeVisible();
  expect(hits).toBe(1);
  await dialog.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.locator("summary").filter({ hasText: "Topolumia 运行时" }).click();
  await expect(
    page.getByRole("button", { name: "查看 Node.js 详情", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/environment-tree-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("Agent configuration owns runtime checks, default models and navigation to research sessions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(
    (
      await page.request.post(`${app.url}/api/auth/login`, {
        data: {
          username: "tools-audit",
          password: "Tools-Browser-Audit-2026!",
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`${app.url}/#/tools`);
  await page.getByRole("link", { name: "Agent 配置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Agent 配置", exact: true }),
  ).toBeVisible();
  for (const name of ["Codex", "Claude Code", "OpenCode", "科研 MCP"])
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Python", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "检查全部 Agent", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "检查全部 Agent", exact: true }),
  ).toBeEnabled({ timeout: 20000 });
  const codex = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Codex", exact: true }) });
  await expect(codex.getByText("可用", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      /^科研 MCP 握手、授权与 CLI 往返通过；\d+ 个工具，使用只读凭据探测。$/,
    ),
  ).toBeVisible();
  await codex.getByRole("button", { name: "配置", exact: true }).click();
  await page.getByRole("button", { name: "显示模型建议", exact: true }).click();
  await expect(
    page.getByRole("listbox", { name: "默认模型", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/model-suggestions-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("combobox", { name: "默认模型", exact: true })
    .press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("combobox", { name: "默认模型", exact: true })
    .press("ArrowDown");
  await page.getByRole("option", { name: /gpt-6-luna/ }).click();
  await page
    .getByRole("combobox", { name: "默认模型", exact: true })
    .fill("fixture-project-model");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    codex.getByText("fixture-project-model", { exact: true }),
  ).toBeVisible();
  const opencode = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "OpenCode", exact: true }),
  });
  await opencode.getByRole("button", { name: "设为默认", exact: true }).click();
  await expect(opencode.getByText("默认 Agent", { exact: true })).toBeVisible();
  const settings = await (
    await page.request.get(`${app.url}/api/settings`)
  ).json();
  expect(settings.settings.agent.defaultProfileId).toBe("opencode-audit");
  const nativeCodex = await (await page.request.get(`${app.url}/api/agent-configuration/profiles/codex-audit/native-config`)).json();
  expect(nativeCodex.content).toContain('model = "fixture-project-model"');
  await page.screenshot({
    path: "test-results/agent-configuration-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const navigation = page.getByRole("complementary").getByRole("navigation");
  await expect(navigation).toBeVisible();
  await page.screenshot({
    path: "test-results/agent-configuration-mobile.png",
    fullPage: true,
  });
  await navigation
    .getByRole("link", { name: "工具与环境", exact: true })
    .click();
  await expect(page.getByRole("table", { name: "科研环境列表" })).toBeVisible();
  await navigation
    .getByRole("link", { name: "Agent 配置", exact: true })
    .click();
  await navigation
    .getByRole("link", { name: "Agent 会话", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Agent 会话", level: 2, exact: true }),
  ).toBeVisible();
});

test("SSH editor uses shared menus for connection and authentication, including narrow screens", async ({
  page,
}) => {
  await page.request.post(`${app.url}/api/auth/login`, {
    data: { username: "tools-audit", password: "Tools-Browser-Audit-2026!" },
  });
  await page.goto(`${app.url}/#/tools`);
  await page.getByRole("button", { name: "SSH管理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "SSH 连接", exact: true });
  await dialog
    .getByRole("button", { name: "添加 SSH 连接", exact: true })
    .click();
  await dialog.getByRole("button", { name: "配置方式", exact: true }).click();
  await expect(
    dialog.getByRole("listbox", { name: "配置方式", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/ssh-method-menu-desktop.png",
    fullPage: true,
  });
  await dialog
    .getByRole("option", { name: "手动填写主机", exact: true })
    .click();
  await dialog.getByRole("button", { name: "认证方式", exact: true }).click();
  await expect(
    dialog.getByRole("listbox", { name: "认证方式", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("option", { name: "私钥文件", exact: true }).click();
  await expect(dialog.getByPlaceholder("~/.ssh/id_ed25519")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole("button", { name: "认证方式", exact: true }).click();
  await page.screenshot({
    path: "test-results/ssh-auth-menu-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await dialog
    .getByRole("button", { name: "认证方式", exact: true })
    .press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("select, datalist")).toHaveCount(0);
});

test("all-package inventory is searchable and paginated, while use-environment remains an explicit action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.request.post(`${app.url}/api/auth/login`, {
    data: { username: "tools-audit", password: "Tools-Browser-Audit-2026!" },
  });
  const before = (
    await (await page.request.get(`${app.url}/api/settings`)).json()
  ).settings.researchEnvironment;
  await page.goto(`${app.url}/#/tools`);
  await page.getByRole("button", { name: "Conda", exact: true }).click();
  await page
    .getByRole("button", { name: "展开环境 training", exact: true })
    .click();
  await expect(page.getByText("0.19.0", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "查看所有包及版本", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "training · 全部包与版本",
    exact: true,
  });
  await expect(
    dialog.getByRole("rowheader", { name: "openssl", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("3.4.0", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("匹配 123 项 / 共 123 个包", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "下一页包", exact: true }).click();
  await dialog.getByRole("button", { name: "下一页包", exact: true }).click();
  await expect(
    dialog.getByRole("rowheader", { name: "pkg-121", exact: true }),
  ).toBeVisible();
  const reads = packageReads;
  await dialog
    .getByRole("searchbox", { name: "搜索包名", exact: true })
    .fill("openssl");
  await expect(
    dialog.getByText("匹配 1 项 / 共 123 个包", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("rowheader", { name: "openssl", exact: true }),
  ).toBeVisible();
  expect(packageReads).toBe(reads);
  await page.screenshot({
    path: "test-results/environment-packages-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    dialog.getByRole("searchbox", { name: "搜索包名", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/environment-packages-mobile.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "关闭包清单", exact: true }).click();
  expect(
    (await (await page.request.get(`${app.url}/api/settings`)).json()).settings
      .researchEnvironment,
  ).toEqual(before);
  const row = page.getByRole("row").filter({
    has: page.getByRole("button", { name: "展开环境 training", exact: true }),
  });
  await row.getByRole("button", { name: "设为当前", exact: true }).click();
  await expect(
    page.getByText("项目当前环境已更新。查看其它环境仍可继续。", {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (await (await page.request.get(`${app.url}/api/settings`)).json()).settings
      .researchEnvironment.prefix,
  ).toBe(prefixes[2]);
  await page.reload();
  await expect(
    page.locator("strong").filter({ hasText: /Conda \/ training$/ }),
  ).toBeVisible();
});

test("SSH alias discovers real remote environments and packages without changing the project environment", async ({
  page,
}) => {
  test.skip(
    !process.env.TOPOLUMIA_TEST_SSH_ALIAS,
    "Set TOPOLUMIA_TEST_SSH_ALIAS to an authorized SSH alias",
  );
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.request.post(`${app.url}/api/auth/login`, {
    data: { username: "tools-audit", password: "Tools-Browser-Audit-2026!" },
  });
  const current = (
    await (await page.request.get(`${app.url}/api/ssh/connections`)).json()
  ).current;
  await page.goto(`${app.url}/#/tools`);
  await page.getByRole("button", { name: "SSH管理", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "SSH 连接", exact: true });
  await manager
    .getByRole("button", { name: "添加 SSH 连接", exact: true })
    .click();
  await manager
    .getByRole("textbox", { name: "连接名称", exact: true })
    .fill("Remote browser test");
  await manager
    .getByLabel("SSH 别名", { exact: true })
    .fill(process.env.TOPOLUMIA_TEST_SSH_ALIAS!);
  await manager.getByRole("button", { name: "解析配置", exact: true }).click();
  await expect(manager.getByText(/@127.0.0.1:2222/)).toBeVisible();
  await manager
    .getByRole("button", { name: "保存并连接", exact: true })
    .click();
  await expect(
    manager.getByRole("button", { name: "查看环境", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page.screenshot({
    path: "test-results/ssh-connections-desktop.png",
    fullPage: true,
  });
  await manager.getByRole("button", { name: "查看环境", exact: true }).click();
  await page.getByRole("button", { name: "查看位置", exact: true }).click();
  const locations = page.getByRole("listbox", {
    name: "查看位置",
    exact: true,
  });
  await expect(locations.getByRole("option")).toHaveCount(2);
  await page.screenshot({
    path: "test-results/ssh-location-menu-desktop.png",
    fullPage: true,
  });
  await locations
    .getByRole("option", { name: "Remote browser test · 已连接", exact: true })
    .click();
  await page.getByRole("button", { name: "远程 Python", exact: true }).click();
  const python = page.getByRole("button", { name: /^展开环境 Python / });
  await python.first().click();
  await expect(page.getByText("3.12.3", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page
    .getByRole("button", { name: "查看所有包及版本", exact: true })
    .click();
  const packages = page.getByRole("dialog", { name: /全部包与版本/ });
  await expect(packages.getByText(/共 \d+ 个包/)).toBeVisible({
    timeout: 20000,
  });
  await packages
    .getByRole("button", { name: "关闭包清单", exact: true })
    .click();
  await page.getByRole("button", { name: "Conda", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "展开环境 base", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.screenshot({
    path: "test-results/ssh-environments-desktop.png",
    fullPage: true,
  });
  expect(
    (await (await page.request.get(`${app.url}/api/ssh/connections`)).json())
      .current,
  ).toEqual(current);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/ssh-environments-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "SSH管理", exact: true }).click();
  await manager.getByRole("button", { name: "断开", exact: true }).click();
  await manager
    .getByRole("button", { name: "关闭 SSH 连接", exact: true })
    .click();
  await expect(page.getByText(/查看已保存结果/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "展开环境 base", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
