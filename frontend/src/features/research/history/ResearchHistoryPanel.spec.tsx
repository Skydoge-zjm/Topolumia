import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ResearchHistoryPanel } from "./ResearchHistoryPanel";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("renders meaningful review outcomes with separate user and Agent attribution and server-side filters", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ total: 1, nextOffset: null, items: [{ id: "event", kind: "proposal.rejected", category: "proposals", outcome: "rejected", occurredAt: "2026-10-31T10:00:00Z", actor: { id: "user", name: "Alice", type: "human" }, initiatedBy: { id: "agent", name: "Codex", type: "agent" }, reason: "证据不足", proposal: { id: "proposal", revision: 1 }, changes: [{ action: "node.created", subject: { id: "inference", type: "node", kind: "inference", label: "实验推论", summary: "" } }], changeCount: 1, planned: true }] }));
  }));
  render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ResearchHistoryPanel en={false} /></QueryClientProvider></MemoryRouter>);
  expect(await screen.findByText("拒绝了科研提议")).toBeVisible(); expect(screen.getByText("Alice")).toBeVisible();
  expect(screen.getByText(/发起方：Codex/)).toBeVisible(); expect(screen.getByText("证据不足")).toBeVisible();
  expect(screen.getByRole("link")).toHaveAttribute("href", "/records/history/event");
  fireEvent.change(screen.getByLabelText("搜索科研历程"), { target: { value: "实验" } });
  await waitFor(() => expect(requests.some(url => new URL(url, "http://fixture").searchParams.get("q") === "实验")).toBe(true));
  expect(requests.every(url => url.startsWith("/api/research-history"))).toBe(true);
});
