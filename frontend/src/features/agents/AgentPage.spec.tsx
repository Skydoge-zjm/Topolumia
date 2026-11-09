import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPage } from "./AgentPage";
import type { AgentSession } from "@/shared/types/api";
import { useUiStore } from "@/shared/state/ui";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listener?: (event: MessageEvent) => void;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.listener = listener;
  }
  close() {}
  cursor = 0;
  emit(type: string, payload: Record<string, unknown> = {}) {
    this.listener?.({
      data: JSON.stringify({
        id: `event-${++this.cursor}`,
        sessionId: "one",
        cursor: this.cursor,
        type,
        payload,
        occurredAt: "",
      }),
    } as MessageEvent);
  }
}

let rows: AgentSession[];
let requests: Array<{ path: string; body: Record<string, unknown> }>;
let actionError = "";
let releaseTurn: (() => void) | undefined;
let holdTurn = false;
let queryClient: QueryClient;
beforeEach(() => {
  for (const key of Object.keys(localStorage))
    if (key.startsWith("topolumia:agent:")) localStorage.removeItem(key);
  window.localStorage.setItem("research-workbench-project", "test-project");
  useUiStore.setState({
    locale: "zh",
    sessionRailCollapsed: false,
    agentFocus: false,
  });
  FakeEventSource.instances = [];
  rows = ["one", "two"].map((id) => ({
    id,
    title: `Session ${id}`,
    profileId: "fixture",
    status: "ready",
    createdAt: "",
    updatedAt: "",
    events: [],
    lastCursor: 0,
  }));
  requests = [];
  actionError = "";
  holdTurn = false;
  releaseTurn = undefined;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, options: RequestInit = {}) => {
      const path = String(input);
      if (path === "/api/collaboration/context") return Response.json({ permissions: ["*"], actor: { id: "fixture" } });
      const body = options.body ? JSON.parse(String(options.body)) : {};
      if (options.method === "PATCH") {
        const row =
          rows.find((row) => path.split("/").includes(row.id)) ?? rows[0];
        if (body.readCursor !== undefined)
          row.lastReadCursor = Number(body.readCursor);
        else {
          requests.push({ path, body });
          Object.assign(row, body);
        }
        return Response.json(row);
      }
      if (options.method === "POST" || options.method === "DELETE") {
        requests.push({ path, body });
        if (actionError)
          return Response.json(
            { error: { message: actionError } },
            { status: 409 },
          );
        if (options.method === "DELETE") {
          rows[0].queuedMessages = rows[0].queuedMessages?.filter(
            (message) => !path.endsWith(`/${message.id}`),
          );
          return Response.json(rows[0]);
        }
        if (path.endsWith("/turns") && holdTurn)
          await new Promise<void>((resolve) => {
            releaseTurn = resolve;
          });
        if (path.endsWith("/resume"))
          return Response.json({
            ...rows[0],
            status: "ready",
            runtimeInstanceId: "new-runtime",
          });
        if (
          path.endsWith("/turns") &&
          ["running", "awaiting_permission"].includes(rows[0].status)
        ) {
          const queued = {
            id: `q${requests.length}`,
            text: String(body.text),
            createdAt: "",
          };
          rows[0].queuedMessages = [...(rows[0].queuedMessages ?? []), queued];
          return Response.json({ ...queued, status: "queued" });
        }
        return Response.json({ id: "created", status: "ready" });
      }
      if (path === "/api/agent-profiles")
        return Response.json({
          profiles: [
            {
              id: "fixture",
              provider: "fixture",
              label: "Fixture",
              availability: "ready",
              model: "model",
              models: [{ id: "model", label: "Fixture model" }],
            },
          ],
        });
      if (
        path.startsWith("/api/agent-sessions?") ||
        path === "/api/agent-sessions"
      )
        return Response.json({ sessions: rows });
      if ((path.endsWith("/context") || path.endsWith("/research-changes")) && path.startsWith("/api/agent-sessions/"))
        return Response.json({ candidates: [], reads: [], selection: {} });
      if (path === "/api/research/context")
        return Response.json({ candidates: [] });
      return Response.json(
        rows.find((row) => path.endsWith(`/${row.id}`)) ?? rows[0],
      );
    }),
  );
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
});
async function open() {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "Session one" });
  await waitFor(() => expect(screen.getByRole("region", { name: "会话历史" })).toHaveAttribute("aria-busy", "false"));
  return userEvent.setup();
}

describe("Agent workspace interactions", () => {
  it("pauses work motion on connection loss and restores it only after the stream reconnects", async () => {
    rows[0].status = "running";
    await open();
    const body = document.querySelector(".conversation-body");
    expect(body).toHaveAttribute("data-motion-enabled", "true");
    act(() => FakeEventSource.instances.at(-1)!.onerror?.());
    expect(body).toHaveAttribute("data-motion-enabled", "false");
    expect(screen.getByText("连接已中断，正在重新连接…")).toBeVisible();
    act(() => FakeEventSource.instances.at(-1)!.onopen?.());
    await waitFor(() =>
      expect(body).toHaveAttribute("data-motion-enabled", "true"),
    );
  });
  it("navigates by message identity and supports keyboard selection without remounting the transcript", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    rows[0].conversationEvents = [
      {
        id: "q-one",
        cursor: 1,
        sessionId: "one",
        type: "user.message",
        payload: { text: "Same question" },
        occurredAt: "",
        turnId: "a",
      },
      {
        id: "a-one",
        cursor: 2,
        sessionId: "one",
        type: "assistant.message.completed",
        payload: { blockId: "answer1", text: "Earlier reply" },
        occurredAt: "",
        turnId: "a",
      },
      {
        id: "q-two",
        cursor: 3,
        sessionId: "one",
        type: "user.message",
        payload: { text: "Same question" },
        occurredAt: "",
        turnId: "b",
      },
    ];
    const user = await open();
    const scroll = document.querySelector<HTMLDivElement>(
      ".conversation-scroll",
    )!;
    const scrollTo = vi.fn();
    Object.defineProperty(scroll, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const first = screen.getByRole("button", {
      name: "定位到第 1 条用户消息：Same question",
    });
    const second = screen.getByRole("button", {
      name: "定位到第 2 条用户消息：Same question",
    });
    act(() => first.focus());
    await user.keyboard("{ArrowDown}");
    expect(second).toHaveFocus();
    await user.keyboard("{Home}{Enter}");
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(document.activeElement).toHaveAttribute(
      "data-user-message",
      "user:q-one",
    );
    expect(
      document.querySelector(".message.user.is-nav-target"),
    ).toHaveAttribute("data-user-message", "user:q-one");
    expect(document.querySelector(".conversation-scroll")).toBe(scroll);
    await user.click(screen.getByRole("button", { name: /Session two/ }));
    expect(screen.queryByRole("navigation", { name: "消息导航" })).toBeNull();
  });
  it("uses the composer control to stop with an empty draft and queue a message when there is input", async () => {
    rows[0].status = "running";
    const user = await open();
    const stop = screen.getByRole("button", { name: "停止 Agent" });
    expect(stop).toBeVisible();
    expect(stop).toBeEnabled();
    const input = screen.getByRole("textbox", { name: "研究消息" });
    expect(input).not.toBeDisabled();
    await user.type(input, "Follow-up task");
    expect(screen.queryByRole("button", { name: "停止 Agent" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "排队发送" }));
    expect(requests[0]).toMatchObject({
      path: "/api/agent-sessions/one/turns",
      body: { text: "Follow-up task" },
    });
    expect(
      await screen.findByRole("region", { name: "待发送消息" }),
    ).toHaveTextContent("Follow-up task");
    await waitFor(() => expect(input).toHaveValue(""));
    await user.click(screen.getByRole("button", { name: "停止 Agent" }));
    expect(requests.at(-1)?.path).toBe("/api/agent-sessions/one/cancel");
  });

  it("retains a session's queued messages across selection changes and removes only the requested entry", async () => {
    rows[0].status = "running";
    rows[0].queuedMessages = [
      { id: "q1", text: "Earlier queued", createdAt: "" },
      { id: "q2", text: "Keep queued", createdAt: "" },
    ];
    const user = await open();
    await user.click(screen.getByRole("button", { name: /Session two/ }));
    expect(screen.queryByRole("region", { name: "待发送消息" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Session one/ }));
    expect(
      screen.getByRole("region", { name: "待发送消息" }),
    ).toHaveTextContent("Earlier queued");
    await user.click(screen.getByRole("button", { name: "移除待发送消息 1" }));
    await waitFor(() =>
      expect(screen.queryByText("Earlier queued")).toBeNull(),
    );
    expect(screen.getByText("Keep queued")).toBeVisible();
    expect(requests.at(-1)?.path).toBe("/api/agent-sessions/one/queue/q1");
  });
  it("refreshes local records when native synchronization is not declared", async () => {
    const user = await open();
    const before = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).endsWith("/one")).length;
    await user.click(screen.getByRole("button", { name: "更多会话操作" }));
    await user.click(screen.getByRole("menuitem", { name: /^刷新记录$/ }));
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(([input]) => String(input).endsWith("/one"))
          .length,
      ).toBeGreaterThan(before),
    );
    expect(requests.some((request) => request.path.endsWith("/sync"))).toBe(
      false,
    );
  });
  it("renders durable conversation history even when the raw trace has rolled over", async () => {
    rows[0].events = [
      {
        id: "tail",
        sessionId: "one",
        cursor: 1500,
        type: "turn.completed",
        payload: {},
        occurredAt: "",
      },
    ];
    rows[0].lastCursor = 1500;
    rows[0].conversationEvents = [
      {
        id: "question",
        sessionId: "one",
        cursor: 1,
        type: "user.message",
        payload: { text: "Original user question" },
        occurredAt: "",
        turnId: "turn",
      },
      {
        id: "answer",
        sessionId: "one",
        cursor: 2,
        type: "assistant.message.completed",
        payload: { messageId: "answer", text: "Full earlier reply" },
        occurredAt: "",
        turnId: "turn",
      },
    ];
    await open();
    expect(await screen.findByText("Original user question")).toBeVisible();
    expect(screen.getByText("Full earlier reply")).toBeVisible();
  });
  it("preserves the reading position on new output and when switching sessions", async () => {
    const user = await open();
    const scroll = document.querySelector<HTMLDivElement>(
      ".conversation-scroll",
    )!;
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 300 },
    });
    scroll.scrollTop = 10;
    fireEvent.scroll(scroll);
    act(() =>
      queryClient.setQueryData<AgentSession>(
        ["agent-session", "test-project", "one"],
        (current) => ({
          ...current!,
          conversationEvents: [
            {
              id: "answer",
              sessionId: "one",
              cursor: 1,
              type: "assistant.message.delta",
              payload: { messageId: "answer", delta: "New output" },
              occurredAt: "",
            },
          ],
        }),
      ),
    );
    expect(await screen.findByText("New output")).toBeVisible();
    expect(scroll.scrollTop).toBe(10);
    await user.click(screen.getByRole("button", { name: /Session two/ }));
    await user.click(screen.getByRole("button", { name: /Session one/ }));
    const remounted = document.querySelector<HTMLDivElement>(
      ".conversation-scroll",
    )!;
    Object.defineProperty(remounted, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    act(() =>
      queryClient.setQueryData<AgentSession>(
        ["agent-session", "test-project", "one"],
        (current) => ({
          ...current!,
          conversationEvents: current!.conversationEvents!.map((event) => ({
            ...event,
            payload: { ...event.payload, delta: "Updated output" },
          })),
        }),
      ),
    );
    await waitFor(() => expect(remounted.scrollTop).toBe(10));
  });
  it("sends with Enter, preserves Shift+Enter and respects input composition", async () => {
    await open();
    const input = screen.getByRole("textbox", { name: "研究消息" });
    fireEvent.change(input, { target: { value: "Research task" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(requests).toHaveLength(0);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      path: "/api/agent-sessions/one/turns",
      body: { text: "Research task", reasoningEffort: "" },
    });
  });

  it("preserves another session's draft when the previous send completes", async () => {
    const user = await open();
    const input = screen.getByRole("textbox", { name: "研究消息" });
    fireEvent.change(input, { target: { value: "Send this" } });
    holdTurn = true;
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(releaseTurn).toBeTypeOf("function"));
    await user.click(screen.getByRole("button", { name: /Session two/ }));
    // A background request must not clear an existing draft in the newly selected session.
    releaseTurn!();
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    await user.click(screen.getByRole("button", { name: /Session one/ }));
    await user.click(screen.getByRole("button", { name: /Session two/ }));
    expect(input).toHaveValue("Keep this draft");
  });

  it("allows another message after a recoverable turn failure", async () => {
    rows[0].status = "running";
    const user = await open();
    rows[0].status = "ready";
    FakeEventSource.instances
      .at(-1)!
      .emit("turn.failed", {
        sessionStatus: "ready",
        error: { message: "Provider busy" },
      });
    fireEvent.change(screen.getByRole("textbox", { name: "研究消息" }), {
      target: { value: "Try again" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() =>
      expect(requests.some((request) => request.path.endsWith("/turns"))).toBe(
        true,
      ),
    );
  });

  it("shows approval errors and keeps the request available for retry", async () => {
    rows[0].status = "awaiting_permission";
    rows[0].events = [
      {
        id: "approval",
        sessionId: "one",
        cursor: 1,
        type: "approval.requested",
        payload: {
          requestId: "permission",
          reason: "Run command",
          options: [
            { optionId: "once", kind: "allow_once", scope: "once" },
            { optionId: "reject", kind: "reject_once", scope: "once" },
          ],
        },
        occurredAt: "",
        turnId: "turn",
      },
    ];
    const user = await open();
    actionError = "Permission request expired";
    await user.click(screen.getByRole("button", { name: "允许本次" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Permission request expired",
    );
    expect(screen.getByRole("button", { name: "允许本次" })).toBeEnabled();
  });

  it("resumes a detached session in place without replacing its history, selection or list entry", async () => {
    rows[0].status = "detached";
    rows[0].conversationEvents = [
      {
        id: "original-question",
        cursor: 1,
        sessionId: "one",
        type: "user.message",
        payload: { text: "Original research question" },
        occurredAt: "",
      },
    ];
    rows[0].lastCursor = 1;
    const user = await open();
    const conversation = document.querySelector(".conversation-scroll");
    fireEvent.change(screen.getByRole("textbox", { name: "研究消息" }), {
      target: { value: "Continue research" },
    });
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() =>
      expect(requests.map((request) => request.path)).toEqual([
        "/api/agent-sessions/one/resume",
        "/api/agent-sessions/one/turns",
      ]),
    );
    expect(screen.getByText("Original research question")).toBeVisible();
    expect(document.querySelector(".conversation-scroll")).toBe(conversation);
    expect(document.querySelectorAll(".session-list .session")).toHaveLength(2);
    expect(document.querySelector(".session.active")).toHaveTextContent(
      "Session one",
    );
  });
  it("keeps exactly one transcript and composer throughout streaming updates", async () => {
    rows[0].status = "running";
    await open();
    const stream = FakeEventSource.instances.at(-1)!;
    for (let i = 0; i < 20; i++)
      act(() =>
        stream.emit("assistant.message.delta", { blockId: "live", delta: "x" }),
      );
    await waitFor(() =>
      expect(document.querySelector(".message-body")).toHaveTextContent(
        "x".repeat(20),
      ),
    );
    expect(document.querySelectorAll(".conversation-body")).toHaveLength(1);
    expect(document.querySelectorAll(".composer")).toHaveLength(1);
    expect(document.querySelectorAll(".message-body")).toHaveLength(1);
  });

  it("allows typing during submission and preserves the next draft when the response arrives", async () => {
    const user = await open();
    const input = screen.getByRole("textbox", { name: "研究消息" });
    holdTurn = true;
    fireEvent.change(input, { target: { value: "Original submission" } });
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(releaseTurn).toBeTypeOf("function"));
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: "Next question" } });
    releaseTurn!();
    await waitFor(() => expect(input).toHaveValue("Next question"));
    expect(
      Object.values(localStorage).some((value) =>
        String(value).includes("Next question"),
      ),
    ).toBe(true);
    expect(requests[0].body.clientMessageId).toBeTypeOf("string");
  });

  it("retries an uncertain submission with its original ID while keeping a newer draft", async () => {
    const user = await open();
    const input = screen.getByRole("textbox", { name: "研究消息" });
    actionError = "Temporary offline";
    fireEvent.change(input, { target: { value: "Retry me" } });
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByText("Temporary offline");
    const id = requests[0].body.clientMessageId;
    fireEvent.change(input, { target: { value: "New draft" } });
    actionError = "";
    await user.click(screen.getByRole("button", { name: "重试原消息" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].body.clientMessageId).toBe(id);
    expect(input).toHaveValue("New draft");
  });

  it("restores an uncertain submission after refresh and reconciles an existing server acknowledgement", async () => {
    let user = await open();
    const input = screen.getByRole("textbox", { name: "研究消息" });
    actionError = "Uncertain network response";
    fireEvent.change(input, {
      target: { value: "Durable submitted question" },
    });
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByText("Uncertain network response");
    const clientMessageId = String(requests[0].body.clientMessageId);
    cleanup();
    queryClient.clear();
    user = await open();
    expect(
      await screen.findByRole("button", { name: "重试原消息" }),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "研究消息" })).toHaveValue(
      "Durable submitted question",
    );
    rows[0].turns = [
      {
        id: "acknowledged",
        sessionId: "one",
        status: "completed",
        clientMessageId,
        input: [{ type: "text", text: "Durable submitted question" }],
        assistantText: "Done",
        startedAt: "",
      },
    ];
    cleanup();
    queryClient.clear();
    await open();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "重试原消息" })).toBeNull(),
    );
    expect(screen.getByRole("textbox", { name: "研究消息" })).toHaveValue("");
    expect(requests).toHaveLength(1);
  });
});
