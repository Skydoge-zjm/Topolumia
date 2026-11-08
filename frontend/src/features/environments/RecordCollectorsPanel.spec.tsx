import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { RecordCollectorsPanel } from "./RecordCollectorsPanel";

let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); });
function show(manage = true) {
  let enabled = false;
  const fetch = vi.fn(async (_url: string, options: RequestInit = {}) => {
    if (options?.method === "POST") enabled = true;
    return Response.json({ adapters: [{ provider: "wandb", sources: enabled ? [{ id: "record-source:test", directory: "/project", enabled: true, status: "deploying", phase: "installing", runCount: 0 }] : [] }] });
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<MemoryRouter><QueryClientProvider client={client}><RecordCollectorsPanel en={false} sshId="12345678-1234-1234-1234-123456789abc" canManage={manage} online /></QueryClientProvider></MemoryRouter>);
  return fetch;
}
it("deploys the selected host with its saved project directory and reports the actual deployment phase", async () => {
  const fetch = show();
  const row = (await screen.findByText("W&B")).closest("tr")!;
  fireEvent.click(within(row).getByRole("button", { name: "部署并启用" }));
  expect(await screen.findByText("安装读取器")).toBeInTheDocument();
  const post = fetch.mock.calls.find(([, options]) => options?.method === "POST")!;
  expect(post[0]).toBe("/api/tools-environment/record-collectors/wandb/enable");
  expect(JSON.parse(String(post[1]?.body))).toEqual({});
  expect(new Headers(post[1]?.headers).get("x-rw-ssh-id")).toBe("12345678-1234-1234-1234-123456789abc");
  expect(screen.queryByText("下载接入脚本")).toBeNull();
});
it("lets a reader inspect the adapter without triggering deployment or exposing management actions", async () => {
  const fetch = show(false);
  await screen.findByText("W&B");
  expect(screen.queryByRole("button", { name: "部署并启用" })).toBeNull();
  await waitFor(() => expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0));
});
