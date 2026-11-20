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
  AgentConfigurationPage,
  type AgentConfiguration,
} from "./AgentConfigurationPage";
import { useUiStore } from "@/shared/state/ui";

let data: AgentConfiguration;
let requests: Array<{
  path: string;
  method: string;
  body: Record<string, unknown>;
}>;
let permissions: string[];
let loadError: boolean;
let saveError: boolean;
let holdCheck: boolean;
let release: (() => void) | undefined;
let queryClient: QueryClient;
beforeEach(() => {
  window.localStorage.setItem("research-workbench-project", "project-a");
  useUiStore.setState({ locale: "zh" });
  permissions = ["project.manageSettings"];
  requests = [];
  loadError = false;
  saveError = false;
  holdCheck = false;
  release = undefined;
  data = {
    schemaVersion: "agent-configuration.v1",
    project: { id: "project-a", name: "Project A" },
    agents: ["Codex", "Claude Code", "OpenCode"].map((label, index) => ({
      id: ["codex", "claude", "opencode"][index],
      provider: ["codex", "claude", "opencode"][index],
      label,
      model: "gpt-6-luna",
      models: [{ id: "gpt-6-luna", label: "6 Luna" }],
      isDefault: index === 0,
      status: "unchecked",
      detail: "",
      recovery: null,
      checkedAt: null,
      installed: null,
      version: null,
      authStatus: "unchecked",
      resolvedModel: null,
    })),
    integration: {
      status: "unchecked",
      detail: "",
      checkedAt: null,
      recovery: null,
    },
  };
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, options: RequestInit = {}) => {
      const path = String(input);
      const method = options.method ?? "GET";
      const body = options.body ? JSON.parse(String(options.body)) : {};
      if (path === "/api/collaboration/context")
        return Response.json({ permissions });
      if (method === "GET")
        return loadError
          ? Response.json(
              { error: { message: "Agent 配置暂时不可用" } },
              { status: 503 },
            )
          : Response.json(data);
      requests.push({ path, method, body });
      if (method === "PATCH") {
        if (saveError)
          return Response.json(
            { error: { message: "模型名称格式不正确" } },
            { status: 422 },
          );
        const agent = data.agents.find((agent) =>
          path.endsWith(`/${agent.id}`),
        )!;
        if (body.model) agent.model = body.model;
        if (body.makeDefault)
          for (const item of data.agents) item.isDefault = item.id === agent.id;
        return Response.json(data);
      }
      if (holdCheck)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (!body.profileId || body.integration)
        data.integration = {
          status: "ready",
          detail: "MCP 握手、授权与 CLI 往返通过",
          checkedAt: "2026-10-26T12:00:00Z",
          recovery: null,
        };
      for (const agent of data.agents)
        if (
          (!body.profileId || body.profileId === agent.id) &&
          !body.integration
        ) {
          agent.installed = true;
          agent.version = "1.2.3";
          agent.checkedAt = "2026-10-26T12:00:00Z";
          agent.status = agent.id === "claude" ? "unavailable" : "ready";
          agent.authStatus = agent.id === "claude" ? "needs-auth" : "ready";
          agent.detail =
            agent.id === "claude"
              ? "已安装，尚未完成登录或 Provider 认证。"
              : "运行时与认证检查通过。";
        }
      return Response.json(data);
    }),
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
});
async function open() {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentConfigurationPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole("tab", { name: /^Codex/ });
  return userEvent.setup();
}
const panel = () => within(screen.getByRole("tabpanel"));

it("groups the three Agents and research integration without duplicating tool configuration", async () => {
  await open();
  for (const name of [/^Codex/, "Claude Code", "OpenCode"])
    expect(screen.getByRole("tab", { name })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "科研 MCP" })).toBeInTheDocument();
  expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  expect(screen.getByRole("combobox", { name: "默认模型" })).toHaveValue(
    "gpt-6-luna",
  );
  expect(
    screen.queryByRole("heading", { name: "Node.js" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "MLflow" }),
  ).not.toBeInTheDocument();
  expect(requests).toHaveLength(0);
});

it("checks one Agent and distinguishes installation from missing authentication", async () => {
  const user = await open();
  holdCheck = true;
  await user.click(screen.getByRole("tab", { name: "Claude Code" }));
  await user.click(panel().getByRole("button", { name: "检查" }));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  expect(screen.getByRole("button", { name: "检查中…" })).toBeDisabled();
  release!();
  expect(await panel().findByText("需要登录")).toBeInTheDocument();
  expect(panel().getByText("已安装 · 1.2.3")).toBeInTheDocument();
  expect(requests[0]).toMatchObject({
    path: "/api/agent-configuration/check",
    body: { profileId: "claude" },
  });
  await user.click(screen.getByRole("tab", { name: /^Codex/ }));
  expect(panel().getByText("安装待检")).toBeVisible();
});

it("saves the selected Agent's default model", async () => {
  const user = await open();
  await user.clear(panel().getByRole("combobox", { name: "默认模型" }));
  await user.type(
    panel().getByRole("combobox", { name: "默认模型" }),
    "fixture-new-model",
  );
  await user.click(panel().getByRole("button", { name: "保存配置" }));
  expect(await screen.findByText(/Agent 配置已保存/)).toBeVisible();
  expect(panel().getByRole("combobox", { name: "默认模型" })).toHaveValue(
    "fixture-new-model",
  );
  expect(requests[0]).toMatchObject({
    method: "PATCH",
    path: "/api/agent-configuration/profiles/codex",
    body: { model: "fixture-new-model" },
  });
});

it("selects the default Agent independently of its model and probe state", async () => {
  const user = await open();
  await user.click(screen.getByRole("tab", { name: "OpenCode" }));
  await user.click(panel().getByRole("switch"));
  await screen.findByRole("tab", { name: /OpenCode.*默认/ });
  expect(panel().getByRole("switch")).toBeChecked();
  expect(screen.getByRole("tab", { name: "Codex" })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0].body).toEqual({ makeDefault: true });
});

it("keeps a rejected model visible for correction", async () => {
  const user = await open();
  saveError = true;
  await user.clear(screen.getByRole("combobox", { name: "默认模型" }));
  await user.type(
    screen.getByRole("combobox", { name: "默认模型" }),
    "bad model",
  );
  await user.click(screen.getByRole("button", { name: "保存配置" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "模型名称格式不正确",
  );
  expect(screen.getByRole("combobox", { name: "默认模型" })).toHaveValue(
    "bad model",
  );
});

it("provides a readable guest view without mutation controls", async () => {
  permissions = ["project.view"];
  await open();
  expect(screen.getByRole("button", { name: "检查全部 Agent" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "配置" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "检查科研接口" }),
  ).not.toBeInTheDocument();
});

it("shows a retryable error instead of fabricated Agent availability", async () => {
  loadError = true;
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentConfigurationPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Agent 配置暂时不可用",
  );
  expect(screen.queryByRole("tab", { name: /^Codex/ })).not.toBeInTheDocument();
  loadError = false;
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(
    await screen.findByRole("tab", { name: /^Codex/ }),
  ).toBeInTheDocument();
});

it("preserves an unsaved draft when the engine switch is canceled", async () => {
  const user = await open();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  try {
    await user.clear(panel().getByRole("combobox", { name: "默认模型" }));
    await user.type(
      panel().getByRole("combobox", { name: "默认模型" }),
      "unsaved-model",
    );
    await user.click(screen.getByRole("tab", { name: "Claude Code" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(panel().getByRole("combobox", { name: "默认模型" })).toHaveValue(
      "unsaved-model",
    );
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("tab", { name: "Claude Code" }));
    expect(panel().getByRole("combobox", { name: "默认模型" })).toHaveValue(
      "gpt-6-luna",
    );
  } finally {
    confirm.mockRestore();
  }
});
