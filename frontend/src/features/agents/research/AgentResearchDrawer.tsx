import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api, ApiClientError, projectId } from "@/shared/lib/api";
import type { AgentSession, ResearchContext } from "@/shared/types/api";
import { ResearchCandidateCard } from "@/features/research/ResearchCandidateCard";
import { AgentMotionDrawer } from "../motion/AgentMotionDrawer";
import type { SessionResearch } from "./useSessionResearch";

type Tab = "context" | "changes" | "runtime";
export function SourcePreview({
  source,
  en,
  close,
}: {
  source: { ref: string; version?: string };
  en: boolean;
  close: () => void;
}) {
  const [offset, setOffset] = useState(0),
    [version, setVersion] = useState(source.version);
  const query = useQuery({
    queryKey: [
      "agent-source-preview",
      projectId(),
      source.ref,
      offset,
      version,
    ],
    queryFn: () =>
      api<{ data: {
        source: { title?: string; ref?: string; version?: string };
        text?: string;
        facts?: unknown;
        range?: { start: number; end: number; nextOffset: number | null };
        disclosure?: string;
      } }>(
        `/api/research/sources?${new URLSearchParams({ ref: source.ref, offset: String(offset), maxChars: "7000", ...(version ? { expectedVersion: version } : {}) })}`,
      ).then(result=>result.data),
  });
  return (
    <section className="agent-source-preview">
      <header>
        <strong>{en ? "Source evidence" : "来源证据"}</strong>
        <button
          className="icon-button"
          aria-label={en ? "Close source preview" : "关闭来源预览"}
          onClick={close}
        >
          <X size={14} />
        </button>
      </header>
      <code translate="no">{source.ref}</code>
      {query.isLoading && (
        <p role="status">{en ? "Loading source…" : "正在读取来源…"}</p>
      )}
      {query.error && (
        <p role="alert">
          {query.error.message}
          {query.error instanceof ApiClientError &&
            query.error.code === "SOURCE_VERSION_CONFLICT" && (
              <button
                className="button"
                onClick={() => {
                  setVersion(undefined);
                  setOffset(0);
                }}
              >
                {en ? "Read latest version" : "读取最新版本"}
              </button>
            )}
        </p>
      )}
      {query.data && (
        <>
          <small>{query.data.source.version}</small>
          {query.data.range && (
            <p>
              {en ? "Character range" : "字符范围"} {query.data.range.start}–
              {query.data.range.end}
            </p>
          )}
          <pre translate="no">
            {query.data.text ?? JSON.stringify(query.data.facts ?? {}, null, 2)}
          </pre>
          {query.data.disclosure === "metadata-only" && (
            <p>
              {en
                ? "Only metadata is available for this source."
                : "此来源目前仅有元数据。"}
            </p>
          )}
          {query.data.range?.nextOffset != null && (
            <button
              className="button"
              onClick={() => {
                setVersion(query.data?.source.version);
                setOffset(query.data!.range!.nextOffset!);
              }}
            >
              {en ? "Next range" : "下一段"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

export function AgentResearchDrawer({
  open,
  onClose,
  session,
  en,
  tab,
  setTab,
  source,
  setSource,
  onReview,
  onReset,
  busy,
  focusedCandidateId,
}: {
  open: boolean;
  onClose: () => void;
  session?: AgentSession;
  en: boolean;
  tab: Tab;
  setTab: (tab: Tab) => void;
  source?: { ref: string; version?: string };
  setSource: (source?: { ref: string; version?: string }) => void;
  onReview: (id: string, decision: string, revision: unknown) => Promise<void>;
  onReset: () => void;
  busy: boolean;
  focusedCandidateId?: string;
}) {
  const [projectChanges, setProjectChanges] = useState(Boolean(focusedCandidateId));
  useEffect(() => { if (focusedCandidateId) setProjectChanges(true); }, [focusedCandidateId]);
  const context = useQuery({
    queryKey: ["agent-research-context", projectId(), session?.id],
    enabled: open && Boolean(session?.id),
    queryFn: () =>
      api<SessionResearch>(
        `/api/agent-sessions/${encodeURIComponent(session!.id)}/context`,
      ),
  });
  const project = useQuery({
    queryKey: ["research-context", projectId()],
    enabled: open && tab === "changes" && projectChanges,
    queryFn: () =>
      api<ResearchContext>("/api/research/context"),
  });
  const candidates = projectChanges
    ? (project.data?.candidates ?? [])
    : (context.data?.candidates ?? []);
  const selected = context.data?.selection;
  const allReads = [...(context.data?.reads ?? [])].reverse();
  const reads = allReads.filter((read) =>
    ["source_excerpt", "node"].includes(read.type),
  );
  const usage = session?.usage;
  const counts = usage?.tokenUsage?.last ?? usage?.tokenUsage?.total;
  const scope = usage?.tokenUsage?.last
    ? (usage?.lastScope ?? usage?.scope)
    : usage?.scope;
  const running = [
    "running",
    "awaiting_permission",
    "starting",
    "closing",
  ].includes(session?.status ?? "");
  return (
    <AgentMotionDrawer
      open={open}
      onClose={onClose}
      label={en ? "Research context" : "研究上下文"}
    >
      <div className="research-drawer-head">
        <strong>{en ? "Research workspace" : "研究工作区"}</strong>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label={en ? "Close research context" : "关闭研究上下文"}
        >
          <X size={16} />
        </button>
      </div>
      <div
        className="research-drawer-tabs"
        role="tablist"
        aria-label={en ? "Research sections" : "研究工作区分区"}
      >
        {(["context", "changes", "runtime"] as Tab[]).map((value, i) => (
          <button
            role="tab"
            aria-selected={tab === value}
            key={value}
            onClick={() => setTab(value)}
          >
            {
              (en
                ? ["Context", "Changes", "Runtime"]
                : ["科研上下文", "研究变更", "运行信息"])[i]
            }
          </button>
        ))}
      </div>
      <div className="context-scroll">
        {source && (
          <SourcePreview
            key={`${source.ref}:${source.version}`}
            source={source}
            en={en}
            close={() => setSource(undefined)}
          />
        )}
        {context.error && <p role="alert">{context.error.message}</p>}
        {tab === "context" && (
          <>
            <section className="context-section">
              <h3>{en ? "Initial selection" : "创建会话时的选择"}</h3>
              {selected?.nodeIds?.map((id) => (
                <code key={id}>{id}</code>
              ))}
              {selected?.sourceRefs?.map((ref) => (
                <button
                  className="source-entry"
                  key={ref}
                  onClick={() => setSource({ ref })}
                >
                  {ref}
                </button>
              ))}
              {!selected?.nodeIds?.length && !selected?.sourceRefs?.length && (
                <p>
                  {en ? "No initial object selection" : "未指定初始研究对象"}
                </p>
              )}

            </section>
            <section className="context-section">
              <h3>
                {en ? "Evidence reads in this session" : "本会话证据读取"}
              </h3>
              {!reads.length && (
                <p>
                  {en
                    ? "No evidence content reads recorded yet"
                    : "暂无证据内容读取记录"}
                </p>
              )}
              {reads.map((read) => (
                <div className="evidence-read" key={read.id}>
                  <small>
                    {read.type === "source_excerpt"
                      ? en
                        ? "Source content"
                        : "来源内容"
                      : read.type === "node"
                        ? en
                          ? "Research object"
                          : "研究对象"
                        : en
                          ? "Discovery / metadata"
                          : "检索或元数据"}
                  </small>
                  {read.refs.map((ref) =>
                    read.type === "source_excerpt" ||
                    read.type === "source_metadata" ? (
                      <button
                        className="source-entry"
                        key={ref}
                        onClick={() =>
                          setSource({ ref, version: read.sourceVersion })
                        }
                      >
                        {ref}
                      </button>
                    ) : (
                      <code key={ref}>{ref}</code>
                    ),
                  )}
                  {read.range && (
                    <small>
                      {en ? "Characters" : "字符"} {read.range.start}–
                      {read.range.end}
                    </small>
                  )}
                  {read.sourceVersion && (
                    <small translate="no">{read.sourceVersion}</small>
                  )}
                </div>
              ))}
              {allReads.length > reads.length && (
                <small>
                  {en
                    ? `${allReads.length - reads.length} other discovery or metadata reads`
                    : `另有 ${allReads.length - reads.length} 条检索或元数据读取`}
                </small>
              )}
              {Boolean(context.data?.omittedReadCount) && (
                <small>
                  {en ? "Showing the latest 200 reads" : "显示最近 200 条读取"}
                </small>
              )}
            </section>
          </>
        )}
        {tab === "changes" && (
          <>
            <div className="change-scope">
              <button
                className="button"
                aria-pressed={!projectChanges}
                onClick={() => setProjectChanges(false)}
              >
                {en ? "This session" : "本会话变更"}
              </button>
              <button
                className="button"
                aria-pressed={projectChanges}
                onClick={() => setProjectChanges(true)}
              >
                {en ? "Project changes" : "项目变更"}
              </button>
            </div>
            {project.error && <p role="alert">{project.error.message}</p>}
            {candidates
              .filter((item) => ["pending", "deferred"].includes(String(item.status)) || item.id === focusedCandidateId)
              .map((candidate) => (
                <ResearchCandidateCard
                  key={String(candidate.id)}
                  candidate={candidate}
                  en={en}
                  onReview={onReview}
                  initialExpanded={candidate.id === focusedCandidateId}
                  focused={candidate.id === focusedCandidateId}
                />
              ))}
            {!candidates.some((item) =>
              ["pending", "deferred"].includes(String(item.status)) || item.id === focusedCandidateId,
            ) && <p>{en ? "No changes awaiting review" : "暂无候选变化"}</p>}
          </>
        )}
        {tab === "runtime" && (
          <>
            <section className="context-section">
              <h3>{en ? "Reported usage" : "运行用量"}</h3>
              <p>
                {scope === "session"
                  ? en
                    ? "Session total"
                    : "会话累计"
                  : scope === "turn"
                    ? en
                      ? "Latest turn"
                      : "最近回合"
                    : en
                      ? "Latest reported step"
                      : "最近报告步骤"}
              </p>
              {counts ? (
                Object.entries(counts)
                  .filter(([key]) =>
                    [
                      "inputTokens",
                      "outputTokens",
                      "cachedInputTokens",
                      "totalTokens",
                    ].includes(key),
                  )
                  .map(([key, value]) => (
                    <div className="context-stat" key={key}>
                      <span>
                        {
                          {
                            inputTokens: en ? "Input" : "输入",
                            outputTokens: en ? "Output" : "输出",
                            cachedInputTokens: en ? "Cached input" : "缓存读取",
                            totalTokens: en ? "Total tokens" : "合计 Tokens",
                          }[key]
                        }
                      </span>
                      <strong>{value?.toLocaleString()}</strong>
                    </div>
                  ))
              ) : (
                <p>{en ? "No usage reported" : "暂无用量报告"}</p>
              )}
            </section>
            <section className="context-section">
              <h3>{en ? "Session permissions" : "当前会话授权"}</h3>
              {session?.capabilities?.approval && (
                <div className="context-stat">
                  <span>{en ? "Approval mode" : "审批模式"}</span>
                  <strong>
                    {session.capabilities.approval.interactive === false
                      ? en
                        ? "Non-interactive · native policy"
                        : "非交互 · 遵循原生配置"
                      : en
                        ? "Approval on request"
                        : "按需审批"}
                  </strong>
                </div>
              )}
              {session?.permissionGrants?.length ? (
                session.permissionGrants.map((grant) => (
                  <div key={grant.requestId}>
                    <strong>
                      {grant.mode === "acceptEdits"
                        ? en
                          ? "Auto-allow file edits"
                          : "自动允许文件编辑"
                        : (grant.label ??
                          (en ? "Session permission" : "会话授权"))}
                    </strong>
                    {grant.patterns?.map((pattern) => (
                      <code key={pattern}>{pattern}</code>
                    ))}
                  </div>
                ))
              ) : (
                <p>
                  {en ? "No additional session grants" : "没有额外的会话授权"}
                </p>
              )}
              <button
                className="button"
                disabled={busy || running || !session?.permissionGrants?.length}
                onClick={onReset}
              >
                {en ? "Reset session permissions" : "重置会话授权"}
              </button>
              <small>
                {running
                  ? en
                    ? "Stop the current turn before resetting permissions."
                    : "请先停止当前回合，再调整授权。"
                  : en
                    ? "Reconnects this conversation using the configured permissions; history is retained."
                    : "按工作区配置重新连接，保留会话历史。"}
              </small>
            </section>
          </>
        )}
      </div>
    </AgentMotionDrawer>
  );
}
