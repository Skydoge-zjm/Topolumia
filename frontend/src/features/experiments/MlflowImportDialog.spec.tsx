import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { afterEach, expect, it, vi } from "vitest";
import { server } from "@/vitest-setup";
import { MlflowImportDialog } from "./MlflowImportDialog";

let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); });

it("imports selected runs, blocks duplicate submissions, and retains the selection after a failed import", async () => {
  let releaseFailure!: () => void;
  const firstResponse = new Promise<void>(resolve => { releaseFailure = resolve; });
  const submissions: string[][] = [];
  server.use(
    http.get("/api/research/experiments/mlflow/catalog", () => HttpResponse.json({ runs: [
      { runId: "run-failed", label: "Failed trial", status: "failed", experimentName: "Ablation" },
      { runId: "run-completed", label: "Completed baseline", status: "succeeded", experimentName: "Baseline" },
      { runId: "run-running", label: "Running trial", status: "running", experimentName: "Ablation" },
    ] })),
    http.post("/api/research/experiments/mlflow/import", async ({ request }) => {
      const input = await request.json() as { runIds: string[] };
      submissions.push(input.runIds);
      if (submissions.length === 1) {
        await firstResponse;
        return HttpResponse.json({ error: { code: "MLFLOW_UNAVAILABLE", message: "MLflow is unavailable. Retry import." } }, { status: 503 });
      }
      return HttpResponse.json({ imported: input.runIds.length });
    }),
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const close = vi.fn();
  render(<MemoryRouter><QueryClientProvider client={client}><MlflowImportDialog en onClose={close} /></QueryClientProvider></MemoryRouter>);
  const user = userEvent.setup();
  try {
    expect(screen.getByRole("button", { name: "Import selected (0)" })).toBeDisabled();
    await user.click(await screen.findByRole("checkbox", { name: "Failed trial" }));
    await user.click(screen.getByRole("checkbox", { name: "Completed baseline" }));
    const submit = screen.getByRole("button", { name: "Import selected (2)" });
    await user.click(submit);
    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submit).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Failed trial" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Search MLflow runs" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.click(submit);
    expect(submissions).toHaveLength(1);

    releaseFailure();
    expect(await screen.findByRole("alert")).toHaveTextContent("MLflow is unavailable. Retry import.");
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Failed trial" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Completed baseline" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Running trial" })).not.toBeChecked();
    expect(submit).toBeEnabled();

    await user.click(submit);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(submissions.map(runIds => [...runIds].sort())).toEqual([
      ["run-completed", "run-failed"],
      ["run-completed", "run-failed"],
    ]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally {
    releaseFailure();
  }
});
