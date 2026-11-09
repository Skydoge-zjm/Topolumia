import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUiStore } from "@/shared/state/ui";
import { ProjectCreatePage } from "./ProjectCreatePage";

let client: QueryClient;
const hostId = "12345678-1234-4234-8234-123456789abc";
beforeEach(() => {
  useUiStore.setState({ locale: "en" });
  localStorage.setItem("research-workbench-project", "previous-project");
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
});
function show(
  handler?: (
    path: string,
    init: RequestInit,
  ) => Promise<Response | undefined> | Response | undefined,
  admin = true,
) {
  const fetch = vi.fn(async (path: string, init: RequestInit = {}) => {
    const custom = await handler?.(path, init);
    if (custom) return custom;
    if (path === "/api/collaboration/context")
      return Response.json({
        actor: { id: "owner" },
        permissions: admin ? ["*"] : ["project.view"],
      });
    if (path === "/api/project-workspaces/validate")
      return Response.json({ workspace: JSON.parse(String(init.body)) });
    if (path === "/api/ssh/connections")
      return Response.json({ connections: [], current: { kind: "local" } });
    if (path === "/api/project-workspaces/defaults")
      return Response.json({
        id: "generated-project",
        directory: "/home/user/.topolumia/workspaces/generated-project",
        hostLabel: "workstation",
      });
    if (path === "/api/projects")
      return Response.json(
        { project: { id: "generated-project" } },
        { status: 201 },
      );
    throw new Error("Unexpected fixture request: " + path);
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <MemoryRouter initialEntries={["/project-create"]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/project-create" element={<ProjectCreatePage />} />
          <Route path="/overview" element={<h1>Research overview</h1>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return fetch;
}

it("creates from a name, prevents duplicate submission and switches project only after success", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetch = show((path, init) =>
    path === "/api/projects" && init.method === "POST" ? pending : undefined,
  );
  const name = await screen.findByRole("textbox", { name: "Project name" });
  expect(screen.queryByRole("textbox", { name: "Project ID" })).toBeNull();
  expect(screen.queryByRole("radio", { name: "Set up later" })).toBeNull();
  expect(
    await screen.findByText(
      "/home/user/.topolumia/workspaces/generated-project",
    ),
  ).toBeInTheDocument();
  fireEvent.change(name, { target: { value: "Efficient fine-tuning" } });
  const form = name.closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  await waitFor(() =>
    expect(
      fetch.mock.calls.filter(([path]) => path === "/api/projects"),
    ).toHaveLength(1),
  );
  const call = fetch.mock.calls.find(([path]) => path === "/api/projects")!;
  expect(JSON.parse(String(call[1]?.body))).toEqual({
    name: "Efficient fine-tuning",
    id: "generated-project",
    workspace: { kind: "managed" },
  });
  expect(localStorage.getItem("research-workbench-project")).toBe(
    "previous-project",
  );
  expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
  release(Response.json({ project: { id: "generated-project" } }));
  expect(
    await screen.findByRole("heading", { name: "Research overview" }),
  ).toBeInTheDocument();
  expect(localStorage.getItem("research-workbench-project")).toBe(
    "generated-project",
  );
});

it("focuses an empty project name and clears its inline error while editing", async () => {
  const fetch = show();
  const name = await screen.findByRole("textbox", { name: "Project name" });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Create project" }),
    ).toBeEnabled(),
  );
  fireEvent.change(name, { target: { value: "   " } });
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Enter a project name.");
  expect(name).toHaveFocus();
  expect(name).toHaveAttribute("aria-invalid", "true");
  expect(fetch.mock.calls.some(([path]) => path === "/api/projects")).toBe(
    false,
  );
  fireEvent.change(name, { target: { value: "LoRA study" } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(name).toHaveAttribute("aria-invalid", "false");
});

it("keeps directory drafts and prevents creating with an empty directory or an unselected SSH host", async () => {
  const fetch = show();
  const name = await screen.findByRole("textbox", { name: "Project name" });
  fireEvent.change(name, { target: { value: "LoRA study" } });
  const create = screen.getByRole("button", { name: "Create project" });
  fireEvent.click(
    screen.getByRole("radio", { name: "Existing local directory" }),
  );
  expect(create).toBeDisabled();
  fireEvent.submit(name.closest("form")!);
  expect(fetch.mock.calls.some(([path]) => path === "/api/projects")).toBe(
    false,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Local directory" }), {
    target: { value: "/research/lora" },
  });
  expect(create).toBeEnabled();
  fireEvent.click(screen.getByRole("radio", { name: "SSH directory" }));
  fireEvent.change(
    screen.getByRole("textbox", { name: "Directory on the SSH host" }),
    {
      target: { value: "/srv/lora" },
    },
  );
  expect(create).toBeDisabled();
  fireEvent.submit(name.closest("form")!);
  expect(fetch.mock.calls.some(([path]) => path === "/api/projects")).toBe(
    false,
  );
  fireEvent.click(
    screen.getByRole("radio", { name: "Existing local directory" }),
  );
  expect(screen.getByRole("textbox", { name: "Local directory" })).toHaveValue(
    "/research/lora",
  );
  expect(name).toHaveValue("LoRA study");
  expect(create).toBeEnabled();
});

it("preserves the form on directory failure and lets the user recover with the default workspace", async () => {
  const fetch = show((path, init) =>
    path === "/api/projects" &&
    JSON.parse(String(init.body)).workspace.kind === "local"
      ? Response.json(
          {
            error: {
              code: "PROJECT_DIRECTORY_NOT_FOUND",
              message: "Directory no longer exists",
            },
          },
          { status: 422 },
        )
      : undefined,
  );
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Project name" }),
    { target: { value: "Keep my draft" } },
  );
  fireEvent.click(
    screen.getByRole("radio", { name: "Existing local directory" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Local directory" }), {
    target: { value: "/research/missing" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Directory no longer exists",
  );
  expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue(
    "Keep my draft",
  );
  expect(screen.getByRole("textbox", { name: "Local directory" })).toHaveValue(
    "/research/missing",
  );
  expect(localStorage.getItem("research-workbench-project")).toBe(
    "previous-project",
  );
  fireEvent.click(
    screen.getByRole("radio", { name: "Topolumia default workspace" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await screen.findByRole("heading", { name: "Research overview" });
  expect(
    JSON.parse(
      String(
        fetch.mock.calls.filter(([path]) => path === "/api/projects").at(-1)![1]
          ?.body,
      ),
    ).workspace,
  ).toEqual({ kind: "managed" });
});

it("browses directories without creating anything and stores the selected canonical path", async () => {
  const fetch = show((path) => {
    if (!path.startsWith("/api/project-workspaces/directories?")) return;
    const directory =
      new URL(path, "http://localhost").searchParams.get("directory") ||
      "/projects";
    return Response.json({
      directory,
      parent: directory === "/projects" ? "/" : "/projects",
      entries:
        directory === "/projects"
          ? [{ name: "lora-study", path: "/projects/lora-study" }]
          : [],
      total: directory === "/projects" ? 1 : 0,
      nextOffset: null,
      partial: false,
      roots: [],
      home: "/home/researcher",
    });
  });
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Project name" }),
    { target: { value: "LoRA" } },
  );
  fireEvent.click(
    screen.getByRole("radio", { name: "Existing local directory" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "lora-study" }),
  );
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Use this directory" }),
    ).toBeEnabled(),
  );
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "Directory path" }),
    { target: { value: "/not-opened" } },
  );
  expect(
    within(dialog).getByRole("button", { name: "Use this directory" }),
  ).toBeDisabled();
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "Directory path" }),
    { target: { value: "/projects/lora-study" } },
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Use this directory" }),
  );
  expect(screen.getByRole("textbox", { name: "Local directory" })).toHaveValue(
    "/projects/lora-study",
  );
  expect(fetch.mock.calls.some(([path]) => path === "/api/projects")).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await screen.findByRole("heading", { name: "Research overview" });
  expect(
    JSON.parse(
      String(
        fetch.mock.calls.find(([path]) => path === "/api/projects")![1]?.body,
      ),
    ).workspace,
  ).toEqual({ kind: "local", directory: "/projects/lora-study" });
});

it("does not reuse a successful directory check after the input changes", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  show((path, init) =>
    path === "/api/project-workspaces/validate" &&
    JSON.parse(String(init.body)).directory === "/old"
      ? pending
      : undefined,
  );
  await screen.findByRole("textbox", { name: "Project name" });
  fireEvent.click(
    screen.getByRole("radio", { name: "Existing local directory" }),
  );
  const field = screen.getByRole("textbox", { name: "Local directory" });
  fireEvent.change(field, { target: { value: "/old" } });
  fireEvent.blur(field);
  expect(await screen.findByText("Checking directory…")).toBeInTheDocument();
  fireEvent.change(field, { target: { value: "/new" } });
  release(Response.json({ workspace: { kind: "local", directory: "/old" } }));
  await waitFor(() =>
    expect(screen.queryByText("Directory is accessible")).toBeNull(),
  );
  expect(field).toHaveValue("/new");
});

it("completes SSH login in place without submitting the parent project form", async () => {
  const user = userEvent.setup();
  const profile: any = {
    id: hostId,
    name: "GPU server",
    revision: 1,
    status: "disconnected",
    challenge: null,
    error: null,
  };
  const fetch = show((path) => {
    if (path === "/api/ssh/connections")
      return Response.json({
        connections: [profile],
        current: { kind: "local" },
      });
    if (path.endsWith("/connect")) {
      profile.status = "authentication";
      profile.challenge = {
        id: "challenge",
        kind: "password",
        host: "gpu",
        port: 22,
        user: "researcher",
        prompts: [{ label: "SSH password", secret: true }],
      };
      return Response.json(profile);
    }
    if (path.endsWith("/respond")) {
      profile.status = "connected";
      profile.challenge = null;
      return Response.json(profile);
    }
    if (path.endsWith("/disconnect")) {
      profile.status = "disconnected";
      profile.challenge = null;
      return Response.json(profile);
    }
  });
  await user.type(
    await screen.findByRole("textbox", { name: "Project name" }),
    "Remote research",
  );
  await user.click(screen.getByRole("radio", { name: "SSH directory" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "SSH host" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "SSH host" }));
  await user.click(
    screen.getByRole("option", { name: "GPU server · Disconnected" }),
  );
  await user.click(screen.getByRole("button", { name: "Connect" }));
  let dialog = await screen.findByRole("dialog");
  await within(dialog).findByLabelText("Password");
  await user.click(
    within(dialog).getByRole("button", { name: "Cancel connection" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fetch.mock.calls.some(([path]) => path.endsWith("/disconnect"))).toBe(
    true,
  );
  await user.click(screen.getByRole("button", { name: "Connect" }));
  dialog = await screen.findByRole("dialog");
  await user.type(
    await within(dialog).findByLabelText("Password"),
    "synthetic-password",
  );
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  await user.click(await within(dialog).findByRole("button", { name: "Done" }));
  expect(fetch.mock.calls.some(([path]) => path === "/api/projects")).toBe(
    false,
  );
  expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue(
    "Remote research",
  );
  await user.type(
    screen.getByRole("textbox", { name: "Directory on the SSH host" }),
    "/srv/lora",
  );
  await user.click(screen.getByRole("button", { name: "Create project" }));
  await screen.findByRole("heading", { name: "Research overview" });
  expect(
    JSON.parse(
      String(
        fetch.mock.calls.find(([path]) => path === "/api/projects")![1]?.body,
      ),
    ).workspace,
  ).toEqual({ kind: "ssh", directory: "/srv/lora", connectionId: hostId });
});
