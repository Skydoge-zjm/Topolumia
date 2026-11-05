import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SshEnvironmentSelector } from "./SshEnvironmentSelector";
import {
  sshOverviewKey,
  type SshOverview,
  type SshConnection,
  type SshChallenge,
} from "@/features/environments/ssh/ssh";
import { api } from "@/shared/lib/api";

let overview: SshOverview,
  client: QueryClient,
  onSelect: ReturnType<typeof vi.fn<(id: string) => void>>,
  challenge: SshChallenge | null;
let calls: Array<{
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}>;
const connectionId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const profile = (): SshConnection => ({
  id: connectionId,
  revision: 1,
  name: "WSL",
  mode: "alias",
  alias: "wsl",
  status: "disconnected",
  challenge: null,
  error: null,
  remembered: false,
  effective: null,
  info: null,
  timeoutSeconds: 10,
  keepAlive: true,
  connectedAt: null,
  updatedAt: "2026-10-30T06:00:00Z",
});
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  onSelect = vi.fn<(id: string) => void>();
  calls = [];
  challenge = null;
  overview = {
    connections: [profile()],
    credentialStorage: { available: true, kind: "windows-dpapi" },
    current: {
      kind: "local",
      name: "pytorch",
      hostLabel: "本机",
      source: "conda",
      connected: true,
      accessible: true,
      needsReview: false,
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit = {}) => {
      const method = options.method ?? "GET",
        body = options.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ path, method, body });
      if (path === "/api/ssh/connections" && method === "GET")
        return Response.json(overview);
      if (path === "/api/ssh/aliases")
        return Response.json({ aliases: ["wsl"] });
      if (path === "/api/ssh/resolve")
        return Response.json({
          host: "127.0.0.1",
          port: 2222,
          user: "researcher",
        });
      if (path === "/api/ssh/connections" && method === "POST") {
        const p = { ...profile(), ...body };
        overview.connections = [p];
        return Response.json(p);
      }
      const p = overview.connections[0];
      if (path.endsWith("/connect")) {
        p.status = challenge
          ? challenge.kind === "host-key"
            ? "verify_host"
            : "authentication"
          : "connected";
        p.challenge = challenge;
        return Response.json(p);
      }
      if (path.endsWith("/respond")) {
        p.status = "connected";
        p.challenge = null;
        return Response.json(p);
      }
      if (path.endsWith("/disconnect")) {
        p.status = "disconnected";
        p.challenge = null;
        return Response.json(p);
      }
      if (path.endsWith("/project"))
        return Response.json({ directory: "/home/researcher/project" });
      return Response.json(
        { error: { message: "Unexpected request" } },
        { status: 404 },
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});
function Harness({
  selectedId = "",
  canManage = true,
}: {
  selectedId?: string;
  canManage?: boolean;
}) {
  const query = useQuery({
    queryKey: sshOverviewKey("project", "owner"),
    queryFn: () => api<SshOverview>("/api/ssh/connections"),
  });
  return (
    <SshEnvironmentSelector
      overview={query.data}
      project="project"
      actor="owner"
      en={false}
      canManage={canManage}
      selectedId={selectedId}
      onSelect={onSelect}
      onRefresh={() => {}}
    />
  );
}
async function open(props = {}) {
  render(
    <QueryClientProvider client={client}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
  await screen.findByText("本机 / Conda / pytorch");
  return userEvent.setup();
}

it("browses a saved SSH location without changing the project binding or connecting implicitly", async () => {
  const user = await open();
  await user.click(screen.getByRole("button", { name: "查看位置" }));
  const locations = screen.getByRole("listbox", { name: "查看位置" });
  expect(within(locations).getAllByRole("option")).toHaveLength(2);
  await user.click(
    within(locations).getByRole("option", { name: "WSL · 未连接" }),
  );
  expect(onSelect).toHaveBeenCalledWith(connectionId);
  expect(calls.some((c) => c.method !== "GET")).toBe(false);
  expect(screen.getByText("本机 / Conda / pytorch")).toBeInTheDocument();
});

it("resolves an existing SSH alias and saves only configuration before connecting", async () => {
  const user = await open();
  await user.click(screen.getByRole("button", { name: "SSH管理" }));
  const dialog = await screen.findByRole("dialog", { name: "SSH 连接" });
  await user.click(
    within(dialog).getByRole("button", { name: "添加 SSH 连接" }),
  );
  await user.type(within(dialog).getByLabelText("连接名称"), "WSL research");
  await user.type(within(dialog).getByLabelText("SSH 别名"), "wsl");
  await user.click(within(dialog).getByRole("button", { name: "解析配置" }));
  expect(
    await within(dialog).findByText("researcher@127.0.0.1:2222"),
  ).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "保存并连接" }));
  await within(dialog).findByRole("button", { name: "查看环境" });
  expect(
    calls.find((c) => c.path === "/api/ssh/connections" && c.method === "POST")
      ?.body,
  ).toMatchObject({ mode: "alias", alias: "wsl", name: "WSL research" });
  expect(onSelect).toHaveBeenCalledWith(connectionId);
});

it("requires verified confirmation for changed fingerprints and supports canceling login", async () => {
  challenge = {
    id: "challenge",
    kind: "host-key",
    host: "lab",
    port: 22,
    user: "scientist",
    fingerprint: "SHA256:new",
    previousFingerprints: ["SHA256:old"],
    changed: true,
    prompts: [],
  };
  const user = await open({ selectedId: connectionId });
  await user.click(screen.getByRole("button", { name: "连接" }));
  await screen.findByText("主机指纹已变化");
  const trust = screen.getByRole("button", { name: "信任并继续" });
  expect(trust).toBeDisabled();
  await user.click(
    screen.getByLabelText("我已通过可信渠道核对变更后的主机指纹"),
  );
  await user.click(trust);
  await waitFor(() =>
    expect(calls.find((c) => c.path.endsWith("/respond"))?.body).toMatchObject({
      trust: true,
      verified: true,
    }),
  );
});

it("uses the shared menus for manual host configuration and submits the selected authentication method", async () => {
  const user = await open();
  await user.click(screen.getByRole("button", { name: "SSH管理" }));
  const dialog = screen.getByRole("dialog", { name: "SSH 连接" });
  await user.click(
    within(dialog).getByRole("button", { name: "添加 SSH 连接" }),
  );
  await user.click(within(dialog).getByRole("button", { name: "配置方式" }));
  await user.click(
    within(dialog).getByRole("option", { name: "手动填写主机" }),
  );
  await user.type(within(dialog).getByLabelText("连接名称"), "Manual host");
  await user.type(within(dialog).getByLabelText("主机地址"), "127.0.0.1");
  await user.type(within(dialog).getByLabelText("登录用户"), "scientist");
  await user.click(within(dialog).getByRole("button", { name: "认证方式" }));
  await user.click(within(dialog).getByRole("option", { name: "私钥文件" }));
  expect(
    within(dialog).getByPlaceholderText("~/.ssh/id_ed25519"),
  ).toBeRequired();
  await user.click(within(dialog).getByRole("button", { name: "认证方式" }));
  await user.click(
    within(dialog).getByRole("option", { name: "密码 / 交互认证" }),
  );
  expect(
    within(dialog).queryByPlaceholderText("~/.ssh/id_ed25519"),
  ).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "保存并连接" }));
  await within(dialog).findByRole("button", { name: "查看环境" });
  expect(
    calls.find((c) => c.path === "/api/ssh/connections" && c.method === "POST")
      ?.body,
  ).toMatchObject({
    mode: "manual",
    host: "127.0.0.1",
    port: 22,
    user: "scientist",
    auth: "password",
    keyPath: "",
  });
});

it("submits password once, defaults to session-only, and clears inputs after authentication", async () => {
  challenge = {
    id: "password-step",
    kind: "password",
    host: "lab",
    port: 22,
    user: "scientist",
    title: "输入 SSH 登录密码",
    prompts: [{ label: "密码", secret: true }],
    canRemember: true,
  };
  const user = await open({ selectedId: connectionId });
  await user.click(screen.getByRole("button", { name: "连接" }));
  const password = await screen.findByLabelText("密码");
  await user.type(password, "example-secret");
  expect(
    screen.getByLabelText("使用 Windows 账号加密保存凭据"),
  ).not.toBeChecked();
  await user.click(screen.getByRole("button", { name: "继续登录" }));
  await screen.findByRole("button", { name: "查看环境" });
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  expect(calls.find((c) => c.path.endsWith("/respond"))?.body).toEqual({
    challengeId: "password-step",
    values: ["example-secret"],
    remember: false,
  });
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain("example-secret");
});

it("keeps offline cached browsing available and hides connection mutations for project readers", async () => {
  const user = await open({ selectedId: connectionId, canManage: false });
  expect(screen.getByText(/已保存结果/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "连接" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "SSH管理" }));
  expect(
    screen.queryByRole("button", { name: "添加 SSH 连接" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "查看" })).toBeEnabled();
});
