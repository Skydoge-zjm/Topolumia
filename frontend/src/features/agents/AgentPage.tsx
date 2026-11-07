import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelRight,
  ShieldCheck,
  FileCheck2,
} from "lucide-react";
import { api, ApiClientError, projectId } from "@/shared/lib/api";
import {
  agentStorageKey,
  readAgentStorage,
  writeAgentStorage,
} from "@/features/agents/sessions/agentStorage";
import {
  useAgentDetail,
  useAgentProfiles,
  useAgentSessions,
} from "@/features/agents/sessions/agentQueries";
import {
  agentIsStopping,
  mergeAgentSnapshot,
  useAgentSessionStream,
} from "@/features/agents/conversation/model/agentSession";
import { agentStatus } from "@/features/agents/conversation/model/agentPresentation";
import { useUiStore } from "@/shared/state/ui";
import type { AgentSession } from "@/shared/types/api";
import { useAgentAttachmentDraft } from "./conversation/useAgentAttachmentDraft";
import {
  AgentComposer,
} from "@/features/agents/conversation/components/AgentComposer";
import { AgentSessionRail } from "@/features/agents/sessions/AgentSessionRail";
import { AgentResearchDrawer } from "@/features/agents/research/AgentResearchDrawer";
import { AgentTranscript } from "@/features/agents/conversation/components/AgentTranscript";
import { Skeleton } from "@/shared/ui/LoadingSkeleton";
import { WorkingIndicator } from "@/features/agents/conversation/components/WorkingIndicator";
import { AgentIcon } from "@/features/agents/icons/AgentIcon";
import { AgentHistoryStatus } from "./sessions/AgentHistoryStatus";
import { useAgentSubmission } from "./conversation/useAgentSubmission";
import { SelectMenu } from "@/shared/ui/SelectMenu";

const effortLabels: Record<string, [string, string]> = {
  minimal: ["极简", "Minimal"],
  low: ["低", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["很高", "Very high"],
  max: ["最高", "Max"],
  ultra: ["极高", "Ultra"],
};

export function AgentPage() {
  const [params] = useSearchParams();
  const focusedCandidateId = params.get("candidate") ?? undefined;
  const project = projectId(),
    client = useQueryClient();
  const profiles = useAgentProfiles(),
    sessions = useAgentSessions();
  const rows = sessions.data?.sessions ?? [];
  const [selected, setSelected] = useState(() =>
    readAgentStorage<string | undefined>(
      agentStorageKey("selected"),
      undefined,
    ),
  );
  const activeId = rows.some((row) => row.id === selected)
    ? selected
    : (rows.find((row) => !row.archived)?.id ?? rows[0]?.id);
  const detail = useAgentDetail(activeId),
    session = detail.data?.id === activeId ? detail.data : undefined;
  const summary = rows.find(row => row.id === activeId);
  const loadingSession = sessions.isPending || Boolean(activeId && detail.isPending);
  const {
    locale,
    agentFocus,
    toggleAgentFocus,
    sessionRailCollapsed,
    toggleSessionRail,
  } = useUiStore();
  const en = locale === "en",
    disconnected = useAgentSessionStream(activeId, Boolean(session));
  const {
    images,
    setImages,
    upload: uploadImages,
    uploading: uploadingImages,
    error: imageError,
    remove: removeImage,
  } = useAgentAttachmentDraft(activeId, en);
  const [creating, setCreating] = useState(false),
    [title, setTitle] = useState("");
  const [profileId, setProfileId] = useState(""),
    [model, setModel] = useState(""),
    [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const actionLock = useRef(false);
  const [contextOpen, setContextOpen] = useState(Boolean(focusedCandidateId)),
    [tab, setTab] = useState<"context" | "changes" | "runtime">(
      focusedCandidateId ? "changes" : "context",
    );
  useEffect(() => {
    if (focusedCandidateId) {
      setContextOpen(true);
      setTab("changes");
    }
  }, [focusedCandidateId]);
  const [source, setSource] = useState<{ ref: string; version?: string }>();
  const [searchTarget, setSearchTarget] = useState<{
    sessionId: string;
    eventId: string;
    sequence: number;
  }>();
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 900),
    [railOverlay, setRailOverlay] = useState(false);
  useEffect(() => {
    const resize = () => setNarrow(window.innerWidth <= 900);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    if (!railOverlay) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setRailOverlay(false);
        document
          .querySelector<HTMLButtonElement>(".session-rail-toggle")
          ?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [railOverlay]);
  const contextTrigger = useRef<HTMLButtonElement>(null),
    activeRef = useRef(activeId);
  activeRef.current = activeId;
  const key = agentStorageKey("draft", activeId);
  const [draftState, setDraftState] = useState(() => ({
    key,
    value: readAgentStorage(key, ""),
  }));
  const draft =
    draftState.key === key ? draftState.value : readAgentStorage(key, "");
  const setDraft = useCallback(
    (value: string) => {
      writeAgentStorage(key, value);
      setDraftState({ key, value });
    },
    [key],
  );
  const available = profiles.data?.profiles ?? [];
  const profile =
    available.find(
      (item) => item.id === (creating ? profileId : session?.profileId),
    ) ??
    available.find((item) => item.availability === "ready") ??
    available[0];
  const models = profile?.models?.length
    ? profile.models
    : profile?.model
      ? [{ id: profile.model, label: profile.model }]
      : [{ id: "", label: en ? "Default model" : "默认模型" }];
  const reasoning =
    profile?.models?.find((item) => item.id === model)?.reasoningEfforts ??
    profile?.reasoningEfforts ??
    [];
  const reasoningKey = reasoning.join("|");
  useEffect(() => {
    if (effort && !reasoningKey.split("|").includes(effort)) setEffort("");
  }, [effort, reasoningKey]);
  const initialModel = profile?.model || profile?.models?.[0]?.id || "";
  useEffect(() => {
    setModel((!creating && session?.model) || initialModel);
    setEffort(
      (!creating && session?.reasoningEffort) || profile?.reasoningEffort || "",
    );
  }, [
    activeId,
    profile?.id,
    initialModel,
    profile?.reasoningEffort,
    session?.model,
    session?.reasoningEffort,
    creating,
  ]);
  useEffect(() => {
    if (!profileId && profile?.id) setProfileId(profile.id);
  }, [profile?.id, profileId]);
  useEffect(() => {
    setError("");
    setSource(undefined);
  }, [activeId]);
  const select = (id: string, eventId?: string) => {
    setSelected(id);
    setRailOverlay(false);
    writeAgentStorage(agentStorageKey("selected"), id);
    if (eventId)
      setSearchTarget({ sessionId: id, eventId, sequence: Date.now() });
  };
  const put = useCallback(
    (value: AgentSession) => {
      client.setQueryData<AgentSession>(
        ["agent-session", project, value.id],
        (current) => mergeAgentSnapshot(value, current),
      );
    },
    [client, project],
  );
  const refresh = useCallback(
    async (id = activeRef.current) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["agent-sessions", project] }),
        ...(id
          ? [
              client.invalidateQueries({
                queryKey: ["agent-session", project, id],
              }),
            ]
          : []),
      ]);
    },
    [client, project],
  );
  const request = useCallback(
    <T,>(path: string, options: RequestInit = {}) =>
      api<T>(path, { ...options, headers: { "x-rw-project-id": project } }),
    [project],
  );
  const run = async (action: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    await run(async () => {
      const value = await request<AgentSession>("/api/agent-sessions", {
        method: "POST",
        body: JSON.stringify({
          profileId: profile?.id,
          title: title.trim() || (en ? "Research conversation" : "研究会话"),
          model: model || undefined,
          reasoningEffort: effort,
        }),
      });
      put(value);
      select(value.id);
      setCreating(false);
      setTitle("");
      await refresh(value.id);
    });
  };
  const { send, failure, retry, recover, isSubmitting } = useAgentSubmission({ activeId, activeRef, session, draft, images, model, effort, uploadingImages, en, key, setDraft, setImages, setDraftState, put, refresh, request, setError });
  const cancel = () =>
    void run(async () => {
      if (!activeId) return;
      const cacheKey = ["agent-session", project, activeId],
        turnId = session?.activeTurnId ?? "pending";
      client.setQueryData<AgentSession>(cacheKey, (current) =>
        current ? { ...current, cancellingTurnId: turnId } : current,
      );
      try {
        await request(
          `/api/agent-sessions/${encodeURIComponent(activeId)}/cancel`,
          { method: "POST" },
        );
        await refresh();
      } catch (cause) {
        client.setQueryData<AgentSession>(cacheKey, (current) =>
          current?.cancellingTurnId === turnId
            ? { ...current, cancellingTurnId: null }
            : current,
        );
        throw cause;
      }
    });
  const updateSession = async (
    id: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ) => {
    const value = await request<AgentSession>(
      `/api/agent-sessions/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    put(value);
    await refresh(id);
    if (patch.archived && id === activeId) {
      const next = rows.find((row) => row.id !== id && !row.archived);
      if (next) select(next.id);
    }
  };
  const editQueue = async (id: string, text: string) => {
    await request(
      `/api/agent-sessions/${encodeURIComponent(activeId!)}/queue/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify({ text }) },
    );
    await refresh();
  };
  const resumeQueue = () =>
    void run(async () => {
      if (!activeId) return;
      if (["detached", "failed", "closed"].includes(session?.status ?? ""))
        put(
          await request<AgentSession>(
            `/api/agent-sessions/${encodeURIComponent(activeId)}/resume`,
            { method: "POST", body: "{}" },
          ),
        );
      await request(
        `/api/agent-sessions/${encodeURIComponent(activeId)}/queue/resume`,
        { method: "POST", body: "{}" },
      );
      await refresh();
    });
  const onSaved = useCallback(
    (id: string) => {
      if (activeRef.current === id) setTab("changes");
      void client.invalidateQueries({
        queryKey: ["agent-research-context", project, id],
      });
      void client.invalidateQueries({ queryKey: ["agent-research-changes", project, id] });
      void client.invalidateQueries({
        queryKey: ["research-context", project],
      });
    },
    [client, project],
  );
  const onSource = useCallback((ref: string, version?: string) => {
    setSource({ ref, version });
    setTab("context");
    setContextOpen(true);
  }, []);
  const onReview = useCallback(
    async (id: string, decision: string, revision: unknown) => {
      try {
        await request(
          `/api/research/candidates/${encodeURIComponent(id)}/review`,
          {
            method: "POST",
            body: JSON.stringify({ decision, expectedRevision: revision }),
          },
        );
      } catch (error) {
        if (
          error instanceof ApiClientError &&
          error.code === "CANDIDATE_REVISION_CONFLICT"
        ) {
          await Promise.all(
            [
              "agent-research-context",
              "agent-research-changes",
              "research-context",
              "candidate-preview",
            ].map((name) =>
              client.invalidateQueries({ queryKey: [name, project] }),
            ),
          );
          throw new Error(
            en
              ? "The proposal has changed. Review its latest content before deciding."
              : "候选已更新，请查看最新内容后重新审批。",
          );
        }
        throw error;
      }
      await Promise.all(
        [
          "agent-research-context",
          "agent-research-changes",
          "research-context",
          "research-state",
          "topology",
          "research-notes",
          "research-note",
          "research-node",
          "research-group",
          "group-members",
          "research-blocks",
          "research-block",
          "object-relations",
          "experiment-runs",
          "experiment-data-overview",
          "experiment-data-metrics",
          "experiment-data-table",
          "research-experiments",
          "experiment-record-plot",
          "temporary-experiment-compare",
          "candidate-preview",
        ].map((name) =>
          client.invalidateQueries({ queryKey: [name, project] }),
        ),
      );
    },
    [client, project, request, en],
  );
  const stopping = agentIsStopping(session),
    executing = ["running", "awaiting_permission"].includes(
      session?.status ?? "",
    );
  const label = stopping
    ? agentStatus("stopping", en)
    : agentStatus(session?.status ?? "ready", en);
  const modelOptions = models.map((item) => ({
    value: item.id,
    label: item.label,
  }));
  const effortOptions = [
    { value: "", label: en ? "Default reasoning" : "默认推理" },
    ...reasoning.map((value) => ({
      value,
      label: effortLabels[value]?.[en ? 1 : 0] ?? value,
    })),
  ];
  return (
    <section
      className={`agent-page agent-workbench ${agentFocus ? "is-focused" : ""}`}
    >
      <h1 className="agent-page-title">
        {en ? "Agent conversations" : "Agent 会话"}
      </h1>
      {!creating &&
        (error || profiles.error || sessions.error) && (
          <div className="form-error" role="alert">
            {error ||
              profiles.error?.message ||
              sessions.error?.message}
            {(profiles.error || sessions.error) && <button className="button" disabled={profiles.isFetching || sessions.isFetching} onClick={() => { if (profiles.error) void profiles.refetch(); if (sessions.error) void sessions.refetch(); }}>{en ? "Retry" : "重试"}</button>}
          </div>
        )}
      {disconnected && (
        <div className="agent-connection-warning" role="status">
          {en
            ? "Connection interrupted. Reconnecting…"
            : "连接已中断，正在重新连接…"}
        </div>
      )}
      <div
        className={`agent-grid ${agentFocus || sessionRailCollapsed || narrow ? "rail-collapsed" : ""}`}
      >
        {narrow && railOverlay && (
          <button
            className="session-rail-backdrop"
            aria-label={en ? "Close conversation list" : "关闭会话列表"}
            onClick={() => setRailOverlay(false)}
          />
        )}
        <AgentSessionRail
          sessions={rows}
          activeId={activeId}
          collapsed={narrow ? !railOverlay : agentFocus || sessionRailCollapsed}
          floating={narrow && railOverlay}
          en={en}
          pending={busy}
          loading={sessions.isPending && !sessions.data}
          failed={Boolean(sessions.error)}
          onSelect={select}
          onCreate={() => {
            setProfileId(session?.profileId ?? profile?.id ?? "");
            setCreating(true);
          }}
          onToggle={() => {
            if (narrow) setRailOverlay((value) => !value);
            else if (agentFocus) {
              toggleAgentFocus();
              if (sessionRailCollapsed) toggleSessionRail();
            } else toggleSessionRail();
          }}
          onUpdate={updateSession}
        />
        <section className="agent-panel conversation">
          <div className="conversation-head">
            <div className="conversation-title">
              <span className="conversation-mark">
                {loadingSession ? <Skeleton width={16} height={16} /> : <AgentIcon profile={session ? profile : profiles.data?.profiles.find(item => item.id === summary?.profileId)} size={15} />}
              </span>
              <div>
                <h2 translate="no">
                  {session?.title ?? summary?.title ?? (loadingSession ? <Skeleton width={160} height={18} /> : en ? "Agent conversation" : "Agent 会话")}
                </h2>
                <span
                  className={`conversation-status status-${stopping ? "stopping" : (session?.status ?? "idle")}`}
                  data-session-status={loadingSession ? "loading" : stopping ? "stopping" : (session?.status ?? "unavailable")}
                >
                  {loadingSession ? <Skeleton width={64} height={12} /> : !session ? "—" : session.status === "running" && !stopping ? (
                    <WorkingIndicator
                      session={session}
                      events={session.conversationEvents ?? []}
                      en={en}
                    />
                  ) : (
                    <>
                      <i />
                      {label}
                    </>
                  )}
                </span>
              </div>
            </div>
            <div className="conversation-actions">
              {session?.permissionGrants?.length ? (
                <button
                  className="permission-mode-chip"
                  onClick={() => {
                    setTab("runtime");
                    setContextOpen(true);
                  }}
                >
                  <ShieldCheck size={13} />
                  {session.permissionGrants.some(
                    (grant) => grant.mode === "acceptEdits",
                  )
                    ? en
                      ? "Edits allowed"
                      : "已允许会话编辑"
                    : en
                      ? "Session grants"
                      : "会话已授权"}
                </button>
              ) : null}
              {session &&
                ["closed", "failed"].includes(session.status) &&
                !session.archived && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        put(
                          await request<AgentSession>(
                            `/api/agent-sessions/${encodeURIComponent(activeId!)}/resume`,
                            {
                              method: "POST",
                              body: JSON.stringify({
                                model: model || undefined,
                                reasoningEffort: effort,
                              }),
                            },
                          ),
                        );
                        await refresh();
                      })
                    }
                  >
                    {en ? "Continue session" : "继续会话"}
                  </button>
                )}
              <button
                className="button conversation-context-button"
                onClick={() => {
                  setTab("changes");
                  setContextOpen(true);
                }}
              >
                <FileCheck2 size={15} />
                {en ? "Research changes" : "研究变更"}
              </button>
              <button
                ref={contextTrigger}
                className={`button conversation-context-button ${contextOpen ? "is-active" : ""}`}
                aria-expanded={contextOpen}
                onClick={() => setContextOpen((value) => !value)}
              >
                <PanelRight size={15} />
                {en ? "Context" : "上下文"}
              </button>
              <button
                className="icon-button"
                onClick={toggleAgentFocus}
                aria-label={
                  agentFocus
                    ? en
                      ? "Exit focus mode"
                      : "退出专注模式"
                    : en
                      ? "Focus conversation"
                      : "专注会话"
                }
                title={en ? "Focus conversation" : "专注会话"}
              >
                {agentFocus ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
              {session && (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      className="icon-button"
                      aria-label={
                        en ? "More conversation actions" : "更多会话操作"
                      }
                    >
                      <MoreHorizontal size={17} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="agent-menu"
                      align="end"
                      sideOffset={6}
                    >
                      <DropdownMenu.Item asChild>
                        <Link
                          to={`/agents/trace/${encodeURIComponent(session.id)}`}
                        >
                          {en ? "Trace" : "运行 Trace"}
                        </Link>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        disabled={busy || executing}
                        onSelect={() =>
                          void run(async () => {
                            if (session.capabilities?.session?.sync)
                              await request(
                                `/api/agent-sessions/${encodeURIComponent(session.id)}/sync`,
                                { method: "POST", body: "{}" },
                              );
                            await refresh();
                          })
                        }
                      >
                        {session.capabilities?.session?.sync
                          ? en
                            ? "Sync"
                            : "同步"
                          : en
                            ? "Refresh records"
                            : "刷新记录"}
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        disabled={busy || session.status === "closed"}
                        onSelect={() =>
                          void run(async () => {
                            put(
                              await request<AgentSession>(
                                `/api/agent-sessions/${encodeURIComponent(session.id)}/close`,
                                { method: "POST" },
                              ),
                            );
                            await refresh();
                          })
                        }
                      >
                        {en
                          ? "End runtime · keep history"
                          : "结束运行 · 保留历史"}
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              )}
            </div>
          </div>
          {session?.archived && (
            <div className="archived-session-banner">
              {en ? "This conversation is archived." : "此会话已归档。"}
              <button
                className="button"
                onClick={() =>
                  void updateSession(session.id, { archived: false })
                }
              >
                {en ? "Restore conversation" : "恢复会话"}
              </button>
            </div>
          )}
          <AgentHistoryStatus session={session} en={en} />
          <AgentTranscript
            key={`transcript:${activeId}`}
            sessionId={activeId}
            session={session}
            ready={Boolean(session)}
            loading={loadingSession}
            loadError={detail.error?.message}
            onRetry={() => void detail.refetch()}
            en={en}
            working={
              session?.status === "running" && !stopping && !disconnected
            }
            onSource={onSource}
            onSaved={onSaved}
            onReview={onReview}
            searchTarget={
              searchTarget?.sessionId === activeId ? searchTarget : undefined
            }
          />
          <AgentComposer
            key={`composer:${activeId}`}
            session={session}
            loading={loadingSession}
            draft={draft}
            setDraft={setDraft}
            images={images}
            onAddImages={(files) => void uploadImages(files)}
            onRemoveImage={id => void removeImage(id)}
            uploading={uploadingImages}
            imageError={imageError}
            en={en}
            submitting={isSubmitting}
            stopping={stopping}
            model={model}
            effort={effort}
            models={modelOptions}
            efforts={effortOptions}
            setModel={setModel}
            setEffort={setEffort}
            onSend={send}
            onStop={cancel}
            onRemove={(id) =>
              void run(async () => {
                await request(
                  `/api/agent-sessions/${encodeURIComponent(activeId!)}/queue/${encodeURIComponent(id)}`,
                  { method: "DELETE" },
                );
                await refresh();
              })
            }
            onEdit={editQueue}
            onResume={resumeQueue}
            failed={failure}
            onRetry={retry}
            onRecover={recover}
          />
        </section>
        <AgentResearchDrawer
          open={contextOpen}
          focusedCandidateId={focusedCandidateId}
          session={session}
          en={en}
          tab={tab}
          setTab={setTab}
          source={source}
          setSource={setSource}
          onClose={() => {
            setContextOpen(false);
            contextTrigger.current?.focus();
          }}
          onReview={onReview}
          busy={busy}
          onReset={() =>
            void run(async () => {
              put(
                await request<AgentSession>(
                  `/api/agent-sessions/${encodeURIComponent(activeId!)}/permissions/reset`,
                  { method: "POST", body: "{}" },
                ),
              );
              await refresh();
            })
          }
        />
      </div>
      <Dialog.Root
        open={creating}
        onOpenChange={(value) => {
          if (!busy) {
            setCreating(value);
            setError("");
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content aria-describedby={undefined} className="dialog-content">
            <Dialog.Title>
              {en ? "New Agent session" : "新建 Agent 会话"}
            </Dialog.Title>

            <form onSubmit={create}>
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
              <label className="form-field">
                {en ? "Agent adapter" : "Agent 适配器"}
                <SelectMenu
                  value={profileId || profile?.id || ""}
                  onChange={setProfileId}
                  ariaLabel={en ? "Agent adapter" : "Agent 适配器"}
                  options={available.map((item) => ({
                    value: item.id,
                    label: item.label,
                  }))}
                />
              </label>
              <label className="form-field">
                {en ? "Session title" : "会话标题"}
                <input
                  autoFocus
                  value={title}
                  maxLength={120}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label className="form-field">
                {en ? "Model" : "模型"}
                <SelectMenu
                  value={model}
                  onChange={setModel}
                  ariaLabel={en ? "Session model" : "会话模型"}
                  options={modelOptions}
                />
              </label>
              <label className="form-field">
                {en ? "Reasoning effort" : "推理强度"}
                <SelectMenu
                  value={effort}
                  onChange={setEffort}
                  ariaLabel={en ? "Session reasoning effort" : "会话推理强度"}
                  options={effortOptions}
                />
              </label>
              <div className="dialog-actions">
                <Dialog.Close asChild>
                  <button type="button" className="button">
                    {en ? "Cancel" : "取消"}
                  </button>
                </Dialog.Close>
                <button
                  className="button primary"
                  disabled={busy || profile?.availability !== "ready"}
                >
                  {busy
                    ? en
                      ? "Creating…"
                      : "正在创建…"
                    : en
                      ? "Create"
                      : "创建"}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
