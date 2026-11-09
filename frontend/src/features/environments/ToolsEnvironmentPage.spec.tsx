import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ToolsEnvironmentPage,
  type ToolsEnvironment,
  type ToolItem,
} from "./ToolsEnvironmentPage";
import type {
  CatalogEnvironment,
  EnvironmentCatalog,
} from "@/features/environments/types/environmentCatalog";
import type { ResearchEnvironment } from "@/features/environments/types/researchEnvironment";
import { useUiStore } from "@/shared/state/ui";

const a = "a".repeat(24),
  b = "b".repeat(24);
let permissions: string[],
  discoveryError: boolean,
  packageError: boolean,
  client: QueryClient;
let catalog: EnvironmentCatalog, inventory: ToolsEnvironment;
let reports: Record<string, ResearchEnvironment>;
let calls: Array<{
  path: string;
  method: string;
  body?: Record<string, unknown>;
}>;
let packagesReady: boolean;
function environment(id: string, name: string): CatalogEnvironment {
  return {
    id,
    cacheKey: "configuration",
    source: "conda",
    name,
    prefix: `E:/Conda/${name}`,
    pythonCommand: `E:/Conda/${name}/python.exe`,
    selection: { kind: "conda", prefix: `E:/Conda/${name}` },
    manager: "conda",
    hasPython: true,
    current: id === a,
    version: null,
    inspectionStatus: "idle",
    checkedAt: null,
  };
}
function tool(
  id: string,
  label: string,
  configuration: Record<string, string> | null = null,
): ToolItem {
  return {
    id,
    label,
    description: "",
    status: "unchecked",
    detail: "",
    checkedAt: null,
    recovery: null,
    configurable: Boolean(configuration),
    configuration,
    credential: null,
    category: id === "node" ? "application" : "development",
  };
}
const envs = [environment(a, "env-a"), environment(b, "env-b")];
beforeEach(() => {
  useUiStore.setState({ locale: "zh" });
  window.localStorage.setItem("research-workbench-project", "project-a");
  permissions = ["project.manageSettings"];
  discoveryError = false;
  packageError = false;
  packagesReady = false;
  calls = [];
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  catalog = {
    schemaVersion: "environment-catalog.v1",
    fingerprint: "configuration",
    current: { id: a, name: "env-a", selection: envs[0].selection },
    sources: [
      {
        id: "python",
        status: "unloaded",
        count: null,
        detail: null,
        environments: [],
      },
      {
        id: "conda",
        status: "unloaded",
        count: null,
        detail: null,
        environments: [],
      },
      {
        id: "venv",
        status: "unloaded",
        count: null,
        detail: null,
        environments: [],
      },
    ],
  };
  reports = Object.fromEntries(
    envs.map((env) => [
      env.id,
      {
        schemaVersion: "research-environment.v1",
        fingerprint: env.id,
        selection: env.selection,
        name: env.name,
        status: "idle",
        checkedAt: null,
        startedAt: null,
        stale: false,
        components: [],
      },
    ]),
  );
  inventory = {
    schemaVersion: "tools-environment.v3",
    project: { id: "project-a", name: "Project A", directory: "E:/Research" },
    location: "local",
    platform: "win32",
    environment: [
      tool("node", "Node.js"),
      tool("conda", "Conda", { command: "conda" }),
      tool("nvidia", "NVIDIA GPU / 驱动"),
    ],
    tools: [
      tool("git", "Git"),
      tool("docker", "Docker"),
      {
        ...tool("mlflow", "MLflow", {
          baseUrl: "",
          experimentName: "Study",
          experimentId: "",
          tokenEnv: "MLFLOW_TRACKING_TOKEN",
        }),
        status: "not_configured",
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit = {}) => {
      const url = new URL(path, "http://fixture");
      const method = options.method ?? "GET";
      const body = options.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ path: url.pathname + url.search, method, body });
      if (url.pathname === "/api/collaboration/context")
        return Response.json({ actor: { id: "owner" }, permissions });
      if (url.pathname === "/api/ssh/connections")
        return Response.json({
          connections: [],
          credentialStorage: { available: true, kind: "windows-dpapi" },
        });
      if (url.pathname === "/api/tools-environment")
        return Response.json(inventory);
      if (url.pathname === "/api/tools-environment/catalog")
        return Response.json(catalog);
      if (url.pathname.includes("/catalog/sources/")) {
        const source = url.pathname.split("/").at(-1);
        if (discoveryError && source === "conda")
          return Response.json(
            { error: { message: "Conda 无法运行" } },
            { status: 503 },
          );
        catalog.sources = catalog.sources.map((s) =>
          s.id === source
            ? {
                ...s,
                status: "ready",
                count: source === "conda" ? 2 : 0,
                environments: source === "conda" ? envs : [],
              }
            : s,
        );
        return Response.json(catalog);
      }
      const match = url.pathname.match(
        /\/environments\/([ab]{24})(?:\/(.*))?$/,
      );
      if (match) {
        const [, id, action] = match;
        const env = envs.find((e) => e.id === id)!;
        if (!action)
          return Response.json({ environment: env, inspection: reports[id] });
        if (action === "check") {
          reports[id] = {
            ...reports[id],
            status: "completed",
            checkedAt: "2026-10-30T06:00:00Z",
            components: [
              {
                id: "python",
                scope: "research",
                status: "ready",
                version: "3.12.9",
                checkedAt: null,
              },
              {
                id: "wandb",
                scope: "research",
                status: "installed",
                version: id === a ? "0.18.0" : "0.20.0",
                checkedAt: null,
              },
              {
                id: "torch",
                scope: "research",
                status: "not_installed",
                checkedAt: null,
              },
            ],
          };
          return Response.json({ environment: env, inspection: reports[id] });
        }
        if (action === "activate") {
          catalog.current = { id, name: env.name, selection: env.selection };
          return Response.json(catalog);
        }
        if (action.startsWith("packages")) {
          if (action.endsWith("refresh")) packagesReady = true;
          const all = [
            { name: "numpy", version: "2.1.0", source: "conda" },
            { name: "wandb", version: "0.20.0", source: "pip" },
            ...Array.from({ length: 55 }, (_, i) => ({
              name: `pkg-${i}`,
              version: "1.0.0",
              source: "conda",
            })),
          ];
          const filtered = all.filter((item) =>
            item.name.includes(url.searchParams.get("q") ?? ""),
          );
          const offset = Number(url.searchParams.get("offset") ?? 0);
          return Response.json({
            environment: env,
            kind: "conda-and-pip",
            status: packageError
              ? "error"
              : packagesReady
                ? "completed"
                : "unchecked",
            detail: packageError ? "无法读取完整包清单" : null,
            items:
              packagesReady && !packageError
                ? filtered.slice(offset, offset + 50)
                : [],
            total: packagesReady ? all.length : 0,
            matched: filtered.length,
            offset,
            limit: 50,
            checkedAt: null,
            nextOffset: offset + 50 < filtered.length ? offset + 50 : null,
          });
        }
      }
      if (url.pathname === "/api/project-workspaces") return Response.json({ projectId: "project-a", name: "Project A", localHost: "workstation", workspace: { kind: "local", directory: "E:/Research", revision: 0 } });
      if (url.pathname === "/api/tools-environment/record-collectors") return Response.json({ adapters: [] });
      if (method === "PATCH") return Response.json(inventory);
      if (url.pathname.endsWith("/check")) return Response.json(inventory);
      throw new Error(`Unexpected fixture request: ${path}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});
async function open() {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToolsEnvironmentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: "Conda" });
  return userEvent.setup();
}

it("starts with environment sources and keeps host resources and application runtime folded", async () => {
  await open();
  const table = screen.getByRole("table", { name: "科研环境列表" });
  expect(within(table).getAllByRole("row")).toHaveLength(4);
  expect(
    screen.queryByRole("button", { name: "展开环境 env-b" }),
  ).not.toBeInTheDocument();
  expect(
    screen
      .getByRole("button", { name: "查看 Node.js 详情" })
      .closest("details"),
  ).not.toHaveAttribute("open");
  expect(calls.some((call) => call.path.includes("/sources/"))).toBe(false);
  expect(calls.some((call) => call.method === "POST")).toBe(false);
});

it("discovers a source, inspects just the expanded environment and changes current only on explicit use", async () => {
  const user = await open();
  await user.click(screen.getByRole("button", { name: "Conda" }));
  await user.click(
    await screen.findByRole("button", { name: "展开环境 env-b" }),
  );
  expect(await screen.findByText("0.20.0")).toBeInTheDocument();
  expect(screen.getByText(/项目当前环境：/)).toHaveTextContent("env-a");
  expect(calls.filter((call) => call.path.endsWith("/check"))).toHaveLength(1);
  expect(calls.some((call) => call.path.endsWith(`${a}/check`))).toBe(false);
  await user.click(screen.getByRole("button", { name: "Conda" }));
  await user.click(screen.getByRole("button", { name: "Conda" }));
  expect(await screen.findByText("0.20.0")).toBeInTheDocument();
  expect(calls.filter((call) => call.path.endsWith("/check"))).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "设为当前" }));
  await waitFor(() =>
    expect(screen.getByText(/项目当前环境：/)).toHaveTextContent("env-b"),
  );
  expect(calls.filter((call) => call.path.endsWith("/activate"))).toHaveLength(
    1,
  );
});

it("opens all packages for the viewed environment, searches names and pages without changing current", async () => {
  const user = await open();
  await user.click(screen.getByRole("button", { name: "Conda" }));
  await user.click(
    await screen.findByRole("button", { name: "展开环境 env-b" }),
  );
  await user.click(screen.getByRole("button", { name: "查看所有包及版本" }));
  const dialog = await screen.findByRole("dialog", {
    name: "env-b · 全部包与版本",
  });
  expect(
    await within(dialog).findByRole("rowheader", { name: "numpy" }),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText("2.1.0", { exact: true }),
  ).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "下一页包" }));
  await waitFor(() =>
    expect(calls.some((call) => call.path.includes("offset=50"))).toBe(true),
  );
  await user.type(
    within(dialog).getByRole("searchbox", { name: "搜索包名" }),
    "numpy",
  );
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.path.includes("q=numpy") && call.path.includes("offset=0"),
      ),
    ).toBe(true),
  );
  expect(calls.some((call) => call.path.endsWith("/activate"))).toBe(false);
});

it("shows a retryable package-read error without an empty success table", async () => {
  packageError = true;
  const user = await open();
  await user.click(screen.getByRole("button", { name: "Conda" }));
  await user.click(
    await screen.findByRole("button", { name: "展开环境 env-b" }),
  );
  await user.click(screen.getByRole("button", { name: "查看所有包及版本" }));
  const dialog = await screen.findByRole("dialog", {
    name: "env-b · 全部包与版本",
  });
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "无法读取完整包清单",
  );
  expect(within(dialog).queryByRole("table")).not.toBeInTheDocument();
});

it("lets readers browse cached diagnostics and packages while keeping mutations unavailable", async () => {
  permissions = ["project.view"];
  packagesReady = true;
  reports[b] = {
    ...reports[b],
    status: "completed",
    components: [
      {
        id: "wandb",
        scope: "research",
        status: "installed",
        version: "0.20.0",
        checkedAt: null,
      },
    ],
  };
  const user = await open();
  await user.click(screen.getByRole("button", { name: "Conda" }));
  await user.click(
    await screen.findByRole("button", { name: "展开环境 env-b" }),
  );
  expect(await screen.findByText("0.20.0")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "设为当前" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "添加解释器" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "查看所有包及版本" }));
  await screen.findByRole("rowheader", { name: "numpy" });
  expect(
    screen.queryByRole("button", { name: "刷新包清单" }),
  ).not.toBeInTheDocument();
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

it("keeps source discovery failures local and exposes manager configuration", async () => {
  discoveryError = true;
  const user = await open();
  await user.click(screen.getByRole("button", { name: "Conda" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Conda 无法运行");
  await user.click(screen.getByRole("button", { name: "配置 Conda" }));
  expect(
    await screen.findByRole("dialog", { name: "Conda" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Conda 可执行文件" })).toHaveValue(
    "conda",
  );
});

it("uses the same hierarchy and package controls in English", async () => {
  useUiStore.setState({ locale: "en" });
  const user = await open();
  await user.click(screen.getByRole("button", { name: "Conda" }));
  await user.click(
    await screen.findByRole("button", { name: "Expand environment env-b" }),
  );
  expect(
    await screen.findByRole("button", {
      name: "View all packages and versions",
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Use environment" }),
  ).toBeInTheDocument();
});
