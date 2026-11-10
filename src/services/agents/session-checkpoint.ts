import type { StoredAgentSession, AgentRuntimeSession } from "../../domain/agents/agent-types.js";
import { restoreConversationEvents } from "./agent-conversation-history.js";
import { traceFromConversation } from "../../domain/agents/agent-trace.js";
const clone = <T>(value: T): T =>
  structuredClone(value);
export function sessionCheckpoint(session: StoredAgentSession | AgentRuntimeSession) {
  const conversationEvents =
    session.conversationEvents ?? restoreConversationEvents(session);
  const latestMessageCursor =
    session.latestMessageCursor ??
    Math.max(
      0,
      ...conversationEvents
        .filter(
          (event) =>
            event.type === "user.message" ||
            event.type.startsWith("assistant.message."),
        )
        .map((event) => event.updatedCursor ?? event.cursor),
    );
  return {
    schemaVersion: session.schemaVersion,
    id: session.id,
    title: session.title,
    pinned: session.pinned ?? false,
    archived: session.archived ?? false,
    lastReadCursor: session.lastReadCursor ?? latestMessageCursor,
    latestMessageCursor,
    profileId: session.profileId,
    researchInterface: session.researchInterface,
    researchSessionId: session.researchSessionId,
    candidateTurns: session.candidateTurns ?? {},
    runtimeInstanceId: session.runtimeInstanceId,
    ownerUserId: session.ownerUserId,
    model: session.model ?? null,
    reasoningEffort: session.reasoningEffort ?? null,
    provider: session.provider,
    parentSessionId: session.parentSessionId ?? null,
    resumedFrom: session.resumedFrom ?? null,
    status: session.status,
    nativeSessionId: session.nativeSessionId,
    sync: clone(session.sync ?? null),
    nativeSnapshot: session.nativeSnapshot ?? null,
    usage: clone(session.usage ?? null),
    capabilities: clone(session.capabilities ?? {}),
    agentInfo: clone(session.agentInfo ?? null),
    authMethods: clone(session.authMethods ?? []),
    context: clone(session.context ?? {}),
    locale: session.locale,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    activeTurnId: session.activeTurnId ?? null,
    turns: session.turns ?? [],
    queuedMessages: clone(session.queuedMessages ?? []),
    queuePaused: session.queuePaused ?? false,
    pendingApprovals: Array.isArray(session.pendingApprovals)
      ? clone(session.pendingApprovals)
      : [...(session.pendingApprovals?.values?.() ?? [])].map(clone),
    lastCursor: Math.max(session.lastCursor ?? 0, "cursor" in session ? session.cursor : 0),
    events:
      session.traceFormat === "final.v1"
        ? (session.events ?? [])
        : traceFromConversation(conversationEvents, session.events ?? []),
    conversationEvents,
    traceDroppedEvents: session.traceDroppedEvents ?? 0,
    traceFormat: "final.v1",
    historyStatus: "persisted",
  };
}
