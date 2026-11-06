import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ChevronDown,
  ChevronUp,
  Search,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { agentStorageKey } from "@/features/agents/sessions/agentStorage";
import { createConversationProjector } from "@/features/agents/conversation/model/conversationProjector";
import { useConversationViewport } from "@/features/agents/conversation/useConversationViewport";
import { useTranscriptMotion } from "@/features/agents/motion/useTranscriptMotion";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import type { ConversationItem } from "@/features/agents/conversation/model/agentConversation";
import type { AgentEvent, AgentSession } from "@/shared/types/api";
import type { AgentApprovalSelection } from "@domain/agents/agent-approval";
import { ConversationItems } from "./ConversationItems";
import { WorkingIndicator } from "./WorkingIndicator";
import { ConversationNavigator } from "./ConversationNavigator";
import { useSessionResearch } from "../../research/useSessionResearch";
import { TurnResearchChanges } from "../../research/TurnResearchChanges";
import { useResearchPermissions } from "@/features/research/useResearch";
const noEvents: AgentEvent[] = [];

export function AgentTranscript({
  session,
  sessionId,
  en,
  ready,
  loading,
  loadError,
  onRetry,
  working,
  onSource,
  onSaved,
  onReview,
  searchTarget,
}: {
  session?: AgentSession;
  sessionId?: string;
  en: boolean;
  ready: boolean;
  loading?: boolean;
  loadError?: string;
  onRetry?: () => void;
  working: boolean;
  onSource: (ref: string, version?: string) => void;
  onSaved: (id: string) => void;
  onReview: (id: string, decision: string, revision: unknown) => Promise<void>;
  searchTarget?: { eventId: string; sequence: number };
}) {
  const loadingHistory = (loading ?? (!ready && Boolean(sessionId))) && !ready;
  const events = session?.conversationEvents ?? session?.events ?? noEvents;
  const permissions = useResearchPermissions();
  const projector = useRef(createConversationProjector());
  const items = useMemo(
    () => projector.current(events, Boolean(session?.conversationEvents)),
    [events, session?.conversationEvents],
  );
  const research = useSessionResearch(session, events);
  const turnChanges = useMemo(() => {
    const settled = new Set(
      session?.turns?.filter((turn) => turn.completedAt).map((turn) => turn.id),
    );
    for (const event of events)
      if (
        event.turnId &&
        ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.type)
      )
        settled.add(event.turnId);
    const lastRows = new Map(items.map((item) => [item.turnKey, item.key]));
    for (const item of items) {
      if (item.kind === "message" && item.role === "assistant" && !item.streaming && item.phase !== "commentary")
        lastRows.set(item.turnKey, item.key);
    }
    return new Map(
      items
        .filter(
          (item) =>
            settled.has(item.turnKey ?? "") &&
            lastRows.get(item.turnKey) === item.key,
        )
        .map((item) => [
          item.key,
          research.data?.candidates?.filter(
            (candidate) => candidate.turnId === item.turnKey,
          ) ?? [],
        ]),
    );
  }, [session?.turns, events, items, research.data?.candidates]);
  const scrollRef = useRef<HTMLDivElement>(null),
    client = useQueryClient();
  const [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState(""),
    [match, setMatch] = useState(0);
  const lastRead = useRef(0),
    readInFlight = useRef(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const onRead = useCallback(() => {
    const value = sessionRef.current,
      cursor = value?.latestMessageCursor ?? value?.lastCursor ?? 0;
    if (
      !value ||
      !cursor ||
      readInFlight.current ||
      cursor <= Math.max(lastRead.current, value.lastReadCursor ?? 0)
    )
      return;
    readInFlight.current = true;
    void api(`/api/agent-sessions/${encodeURIComponent(value.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ readCursor: cursor }),
    })
      .then(() => {
        lastRead.current = cursor;
        client.setQueryData<{ sessions: AgentSession[] }>(
          ["agent-sessions", projectId()],
          (current) =>
            current
              ? {
                  ...current,
                  sessions: current.sessions.map((row) =>
                    row.id === value.id
                      ? { ...row, lastReadCursor: cursor }
                      : row,
                  ),
                }
              : current,
        );
      })
      .catch(() => {})
      .finally(() => {
        readInFlight.current = false;
      });
  }, [client]);
  const viewport = useConversationViewport({
    scrollRef,
    storageKey: agentStorageKey("reading", sessionId),
    ready,
    revision: session?.latestMessageCursor ?? session?.lastCursor ?? 0,
    onRead,
  });
  useTranscriptMotion({
    events,
    cursor: session?.lastCursor ?? 0,
    ready,
    working,
    scrollRef,
    onInspect: viewport.pause,
  });
  const approval = useCallback(
    async (id: string, selection: AgentApprovalSelection) => {
      if (!session?.id) return;
      try {
        await api(
          `/api/agent-sessions/${encodeURIComponent(session.id)}/approvals/${encodeURIComponent(id)}`,
          { method: "POST", body: JSON.stringify(selection) },
        );
      } finally {
        await Promise.all([
          client.invalidateQueries({ queryKey: ["agent-session", projectId(), session.id] }),
          client.invalidateQueries({ queryKey: ["collaboration-context", projectId()] }),
        ]);
      }
    },
    [client, session?.id],
  );
  const save = useCallback(
    async (item: ConversationItem) => {
      const id = sessionRef.current?.id;
      if (!id) return;
      await api(`/api/agent-sessions/${encodeURIComponent(id)}/notes`, {
        method: "POST",
        body: JSON.stringify({ eventIds: item.sourceEventIds }),
      });
      onSaved(id);
    },
    [onSaved],
  );
  const messages = useMemo(() => {
    const flat = (rows: ConversationItem[]): ConversationItem[] =>
      rows.flatMap((item) =>
        item.kind === "message" ? [item] : flat(item.children ?? []),
      );
    return flat(items);
  }, [items]);
  const matches = useMemo(
    () =>
      query.trim()
        ? messages.filter((item) =>
            item.text
              ?.toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase()),
          )
        : [],
    [messages, query],
  );
  const jump = viewport.jump;
  const revealAndJump = useCallback(
    (key: string) => {
      let attempts = 0;
      const reveal = () => {
        const scroll = scrollRef.current;
        if (!scroll) return;
        if (
          [...scroll.querySelectorAll<HTMLElement>("[data-message-key]")].some(
            (node) => node.dataset.messageKey === key,
          )
        ) {
          jump(key);
          return;
        }
        for (const details of scroll.querySelectorAll<HTMLDetailsElement>(
          ".subagent-group",
        ))
          details.open = true;
        if (++attempts < 10) requestAnimationFrame(reveal);
      };
      reveal();
    },
    [jump],
  );
  const lastTarget = useRef(0);
  useEffect(() => {
    if (!ready || !searchTarget || lastTarget.current === searchTarget.sequence)
      return;
    const target = messages.find(
      (item) =>
        item.sourceEventIds?.includes(searchTarget.eventId) ||
        item.key === `user:${searchTarget.eventId}`,
    );
    if (!target) return;
    lastTarget.current = searchTarget.sequence;
    revealAndJump(target.key);
  }, [ready, searchTarget, messages, revealAndJump]);
  const find = (index: number) => {
    const next = (index + matches.length) % matches.length;
    setMatch(next);
    const target = matches[next];
    if (target) {
      // Search can reveal a lazily mounted subagent message before positioning it.
      revealAndJump(target.key);
    }
  };
  const pending = session?.pendingApprovals ?? [];
  const revealApproval = () => {
    viewport.pause();
    const target = scrollRef.current?.querySelector<HTMLElement>(
      ".agent-approval.is-pending",
    );
    target?.scrollIntoView({ block: "start", behavior: "auto" });
  };
  return (
    <div
      className="conversation-body"
      data-motion-enabled={working}
      data-long-conversation={messages.length > 300 || undefined}
    >
      <div className="transcript-controls">
        <button
          className="icon-button"
          aria-label={en ? "Search this conversation" : "搜索当前会话"}
          onClick={() => setSearchOpen((open) => !open)}
        >
          <Search size={14} />
        </button>
        {pending.length > 0 && (
          <button className="pending-approval-link" onClick={revealApproval}>
            {en
              ? `${pending.length} approvals waiting · View`
              : `等待 ${pending.length} 项操作授权 · 查看`}
          </button>
        )}
      </div>
      {searchOpen && (
        <div className="transcript-search">
          <Search size={14} />
          <input
            autoFocus
            aria-label={en ? "Conversation search" : "会话内搜索"}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMatch(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches.length)
                find(e.shiftKey ? match - 1 : match);
              if (e.key === "Escape") setSearchOpen(false);
            }}
            placeholder={en ? "Search messages…" : "搜索消息内容…"}
          />
          <small>
            {matches.length
              ? `${match + 1}/${matches.length}`
              : en
                ? "No matches"
                : "无匹配"}
          </small>
          <button
            disabled={!matches.length}
            aria-label={en ? "Previous match" : "上一项匹配"}
            onClick={() => find(match - 1)}
          >
            <ChevronUp size={14} />
          </button>
          <button
            disabled={!matches.length}
            aria-label={en ? "Next match" : "下一项匹配"}
            onClick={() => find(match + 1)}
          >
            <ChevronDown size={14} />
          </button>
          <button
            aria-label={en ? "Close search" : "关闭搜索"}
            onClick={() => setSearchOpen(false)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <ConversationNavigator
        items={items}
        scrollRef={scrollRef}
        en={en}
        onNavigate={viewport.pause}
      />
      <div className="conversation-scroll" ref={scrollRef} role="region" aria-label={en ? "Conversation history" : "会话历史"} aria-busy={loadingHistory}>
        <div className="conversation-content">
          {loadError && <div className="form-error" role="alert">{loadError}{onRetry && <button className="button" onClick={onRetry}>{en ? "Retry" : "重试"}</button>}</div>}
          {loadingHistory ? (
            <LoadingSkeleton layout="conversation" label={en ? "Loading conversation…" : "正在读取会话…"} />
          ) : loadError && !ready ? null : !items.length ? (
            <div className="conversation-empty">
              <strong>
                {sessionId ? (en ? "No messages" : "暂无消息") : (en ? "No conversation selected" : "尚未选择会话")}
              </strong>
            </div>
          ) : (
            <ConversationItems
              items={items}
              en={en}
              groupActivities={false}
              onApproval={approval}
              canApproveHighRisk={permissions.approveHighRisk}
              onSave={save}
              onSource={onSource}
              afterItem={(item) => (
                <TurnResearchChanges
                  candidates={turnChanges.get(item.key) ?? []}
                  en={en}
                  onReview={onReview}
                />
              )}
            />
          )}
          {research.error && (
            <div className="agent-turn-changes" role="alert">
              {en ? "Could not load research changes." : "科研变更读取失败。"}
              <button
                type="button"
                className="button"
                onClick={() => void research.refetch()}
              >
                {en ? "Retry" : "重试"}
              </button>
            </div>
          )}
          <div
            className="conversation-work-status"
            data-motion-fallback="true"
            data-motion-candidate="true"
            data-state="running"
            hidden
          >
            <WorkingIndicator
              session={session}
              events={session?.conversationEvents ?? []}
              en={en}
            />
          </div>
        </div>
      </div>
      {!viewport.following && (
        <button className="conversation-latest" onClick={viewport.latest}>
          <ArrowDown size={14} />
          {viewport.hasNew
            ? en
              ? "New content · Jump to latest"
              : "有新内容 · 回到最新"
            : en
              ? "Jump to latest"
              : "回到最新"}
        </button>
      )}
    </div>
  );
}
