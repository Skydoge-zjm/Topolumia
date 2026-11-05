import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollaborationPage } from "./CollaborationPage";
import { useUiStore } from "@/shared/state/ui";

let permissions: string[];
let canInspect: boolean;
let failMembers: boolean;
let paths: string[];
let client: QueryClient;

beforeEach(() => {
  localStorage.setItem("research-workbench-project", "study");
  useUiStore.setState({ locale: "zh" });
  permissions = ["project.manageMembers"];
  canInspect = true;
  failMembers = false;
  paths = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = String(input);
    paths.push(path);
    if (path === "/api/collaboration/context") return Response.json({ project: { id: "study", name: "实际项目" }, membership: { role: "researcher", status: "active" }, permissions });
    if (path.endsWith("/invitations")) return Response.json({ invitations: [{ id: "invite", user: { username: "pending", displayName: "待加入成员" }, role: "researcher", expiresAt: "2026-11-12T00:00:00Z" }] });
    if (failMembers) return Response.json({ error: { code: "FORBIDDEN", message: "无法读取成员" } }, { status: 403 });
    return Response.json({ members: [{ user: { id: "member", username: "real-user", displayName: "真实成员" }, membership: { role: "researcher", status: "suspended", updatedAt: "2026-11-05T01:00:00Z" }, ...(canInspect ? { permissions: ["project.view", "research.read"] } : {}) }] });
  }));
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });
function open() { render(<QueryClientProvider client={client}><MemoryRouter><CollaborationPage /></MemoryRouter></QueryClientProvider>); }

it("shows actual membership, effective permissions and pending invitations", async () => {
  open();
  const name = await screen.findByText("真实成员");
  const row = name.closest("tr")!;
  expect(within(row).getByText("已停用")).toBeVisible();
  expect(within(row).getByText("2 项权限")).toBeVisible();
  expect(within(row).getByText("project.view")).toBeInTheDocument();
  expect(row.querySelector("time")?.getAttribute("dateTime")).toBe("2026-11-05T01:00:00Z");
  expect(await screen.findByText("待加入成员")).toBeVisible();
  expect(screen.queryByText("全部权限")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /邀请成员|添加服务器账号|查看详情/ })).not.toBeInTheDocument();
});

it("does not invent hidden permissions or fetch administrator invitations for a reader", async () => {
  permissions = ["project.view"];
  canInspect = false;
  open();
  await screen.findByText("真实成员");
  expect(screen.queryByText(/项权限/)).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "待处理邀请" })).not.toBeInTheDocument();
  expect(paths.some((path) => path.endsWith("/invitations"))).toBe(false);
});

it("shows a failed member request without claiming that the project has no members", async () => {
  failMembers = true;
  permissions = ["project.view"];
  open();
  expect(await screen.findByRole("alert")).toHaveTextContent("无法读取成员");
  expect(screen.queryByText("暂无成员")).not.toBeInTheDocument();
});
