import { describe, expect, it } from "vitest";
import {
  agentIsStopping,
  applyAgentEvent,
  mergeAgentSnapshot,
} from "./agentSession";
import { normalizeConversation } from "./agentConversation";
import { buildAgentTrace } from "../../trace/agentTrace";
import type { AgentEvent, AgentSession } from "@/shared/types/api";

const session: AgentSession = {
  id: "s",
  title: "Session",
  profileId: "p",
  status: "running",
  createdAt: "",
  updatedAt: "",
  lastCursor: 0,
  events: [],
};
const event = (
  cursor: number,
  type: string,
  payload: Record<string, unknown> = {},
  turnId = "turn",
): AgentEvent => ({
  id: `e${cursor}`,
  cursor,
  sessionId: "s",
  type,
  payload,
  occurredAt: "",
  turnId,
});

describe("Agent stream state", () => {
  it("bounds raw trace snapshots and preserves newer queue state plus HTTP-recovered history", () => {
    let streamed: AgentSession = { ...session, conversationEvents: [] };
    for (let cursor = 1; cursor <= 4000; cursor++) streamed = applyAgentEvent(streamed, event(cursor, "assistant.message.delta", { blockId: "reply", delta: "a" }));
    expect(streamed.events).toHaveLength(1);
    expect(streamed.conversationEvents).toHaveLength(1);
    streamed = applyAgentEvent(streamed, event(4001, "session.queue.updated", { queuedMessages: [{ id: "q", text: "next", createdAt: "" }], queuePaused: true }));
    const older = { ...session, lastCursor: 3990, conversationEvents: [event(0, "user.message", { text: "Recovered question" }), event(3990, "assistant.message.snapshot", { blockId: "reply", text: "a".repeat(3990) })] };
    const merged = mergeAgentSnapshot(older, streamed);
    expect(merged.queuedMessages).toHaveLength(1);
    expect(merged.queuePaused).toBe(true);
    expect(normalizeConversation(merged.conversationEvents!).map(row => row.text)).toEqual(["Recovered question", "a".repeat(4000)]);
  });
  it("keeps stopping visible until a terminal event or settled snapshot arrives", () => {
    const running = applyAgentEvent(session, event(1, "turn.started"));
    const stopping = applyAgentEvent(running, event(2, "turn.cancelling"));
    expect(stopping.status).toBe("running");
    expect(agentIsStopping(stopping)).toBe(true);
    const paused = applyAgentEvent(
      stopping,
      event(3, "session.queue.updated", {
        queuedMessages: [],
        queuePaused: true,
      }),
    );
    expect(agentIsStopping(paused)).toBe(true);
    expect(
      agentIsStopping(
        applyAgentEvent(
          paused,
          event(4, "turn.cancelled", { sessionStatus: "ready" }),
        ),
      ),
    ).toBe(false);
    expect(
      agentIsStopping({
        ...session,
        turns: [
          {
            id: "turn",
            sessionId: "s",
            status: "cancelling",
            input: [],
            assistantText: "",
            startedAt: "",
          },
        ],
      }),
    ).toBe(true);
    const pending = { ...running, cancellingTurnId: "turn" };
    expect(agentIsStopping(mergeAgentSnapshot(running, pending))).toBe(true);
    expect(
      agentIsStopping(
        mergeAgentSnapshot(
          { ...running, status: "ready", activeTurnId: null },
          pending,
        ),
      ),
    ).toBe(false);
    expect(
      agentIsStopping(
        mergeAgentSnapshot({ ...running, activeTurnId: "next" }, pending),
      ),
    ).toBe(false);
  });
  it("updates the durable queue without adding queued text to the conversation", () => {
    const result = applyAgentEvent(
      session,
      event(1, "session.queue.updated", {
        queuedMessages: [{ id: "q", text: "Follow up", createdAt: "" }],
        queuePaused: true,
      }),
    );
    expect(result.queuedMessages?.[0].text).toBe("Follow up");
    expect(result.queuePaused).toBe(true);
    expect(result.conversationEvents).toHaveLength(0);
  });
  it("rotates runtime identity through SSE while keeping the conversation identity and content", () => {
    const current = applyAgentEvent(
      session,
      event(1, "user.message", { text: "Earlier question" }),
    );
    const resumed = applyAgentEvent(
      current,
      event(2, "session.status", {
        status: "ready",
        runtimeInstanceId: "replacement",
      }),
    );
    expect(resumed.id).toBe(session.id);
    expect(resumed.runtimeInstanceId).toBe("replacement");
    expect(
      resumed.conversationEvents?.some(
        (item) => item.payload.text === "Earlier question",
      ),
    ).toBe(true);
  });
  it("keeps a failed turn retryable and ignores already applied events", () => {
    const failed = event(1, "turn.failed", { sessionStatus: "ready" });
    const result = applyAgentEvent(session, failed);
    expect(result.status).toBe("ready");
    expect(applyAgentEvent(result, failed)).toBe(result);
  });
  it("does not revive a completed turn when an approval response arrives late", () => {
    const ready = applyAgentEvent(session, event(1, "turn.completed"));
    expect(
      applyAgentEvent(
        ready,
        event(2, "approval.resolved", {
          requestId: "permission",
          sessionStatus: "ready",
        }),
      ).status,
    ).toBe("ready");
  });
  it("merges newer SSE events over an older HTTP response without duplication", () => {
    const cached = applyAgentEvent(
      session,
      event(2, "assistant.message.delta", {
        messageId: "m",
        delta: "new text",
      }),
    );
    const merged = mergeAgentSnapshot({ ...session, lastCursor: 1 }, cached);
    expect(merged.lastCursor).toBe(2);
    expect(merged.events).toHaveLength(1);
  });
  it("preserves the complete conversation through a truncated snapshot and newer SSE deltas", () => {
    const user = event(1, "user.message", { text: "Original question" });
    const first = event(2, "assistant.message.delta", {
      messageId: "answer",
      delta: "Beginning ",
    });
    const snapshot = {
      ...session,
      lastCursor: 1002,
      events: [event(1002, "provider.event")],
      conversationEvents: [user, first],
    };
    const cached = applyAgentEvent(
      snapshot,
      event(1003, "assistant.message.delta", {
        messageId: "answer",
        delta: "and ending",
      }),
    );
    const merged = mergeAgentSnapshot(snapshot, cached);
    const items = normalizeConversation(merged.conversationEvents!);
    expect(
      items.filter((i) => i.kind === "message").map((i) => i.text),
    ).toEqual(["Original question", "Beginning and ending"]);
    expect(merged.events).toHaveLength(2);
    const completed = applyAgentEvent(
      merged,
      event(1004, "assistant.message.completed", {
        messageId: "answer",
        text: "Complete authoritative answer",
      }),
    );
    expect(
      normalizeConversation(completed.conversationEvents!).at(-1)?.text,
    ).toBe("Complete authoritative answer");
    expect(completed.conversationEvents).toHaveLength(2);
  });
});

describe("Agent conversation", () => {
  it("keeps reasoning phases around tools and replaces final snapshots without concatenating them", () => {
    const items = normalizeConversation([
      event(1, "reasoning.summary.delta", {
        messageId: "m",
        summaryIndex: 0,
        delta: "Partial",
      }),
      event(2, "reasoning.summary.completed", {
        messageId: "m",
        summaryIndex: 0,
        text: "First phase",
      }),
      event(3, "tool.started", { toolCallId: "read", title: "Read" }),
      event(4, "tool.completed", { toolCallId: "read" }),
      event(5, "reasoning.summary.completed", {
        messageId: "m",
        summaryIndex: 1,
        text: "First phase",
      }),
      event(6, "reasoning.summary.delta", {
        messageId: "next",
        delta: "Next phase",
      }),
      event(7, "turn.completed"),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "reasoning",
      "tool",
      "reasoning",
      "reasoning",
    ]);
    expect(
      items
        .filter((item) => item.kind === "reasoning")
        .map((item) => item.text),
    ).toEqual(["First phase", "First phase", "Next phase"]);
    expect(
      items
        .filter((item) => item.kind === "reasoning")
        .every((item) => !item.streaming),
    ).toBe(true);
  });
  it("keeps one final reasoning record for each native block in trace", () => {
    const groups = buildAgentTrace([
      event(1, "reasoning.summary.delta", {
        messageId: "m",
        blockIndex: 0,
        delta: "Partial",
      }),
      event(2, "reasoning.summary.completed", {
        messageId: "m",
        blockIndex: 0,
        text: "Full text",
      }),
      event(3, "reasoning.summary.completed", {
        messageId: "m",
        blockIndex: 1,
        text: "Other block",
      }),
    ]);
    expect(groups.map((group) => group.text)).toEqual([
      "Full text",
      "Other block",
    ]);
    expect(groups[0].events).toHaveLength(1);
  });
  it("preserves separate native message IDs and identical replies", () => {
    const items = normalizeConversation([
      event(1, "assistant.message.delta", { messageId: "a", delta: "First" }),
      event(2, "assistant.message.delta", { messageId: "b", delta: "Same" }),
      event(3, "assistant.message.completed", { messageId: "b", text: "Same" }),
      event(4, "assistant.message.completed", { messageId: "c", text: "Same" }),
    ]);
    expect(
      items.filter((i) => i.kind === "message").map((i) => i.text),
    ).toEqual(["First", "Same", "Same"]);
  });
  it("stops streaming and retires approvals after failure or cancellation", () => {
    const items = normalizeConversation([
      event(1, "assistant.message.delta", { messageId: "a", delta: "Partial" }),
      event(2, "approval.requested", { requestId: "permission" }),
      event(3, "turn.failed", { error: { message: "Network failed" } }),
    ]);
    expect(items[0].streaming).toBe(false);
    expect(items.find((i) => i.kind === "approval")?.status).toBe("resolved");
  });
  it("keeps repeated tool IDs in separate turns and preserves each tool output", () => {
    const items = normalizeConversation([
      event(1, "tool.started", {
        toolCallId: "call",
        item: { command: "echo first" },
      }),
      event(2, "tool.completed", {
        toolCallId: "call",
        item: { output: "first" },
      }),
      event(
        3,
        "tool.started",
        { toolCallId: "call", item: { command: "echo second" } },
        "next",
      ),
      event(
        4,
        "tool.completed",
        { toolCallId: "call", item: { output: "second" } },
        "next",
      ),
    ]).filter((i) => i.kind === "tool");
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.status)).toEqual(["completed", "completed"]);
    expect(items[0].events?.at(-1)?.payload.item).toMatchObject({
      output: "first",
      command: "echo first",
    });
  });
});
