import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { projectId } from "../../../../shared/lib/api";
import type { AgentEvent, AgentSession } from "@/shared/types/api";
import {
  appendConversationEvent,
  compactConversationEvents,
} from "@domain/agents/agent-conversation";
import type { AgentUsageSnapshot } from "@domain/agents/agent-usage";
import type { AgentApproval } from "@domain/agents/agent-approval";
import { appendTraceEvent } from "@domain/agents/agent-trace";

const transitions = new Set([
  "session.status",
  "session.closed",
  "session.metadata.updated",
  "session.queue.updated",
  "session.research.updated",
  "driver.process.closed",
  "turn.started",
  "turn.cancelling",
  "turn.completed",
  "turn.cancelled",
  "turn.failed",
  "approval.requested",
  "approval.resolved",
]);

export function agentIsStopping(session?: AgentSession): boolean {
  return Boolean(
    session?.cancellingTurnId ||
    (["running", "awaiting_permission"].includes(session?.status ?? "") &&
      session?.turns?.some(
        (turn) => turn.status === "cancelling" && !turn.completedAt,
      )),
  );
}

export function applyAgentEvent(
  current: AgentSession,
  event: AgentEvent,
): AgentSession {
  if (
    event.sessionId !== current.id ||
    event.cursor <= (current.lastCursor ?? 0)
  )
    return current;
  const payload = event.payload;
  const terminal = [
    "turn.completed",
    "turn.cancelled",
    "turn.failed",
    "session.closed",
  ].includes(event.type);
  let status = current.status;
  let approvals = current.pendingApprovals ?? [];
  if (event.type === "session.status" && typeof payload.status === "string")
    status = payload.status;
  if (event.type === "turn.started") status = "running";
  if (
    event.type === "approval.requested" &&
    ["running", "awaiting_permission"].includes(current.status) &&
    !agentIsStopping(current)
  ) {
    status = "awaiting_permission";
    approvals = [
      ...approvals.filter((item) => item.requestId !== payload.requestId),
      { ...payload, turnId: event.turnId } as AgentApproval,
    ];
  }
  if (event.type === "approval.resolved") {
    approvals = approvals.filter(
      (item) => item.requestId !== payload.requestId,
    );
    if (current.status === "awaiting_permission")
      status = approvals.length ? "awaiting_permission" : "running";
  }
  if (["turn.completed", "turn.cancelled", "turn.failed"].includes(event.type))
    status = "ready";
  if (event.type === "driver.process.closed" && !payload.expected)
    status = "failed";
  if (event.type === "session.closed") status = "closed";
  if (typeof payload.sessionStatus === "string") status = payload.sessionStatus;
  return {
    ...current,
    status,
    updatedAt: event.occurredAt,
    ...(event.type === "session.persistence.updated"
      ? {
          historyStatus: payload.historyStatus as AgentSession["historyStatus"],
          historyError: payload.historyError as string | null,
        }
      : {}),
    pendingApprovals: terminal ? [] : approvals,
    ...(event.type === "session.metadata.updated"
      ? {
          title: String(payload.title ?? current.title),
          pinned: Boolean(payload.pinned),
          archived: Boolean(payload.archived),
        }
      : {}),
    latestMessageCursor:
      event.type === "user.message" ||
      event.type.startsWith("assistant.message.")
        ? event.cursor
        : current.latestMessageCursor,
    permissionGrants:
      event.type === "session.closed"
        ? []
        : payload.permissionGrant
          ? [
              ...(current.permissionGrants ?? []).filter(
                (grant) =>
                  grant.requestId !==
                  (payload.permissionGrant as { requestId: string }).requestId,
              ),
              payload.permissionGrant as NonNullable<
                AgentSession["permissionGrants"]
              >[number],
            ]
          : current.permissionGrants,
    activeTurnId: terminal
      ? null
      : event.type === "turn.started"
        ? event.turnId
        : current.activeTurnId,
    cancellingTurnId:
      terminal || event.type === "turn.started"
        ? null
        : event.type === "turn.cancelling"
          ? (event.turnId ?? String(payload.turnId ?? "pending"))
          : current.cancellingTurnId,
    queuedMessages:
      event.type === "session.queue.updated"
        ? (payload.queuedMessages as AgentSession["queuedMessages"])
        : current.queuedMessages,
    queuePaused:
      event.type === "session.queue.updated"
        ? Boolean(payload.queuePaused)
        : current.queuePaused,
    runtimeInstanceId:
      event.type === "session.status" &&
      typeof payload.runtimeInstanceId === "string"
        ? payload.runtimeInstanceId
        : current.runtimeInstanceId,
    usage:
      event.type === "usage.updated"
        ? (payload as AgentUsageSnapshot)
        : current.usage,
    lastCursor: event.cursor,
    events: appendTraceEvent(current.events ?? [], event).slice(
      -(current.eventRetention?.limit ?? 1000),
    ),
    conversationEvents: appendConversationEvent(
      current.conversationEvents ??
        compactConversationEvents(current.events ?? []),
      event,
    ),
  };
}

// A slower HTTP snapshot must not overwrite newer events already received by SSE.
export function mergeAgentSnapshot(
  snapshot: AgentSession,
  cached?: AgentSession,
): AgentSession {
  if (!cached || cached.id !== snapshot.id) return snapshot;
  const merged = (cached.events ?? [])
    .filter((event) => event.cursor > (snapshot.lastCursor ?? 0))
    .sort((a, b) => a.cursor - b.cursor)
    .reduce(applyAgentEvent, snapshot);
  if ((cached.lastCursor ?? 0) > (snapshot.lastCursor ?? 0)) {
    // Overlay absolute projections while retaining history recovered by HTTP.
    for (const event of cached.conversationEvents ?? []) {
      if ((event.updatedCursor ?? event.cursor) <= (snapshot.lastCursor ?? 0))
        continue;
      const absolute = appendTraceEvent([], event)[0];
      if (absolute)
        merged.conversationEvents = appendConversationEvent(
          merged.conversationEvents ?? [],
          absolute,
        );
    }
    for (const key of [
      "status",
      "activeTurnId",
      "cancellingTurnId",
      "pendingApprovals",
      "permissionGrants",
      "queuedMessages",
      "queuePaused",
      "usage",
      "runtimeInstanceId",
      "pinned",
      "title",
      "archived",
      "latestMessageCursor",
      "updatedAt",
      "historyStatus",
      "historyError",
    ] as const)
      Object.assign(merged, { [key]: cached[key] });
    merged.lastCursor = cached.lastCursor;
  }
  // A snapshot started before the stop request cannot clear its local intent.
  if (
    cached.cancellingTurnId &&
    !merged.cancellingTurnId &&
    ["running", "awaiting_permission"].includes(merged.status) &&
    (!merged.activeTurnId ||
      cached.cancellingTurnId === "pending" ||
      merged.activeTurnId === cached.cancellingTurnId)
  ) {
    return { ...merged, cancellingTurnId: cached.cancellingTurnId };
  }
  return merged;
}

export function useAgentSessionStream(
  sessionId: string | undefined,
  ready: boolean,
) {
  const queryClient = useQueryClient();
  const [disconnected, setDisconnected] = useState(false);
  const project = projectId();
  useEffect(() => {
    if (!sessionId || !ready) return;
    const key = ["agent-session", project, sessionId];
    const detail = queryClient.getQueryData<AgentSession>(key);
    const params = new URLSearchParams({
      after: String(detail?.lastCursor ?? 0),
    });
    if (project) params.set("projectId", project);
    const source = new EventSource(
      `/api/agent-sessions/${encodeURIComponent(sessionId)}/events?${params}`,
    );
    let frame = 0,
      refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: AgentEvent[] = [];
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({
        queryKey: ["agent-sessions", project],
      });
      void queryClient.invalidateQueries({
        queryKey: ["research-context", project],
      });
    };
    const flush = () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      queryClient.setQueryData<AgentSession>(key, (current) =>
        current ? batch.reduce(applyAgentEvent, current) : current,
      );
      if (batch.some((item) => transitions.has(item.type)) && !refreshTimer)
        refreshTimer = setTimeout(() => {
          refreshTimer = undefined;
          void queryClient.invalidateQueries({
            queryKey: ["agent-research-changes", project, sessionId],
          });
          void queryClient.invalidateQueries({
            queryKey: ["agent-research-context", project, sessionId],
          });
          refresh();
        }, 180);
    };
    const nextFrame = () => {
      frame = 0;
      if (pending.length) {
        flush();
        frame = requestAnimationFrame(nextFrame);
      }
    };
    source.onopen = () => {
      setDisconnected(false);
      refresh();
    };
    source.onerror = () => {
      setDisconnected(true);
    };
    source.addEventListener("access.revoked", () => {
      source.close();
      pending = [];
      setDisconnected(true);
      void queryClient.invalidateQueries({
        queryKey: ["collaboration-context", project],
      });
      void queryClient.invalidateQueries({
        queryKey: ["agent-sessions", project],
      });
    });
    source.addEventListener("session", (raw) => {
      try {
        const event = JSON.parse((raw as MessageEvent).data) as AgentEvent;
        pending.push(event);
        // Flush the first event immediately; only bursts inside the same
        // frame are batched. Normal token rates avoid an extra frame of delay.
        if (!frame) {
          flush();
          frame = requestAnimationFrame(nextFrame);
        }
      } catch {
        /* The next snapshot reconciles malformed or incomplete events. */
      }
    });
    return () => {
      source.close();
      cancelAnimationFrame(frame);
      clearTimeout(refreshTimer);
    };
  }, [project, queryClient, ready, sessionId]);
  return disconnected;
}
