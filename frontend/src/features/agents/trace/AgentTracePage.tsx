import { Link, useParams } from "react-router-dom";
import { memo, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api, projectId } from "@/shared/lib/api";
import { renderMarkdown, renderReasoningSummary } from "@/shared/lib/markdown";
import {
  buildAgentTrace,
  traceDetail,
  type TraceGroup,
} from "@/features/agents/trace/agentTrace";
import type { AgentSession } from "@/shared/types/api";
import { useUiStore } from "@/shared/state/ui";

import { AgentEventIcon } from "@/features/agents/icons/AgentEventIcon";

import { ToolResult } from "@/features/agents/tools/ToolResult";
import { PageHeader as Header } from "@/shared/layout/PageHeader";
import { DeferredContent } from "@/shared/ui/DeferredContent";
export function AgentTracePage() {
  const { sessionId } = useParams();
  const detail = useQuery({
    queryKey: ["agent-session", projectId(), sessionId],
    queryFn: () =>
      api<AgentSession>(
        `/api/agent-sessions/${encodeURIComponent(sessionId!)}`,
      ),
    enabled: Boolean(sessionId),
    refetchInterval: (query) =>
      ["running", "starting", "awaiting_permission"].includes(
        query.state.data?.status ?? "",
      )
        ? 1000
        : false,
  });
  const en = useUiStore((state) => state.locale === "en");
  const groups = useMemo(() => buildAgentTrace(detail.data?.events ?? [], en), [detail.data?.events, en]);
  const dropped = detail.data?.eventRetention?.droppedEvents ?? 0;
  return (
    <section className="trace-page">
      <Header
        title="运行 Trace"

        action={
          <Link className="button" to="/agents">
            返回会话
          </Link>
        }
      />
      <dl className="trace-metadata"><div><dt>{en ? "Session" : "会话"}</dt><dd>{detail.data?.title ?? sessionId}</dd></div><div><dt>{en ? "Results" : "结果记录"}</dt><dd>{groups.length}</dd></div></dl>
      <div className="trace-stream">
        {dropped > 0 && (
          <p role="status">
            {en
              ? `${dropped} older result records are outside retention. Conversation content is stored separately.`
              : `另有 ${dropped} 项较早结果已超出保留范围；会话正文单独保存。`}
          </p>
        )}
        {groups.length ? (
          groups.map(group => <TraceEntry key={group.id} group={group} en={en} />)
        ) : (
          <div className="trace-empty">当前会话没有可显示的 Trace。</div>
        )}
      </div>
    </section>
  );
}

function TraceEntry({ group, en }: { group: TraceGroup; en: boolean }) {
  const [open, setOpen] = useState(false);
  const status = ({ completed: ["完成", "Done"], running: ["运行中", "Running"], streaming: ["正在生成", "Streaming"], failed: ["失败", "Failed"], incomplete: ["不完整", "Incomplete"], interrupted: ["已中断", "Interrupted"], pending: ["待处理", "Pending"], resolved: ["已处理", "Resolved"] } as Record<string, string[]>)[group.status ?? ""]?.[en ? 1 : 0] ?? "";
  const metadata = <><strong translate="no">{group.title}</strong><span className="trace-group-status">{status}</span><time>{group.occurredAt}</time></>;
  if (group.kind === "message") return <article className={`trace-message ${group.id.startsWith("user:") ? "is-user" : ""}`}><header>{metadata}</header><DeferredContent>{() => <TraceMarkdown text={group.text ?? ""} />}</DeferredContent></article>;
  return <details className={`trace-group trace-group--${group.kind}`} onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary><span className="trace-symbol"><AgentEventIcon item={group} /></span>{metadata}<span className="trace-chevron">›</span></summary>
    {open && <div className="trace-group-body">{group.kind === "reasoning" || group.kind === "plan" && group.text
      ? <TraceMarkdown text={group.text ?? ""} reasoning={group.kind === "reasoning"} />
      : group.kind === "tool" ? <ToolResult event={group.events[0]} en={en} />
      : <pre className="trace-final-output" translate="no">{traceDetail(group.events[0]) || (en ? "No additional output." : "无额外输出。")}</pre>}</div>}
  </details>;
}

const TraceMarkdown = memo(function TraceMarkdown({ text, reasoning = false }: { text: string; reasoning?: boolean }) {
  const html = useMemo(() => reasoning ? renderReasoningSummary(text) : renderMarkdown(text), [text, reasoning]);
  return <div className="trace-markdown" translate="no" dangerouslySetInnerHTML={{ __html: html }} />;
});
