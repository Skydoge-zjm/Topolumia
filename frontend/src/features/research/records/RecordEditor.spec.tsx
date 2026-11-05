import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { RecordEditor } from "./RecordEditor";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("authors actual minutes and multiline content without fetching Agent logs", async () => {
  let saved: any;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.startsWith("/api/topology")) return new Response(JSON.stringify({ nodes: [] }));
    if (url === "/api/research-records") { saved = JSON.parse(String(options?.body)); return new Response(JSON.stringify({ id: "record" })); }
    throw new Error(`Unexpected runtime request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const onSaved = vi.fn();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RecordEditor en={false} canConfirm onSaved={onSaved} onCancel={() => {}} /></QueryClientProvider>);
  fireEvent.change(screen.getByLabelText("记录标题"), { target: { value: "本月组会" } });
  fireEvent.change(screen.getByLabelText("参与者 · 每行一人"), { target: { value: "研究者 A\n研究者 B\n" } });
  expect(screen.getByLabelText("参与者 · 每行一人")).toHaveValue("研究者 A\n研究者 B\n");
  fireEvent.change(screen.getByLabelText("记录正文"), { target: { value: "## 本次讨论\n需要补做消融实验。" } });
  fireEvent.click(screen.getByRole("button", { name: "保存记录" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith("record"));
  expect(saved.participants).toEqual(["研究者 A", "研究者 B"]); expect(saved.body).toContain("补做消融");
  expect(fetcher.mock.calls.some(([url]) => /agent-events|api\/state/.test(String(url)))).toBe(false);
});
