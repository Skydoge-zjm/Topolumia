import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUiStore } from "@/shared/state/ui";
import { ProjectsPage } from "./ProjectsPage";

let client: QueryClient;
const project = {
  id: "project-a",
  name: "Research A",
  status: "active",
  role: "p-admin",
};
beforeEach(() => {
  useUiStore.setState({ locale: "en" });
  localStorage.setItem("research-workbench-project", project.id);
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
});

function show({
  admin = true,
  other = false,
  remove = () =>
    Response.json({ id: project.id, deleted: true, stoppedCollectors: true }),
}: {
  admin?: boolean;
  other?: boolean;
  remove?: () => Response | Promise<Response>;
} = {}) {
  let deleted = false;
  const fetch = vi.fn(async (path: string, init: RequestInit = {}) => {
    if (init.method === "DELETE") {
      const response = await remove();
      if (response.ok) deleted = true;
      return response;
    }
    if (path === "/api/collaboration/context")
      return Response.json({
        actor: { id: "owner", serverRole: admin ? "s-admin" : "user" },
        project: deleted ? null : project,
        permissions: admin ? ["*"] : ["project.manageMembers"],
        projects: [
          ...(!deleted ? [project] : []),
          ...(other
            ? [{ id: "project-b", name: "Research B", status: "active" }]
            : []),
        ],
      });
    throw new Error("Unexpected request: " + path);
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <MemoryRouter initialEntries={["/projects"]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/overview" element={<h1>Research overview</h1>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return fetch;
}

it("requires the exact name, allows cancellation and keeps project navigation separate", async () => {
  const fetch = show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete project: Research A" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Delete project" });
  const input = within(dialog).getByRole("textbox", {
    name: "Enter the project name to confirm",
  });
  const confirm = within(dialog).getByRole("button", {
    name: "Confirm deletion",
  });
  expect(confirm).toBeDisabled();
  fireEvent.change(input, { target: { value: "Research" } });
  expect(confirm).toBeDisabled();
  fireEvent.submit(input.closest("form")!);
  expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(
    false,
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Research A" }),
  );
  await screen.findByRole("heading", { name: "Research overview" });
});

it("deletes the current last project once and clears selection and project caches after success", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetch = show({ remove: () => pending });
  client.setQueryData(["research-node", project.id, "secret"], {
    body: "prior project",
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete project: Research A" }),
  );
  const dialog = await screen.findByRole("dialog");
  const input = within(dialog).getByRole("textbox");
  fireEvent.change(input, { target: { value: project.name } });
  fireEvent.submit(input.closest("form")!);
  fireEvent.submit(input.closest("form")!);
  await waitFor(() =>
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1),
  );
  const [path, init] = fetch.mock.calls.find(
    ([, init]) => init?.method === "DELETE",
  )!;
  expect(path).toBe("/api/projects/project-a");
  expect(JSON.parse(String(init?.body))).toEqual({ name: project.name });
  expect(localStorage.getItem("research-workbench-project")).toBe(project.id);
  expect(
    within(dialog).getByRole("button", { name: "Deleting…" }),
  ).toBeDisabled();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  release(
    Response.json({ id: project.id, deleted: true, stoppedCollectors: true }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Project deleted.",
  );
  await screen.findByText("No accessible research projects.");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(localStorage.getItem("research-workbench-project")).toBeNull();
  expect(
    client.getQueryData(["research-node", project.id, "secret"]),
  ).toBeUndefined();
  expect(
    screen.getByRole("link", { name: "Create project" }),
  ).toBeInTheDocument();
});

it("keeps the confirmation and current project on server failure and permits retry", async () => {
  let attempts = 0;
  show({
    remove: () =>
      ++attempts === 1
        ? Response.json(
            {
              error: {
                code: "PROJECT_BUSY",
                message: "Finish the active task first.",
              },
            },
            { status: 409 },
          )
        : Response.json({
            id: project.id,
            deleted: true,
            stoppedCollectors: false,
          }),
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete project: Research A" }),
  );
  const dialog = await screen.findByRole("dialog"),
    input = within(dialog).getByRole("textbox");
  fireEvent.change(input, { target: { value: project.name } });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Confirm deletion" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Finish the active task first.",
  );
  expect(input).toHaveValue(project.name);
  expect(localStorage.getItem("research-workbench-project")).toBe(project.id);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Confirm deletion" }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Some record readers could not be stopped",
  );
});

it("does not change selection when deleting a different project", async () => {
  localStorage.setItem("research-workbench-project", "project-b");
  show({ other: true });
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete project: Research A" }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: project.name },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Confirm deletion" }),
  );
  await screen.findByRole("status");
  expect(localStorage.getItem("research-workbench-project")).toBe("project-b");
  expect(
    screen.getByRole("button", { name: "Research B" }),
  ).toBeInTheDocument();
});

it("hides deletion from project administrators who are not server administrators", async () => {
  show({ admin: false });
  await screen.findByRole("button", { name: "Research A" });
  expect(screen.queryByRole("button", { name: /Delete project/ })).toBeNull();
});
