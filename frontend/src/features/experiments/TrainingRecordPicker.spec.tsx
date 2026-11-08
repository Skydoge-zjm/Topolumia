import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { TrainingRecordPicker } from "./TrainingRecordPicker";

let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); });
function show(empty = false) {
  const runs = [
    { sourceId: "s/a", label: "OOM attempt", provider: "wandb", projectSource: { sourceId: "s", runId: "a" }, hostId: "remote", hostLabel: "GPU server", directory: "experiments/rank4", status: "failed" },
    { sourceId: "s/b", label: "Successful retry", provider: "wandb", projectSource: { sourceId: "s", runId: "b" }, hostId: "remote", hostLabel: "GPU server", directory: "experiments/rank4", status: "succeeded" },
    { sourceId: "t/c", label: "TensorBoard run", provider: "tensorboard", projectSource: { sourceId: "t", runId: "c" }, hostId: "local", hostLabel: "Local", directory: "runs/other", status: "running" },
  ];
  const fetch = vi.fn(async (url: string) => {
    if (url.includes("collaboration/context")) return Response.json({ actor: { id: "owner" }, permissions: ["*"] });
    if (url.includes("/ssh/connections")) return Response.json({ current: { connectionId: "remote" }, connections: [{ id: "remote", name: "GPU server", status: "connected" }] });
    if (url.includes("record-collectors")) return Response.json({ adapters: [] });
    return Response.json({ items: empty ? [] : runs, sources: [], total: empty ? 0 : 3, nextOffset: null });
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const select = vi.fn();
  render(<MemoryRouter><QueryClientProvider client={client}><TrainingRecordPicker en onSelect={select} onClose={() => {}} /></QueryClientProvider></MemoryRouter>);
  return { fetch, select, runs };
}
it("selects failed and successful runs together without deploying on view or mixing tools", async () => {
  const { fetch, select, runs } = show();
  fireEvent.click(await screen.findByRole("checkbox", { name: "OOM attempt" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Successful retry" }));
  expect(screen.getByRole("checkbox", { name: "TensorBoard run" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Add selected runs (2)" }));
  await waitFor(() => expect(select).toHaveBeenCalledWith(runs.slice(0, 2)));
  expect(fetch.mock.calls.some(([url]) => url.includes("/enable"))).toBe(false);
});
it("enables the current saved SSH host from an empty picker without downloading a script", async () => {
  const { fetch } = show(true);
  fireEvent.click(await screen.findByRole("button", { name: "Enable W&B · GPU server" }));
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith("/wandb/enable"))).toBe(true));
  expect(await screen.findByText("Deployment started. New records will appear here.")).toBeInTheDocument();
});
