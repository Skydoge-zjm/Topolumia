import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Search,
} from "lucide-react";
import type { AgentSession } from "@/shared/types/api";
import {
  agentStatus,
  sessionGroup,
} from "@/features/agents/conversation/model/agentPresentation";
import { AgentIcon } from "../icons/AgentIcon";

export function AgentSessionRail({
  sessions,
  activeId,
  collapsed,
  floating = false,
  en,
  pending,
  onSelect,
  onCreate,
  onToggle,
  onUpdate,
}: {
  sessions: AgentSession[];
  activeId?: string;
  collapsed: boolean;
  en: boolean;
  pending: boolean;
  floating?: boolean;
  onSelect: (id: string, eventId?: string) => void;
  onCreate: () => void;
  onToggle: () => void;
  onUpdate: (
    id: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ) => Promise<void>;
}) {
  const [query, setQuery] = useState(""),
    [archived, setArchived] = useState(false),
    [editing, setEditing] = useState<string>(),
    [name, setName] = useState(""),
    [error, setError] = useState("");
  const [fullText, setFullText] = useState(false),
    [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(timer);
  }, [query]);
  const search = useQuery({
    queryKey: ["agent-message-search", projectId(), debounced, archived],
    enabled: fullText && Boolean(debounced),
    queryFn: () =>
      api<{
        matches: Array<{
          sessionId: string;
          eventId: string;
          title: string;
          snippet: string;
        }>;
        limited?: boolean;
      }>(
        `/api/agent-sessions/search?${new URLSearchParams({ q: debounced, includeArchived: String(archived) })}`,
      ),
  });
  const rows = useMemo(
    () =>
      sessions
        .filter(
          (session) =>
            Boolean(session.archived) === archived &&
            session.title
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase()),
        )
        .sort(
          (a, b) =>
            Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
            b.updatedAt.localeCompare(a.updatedAt),
        ),
    [sessions, query, archived],
  );
  const update = async (id: string, patch: Parameters<typeof onUpdate>[1]) => {
    setError("");
    try {
      await onUpdate(id, patch);
      setEditing(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    }
  };
  let group = "";
  return (
    <aside
      className={`agent-panel session-rail ${floating ? "is-floating" : ""}`}
    >
      <div className="session-rail-head">
        {!collapsed && <strong>{en ? "Conversations" : "会话"}</strong>}
        <button
          className="session-rail-toggle"
          onClick={onToggle}
          aria-label={
            collapsed
              ? en
                ? "Expand sessions"
                : "展开会话列表"
              : en
                ? "Collapse sessions"
                : "折叠会话列表"
          }
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>
      <button
        className="session-new"
        onClick={onCreate}
        aria-label={en ? "New session" : "新建会话"}
        title={en ? "New session" : "新建会话"}
      >
        <Plus size={16} />
        {!collapsed && (en ? "New session" : "新建会话")}
      </button>
      {!collapsed && (
        <>
          <label className="session-search">
            <Search size={14} />
            <input
              aria-label={en ? "Search sessions" : "搜索会话"}
              placeholder={en ? "Search conversations…" : "搜索会话…"}
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {query && (
            <button
              type="button"
              className="session-fulltext"
              aria-pressed={fullText}
              onClick={() => setFullText((value) => !value)}
            >
              {en ? "Search message contents" : "搜索消息全文"}
            </button>
          )}
          <div className="session-filters">
            <button aria-pressed={!archived} onClick={() => setArchived(false)}>
              {en ? "Recent" : "最近"}
            </button>
            <button aria-pressed={archived} onClick={() => setArchived(true)}>
              {en ? "Archived" : "归档"}
              <small>{sessions.filter((s) => s.archived).length || ""}</small>
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="session-list">
        {!collapsed && fullText && query ? (
          <>
            <small>
              {search.isFetching
                ? en
                  ? "Searching…"
                  : "正在搜索…"
                : search.error
                  ? search.error.message
                  : en
                    ? `${search.data?.matches.length ?? 0} matches`
                    : `${search.data?.matches.length ?? 0} 项匹配`}
            </small>
            {search.data?.matches.map((result) => (
              <button
                className="session-search-result"
                key={`${result.sessionId}:${result.eventId}`}
                onClick={() => onSelect(result.sessionId, result.eventId)}
              >
                <strong translate="no">{result.title}</strong>
                <span translate="no">{result.snippet}</span>
              </button>
            ))}
          </>
        ) : rows.length ? (
          rows.map((session) => {
            const label = sessionGroup(session, en),
              showGroup = !collapsed && group !== label;
            group = label;
            const unread =
              (session.latestMessageCursor ?? 0) >
              (session.lastReadCursor ?? 0);
            return (
              <div className="session-row" key={session.id}>
                {showGroup && (
                  <div className="session-group-title">{label}</div>
                )}
                {editing === session.id ? (
                  <form
                    className="session-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void update(session.id, { title: name });
                    }}
                  >
                    <input
                      autoFocus
                      aria-label={en ? "Session name" : "会话名称"}
                      maxLength={120}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setEditing(undefined);
                      }}
                    />
                    <button type="submit" disabled={pending || !name.trim()}>
                      {en ? "Save" : "保存"}
                    </button>
                  </form>
                ) : (
                  <button
                    className={`session ${session.id === activeId ? "active" : ""}`}
                    onClick={() => onSelect(session.id)}
                    title={session.title}
                  >
                    <span className="session-mark">
                      <AgentIcon
                        profile={{
                          id: session.profileId,
                          provider: session.provider,
                        }}
                        size={14}
                      />
                    </span>
                    {!collapsed && (
                      <span className="session-copy">
                        <strong translate="no">
                          {session.pinned && (
                            <Pin size={11} aria-hidden="true" />
                          )}
                          {session.title}
                        </strong>
                        <small>
                          {agentStatus(session.status, en)}
                          {Boolean(session.pendingApprovals?.length) && (
                            <span className="session-approval-count">
                              {session.pendingApprovals!.length}{" "}
                              {en ? "approvals" : "项审批"}
                            </span>
                          )}
                        </small>
                      </span>
                    )}
                    {unread && (
                      <i
                        className="session-unread"
                        aria-label={en ? "Unread" : "未读"}
                      />
                    )}
                  </button>
                )}
                {!collapsed && editing !== session.id && (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        className="session-menu-trigger"
                        aria-label={en ? "Session actions" : "会话操作"}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        className="agent-menu"
                        align="start"
                        sideOffset={5}
                      >
                        <DropdownMenu.Item
                          onSelect={() => {
                            setEditing(session.id);
                            setName(session.title);
                          }}
                        >
                          <Pencil size={14} />
                          {en ? "Rename" : "重命名"}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          onSelect={() =>
                            void update(session.id, { pinned: !session.pinned })
                          }
                        >
                          <Pin size={14} />
                          {session.pinned
                            ? en
                              ? "Unpin"
                              : "取消置顶"
                            : en
                              ? "Pin"
                              : "置顶"}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          disabled={
                            pending ||
                            [
                              "running",
                              "awaiting_permission",
                              "starting",
                              "closing",
                            ].includes(session.status)
                          }
                          onSelect={() =>
                            void update(session.id, {
                              archived: !session.archived,
                            })
                          }
                        >
                          {session.archived ? (
                            <ArchiveRestore size={14} />
                          ) : (
                            <Archive size={14} />
                          )}
                          {session.archived
                            ? en
                              ? "Restore conversation"
                              : "恢复会话"
                            : en
                              ? "Archive conversation"
                              : "归档会话"}
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}
              </div>
            );
          })
        ) : (
          !collapsed && (
            <div className="session-empty">
              {query
                ? en
                  ? "No matching conversations"
                  : "没有匹配的会话"
                : archived
                  ? en
                    ? "No archived conversations"
                    : "暂无归档会话"
                  : en
                    ? "No conversations"
                    : "暂无会话"}
            </div>
          )
        )}
      </div>
    </aside>
  );
}
