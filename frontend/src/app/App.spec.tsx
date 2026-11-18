import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { LoginPage } from "./entry/LoginPage";
import { useUiStore } from "@/shared/state/ui";

function renderApp(path: string, initialized = true) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.endsWith("/api/auth/status") ? { initialized } : { user: null };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("React application shell", () => {
  it("renders the login boundary with accessible credentials fields", () => {
    render(<MemoryRouter><LoginPage onLoggedIn={() => {}} /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "登录研究工作台" })).toBeTruthy();
    expect(screen.getByLabelText("用户名")).toBeTruthy();
    expect(screen.getByLabelText("密码")).toBeTruthy();
  });

  it("toggles password visibility without losing the value", () => {
    render(<MemoryRouter><LoginPage onLoggedIn={() => {}} /></MemoryRouter>);
    const password = screen.getByLabelText("密码") as HTMLInputElement;
    fireEvent.change(password, { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "显示明文" }));
    expect(password.type).toBe("text");
    expect(password.value).toBe("secret");
  });

  it("shows the entry page to signed-out visitors at the root", async () => {
    renderApp("/");
    expect(await screen.findByRole("heading", { level: 1, name: /论证/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /登录研究工作台/ }).getAttribute("href")).toBe("/login");
  });

  it("sends signed-out deep links to the login page", async () => {
    renderApp("/topology");
    expect(await screen.findByRole("heading", { name: "登录研究工作台" })).toBeTruthy();
  });

  it("offers administrator setup on an uninitialized workbench", async () => {
    renderApp("/", false);
    expect(await screen.findByRole("link", { name: /创建管理员账号/ })).toBeTruthy();
  });

  it("returns a deleted project workspace to the list and clears the stale selection", async () => {
    useUiStore.setState({ locale: "zh" });
    localStorage.setItem("research-workbench-project", "deleted-project");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
      url === "/api/auth/status" ? { initialized: true } :
      url === "/api/auth/me" ? { user: { id: "owner" } } :
      url === "/api/collaboration/context" ? { actor: { id: "owner", serverRole: "s-admin" }, project: null, projects: [], permissions: ["*"] } : {},
    )));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    try {
      render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/overview"]}><App /></MemoryRouter></QueryClientProvider>);
      expect(await screen.findByRole("heading", { name: "项目列表" })).toBeTruthy();
      expect(localStorage.getItem("research-workbench-project")).toBeNull();
      expect(screen.getByRole("link", { name: "创建项目" })).toBeTruthy();
    } finally { client.clear(); }
  });
});
