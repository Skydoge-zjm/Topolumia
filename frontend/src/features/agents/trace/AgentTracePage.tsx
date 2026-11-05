import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { api, projectId } from "@/shared/lib/api";
import { renderMarkdown, renderReasoningSummary } from "@/shared/lib/markdown";
import {
  buildAgentTrace,
  traceDetail,
} from "@/features/agents/trace/agentTrace";
import type { AgentSession } from "@/shared/types/api";
import { useUiStore } from "@/shared/state/ui";

import { AgentEventIcon } from "@/features/agents/icons/AgentEventIcon";

import { ToolResult } from "@/features/agents/tools/ToolResult";
import { PageHeader as Header } from "@/shared/layout/PageHeader";
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
  const events = detail.data?.events ?? [];
  const en = useUiStore((state) => state.locale === "en");
  const groups = buildAgentTrace(events, en);
  const dropped = detail.data?.eventRetention?.droppedEvents ?? 0;
  const statusLabel = (status?: string) =>
    ({
      completed: en ? "Done" : "完成",
      running: en ? "Running" : "运行中",
      streaming: en ? "Streaming" : "正在生成",
      failed: en ? "Failed" : "失败",
      incomplete: en ? "Incomplete" : "不完整",
      interrupted: en ? "Interrupted" : "已中断",
      pending: en ? "Pending" : "待处理",
      resolved: en ? "Resolved" : "已处理",
    })[status ?? ""] ?? "";
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
          groups.map((group) =>
            group.kind === "message" ? (
              <article
                className={`trace-message ${group.id.startsWith("user:") ? "is-user" : ""}`}
                key={group.id}
              >
                <header>
                  <strong>{group.title}</strong>
                  <span className="trace-group-status">
                    {statusLabel(group.status)}
                  </span>
                  <time>{group.occurredAt}</time>
                </header>
                <div
                  className="trace-markdown"
                  translate="no"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(group.text ?? ""),
                  }}
                />
              </article>
            ) : (
              <details
                className={`trace-group trace-group--${group.kind}`}
                key={group.id}
              >
                <summary>
                  <span className="trace-symbol">
                    <AgentEventIcon item={group} />
                  </span>
                  <strong translate="no">{group.title}</strong>
                  <span className="trace-group-status">
                    {statusLabel(group.status)}
                  </span>
                  <time>{group.occurredAt}</time>
                  <span className="trace-chevron">›</span>
                </summary>
                <div className="trace-group-body">
                  {group.kind === "reasoning" ||
                  (group.kind === "plan" && group.text) ? (
                    <div
                      className="trace-markdown"
                      translate="no"
                      dangerouslySetInnerHTML={{
                        __html:
                          group.kind === "reasoning"
                            ? renderReasoningSummary(group.text ?? "")
                            : renderMarkdown(group.text ?? ""),
                      }}
                    />
                  ) : group.kind === "tool" ? (
                    <ToolResult event={group.events[0]} en={en} />
                  ) : (
                    <pre className="trace-final-output" translate="no">
                      {traceDetail(group.events[0]) ||
                        (en ? "No additional output." : "无额外输出。")}
                    </pre>
                  )}
                </div>
              </details>
            ),
          )
        ) : (
          <div className="trace-empty">当前会话没有可显示的 Trace。</div>
        )}
      </div>
    </section>
  );
}
