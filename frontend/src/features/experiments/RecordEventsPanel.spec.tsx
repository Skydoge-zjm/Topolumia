import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecordEventsPanel } from "./RecordEventsPanel";

let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); });

it("pins event pages, attachment downloads and table previews to the selected snapshot", async () => {
  localStorage.setItem("research-workbench-project", "events-test");
  const fetch = vi.fn(async (url: string) => {
    if (url.includes("/attachments/")) return Response.json({ columns: ["score"], data: [[7]] });
    return Response.json({ items: [{ watermark: 5, event: { kind: "table", sourceRunId: "run:1", data: { attachments: [{ sha256: "abc123", name: "results.json" }] } } }], nextAfter: 5 });
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><RecordEventsPanel blockId="block:1" snapshotId="snapshot:frozen" en /></QueryClientProvider>);
  const attachment = await screen.findByRole("link", { name: "results.json" });
  const download = new URL(attachment.getAttribute("href")!, "http://localhost");
  expect(download.searchParams.get("snapshotId")).toBe("snapshot:frozen");
  expect(download.searchParams.get("projectId")).toBe("events-test");
  fireEvent.click(screen.getByRole("button", { name: "Preview table" }));
  await screen.findByRole("cell", { name: "7" });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes("after=5"))).toBe(true));
  for (const [url] of fetch.mock.calls) expect(new URL(url, "http://localhost").searchParams.get("snapshotId")).toBe("snapshot:frozen");
});
