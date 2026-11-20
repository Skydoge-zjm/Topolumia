import type { ConversationItem } from "@/features/agents/conversation/model/agentConversation";
import { renderMarkdown, renderReasoningSummary } from "@/shared/lib/markdown";
import {
  groupActivityRuns,
  groupToolRuns,
  activitySummary,
} from "@/features/agents/conversation/model/agentActivity";
import { compactTraceEvents } from "@domain/agents/agent-trace";
import { AgentEventIcon } from "../../icons/AgentEventIcon";
import { CheckCircle2, CircleX, Copy } from "lucide-react";
import { Fragment, memo, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { copyText } from "@/shared/lib/copyText";
import {
  toolCallLabel,
  topolumiaToolLabel,
  describeTool,
} from "@/features/agents/tools/agentTool";
import { ToolResult } from "../../tools/ToolResult";
import {
  AgentImageGallery,
  AgentAttachmentGallery,
} from "../../tools/AgentImageGallery";
import { AgentApprovalCard } from "../../approvals/AgentApprovalCard";
import { DeferredContent } from "@/shared/ui/DeferredContent";
import type { AgentApprovalSelection } from "@domain/agents/agent-approval";

type Props = {
  items: ConversationItem[];
  en: boolean;
  agentLabel?: string;
  approvalPending?: boolean;
  canApproveHighRisk?: boolean;
  onApproval: (
    requestId: string,
    selection: AgentApprovalSelection,
  ) => void | Promise<void>;
  groupActivities?: boolean;
  onSource?: (ref: string, version?: string) => void;
  afterItem?: (item: ConversationItem) => ReactNode;
  deferMessages?: boolean;
};

function conversationStatus(status: string | undefined, en: boolean): string {
  const labels: Record<string, [string, string]> = {
    completed: ["完成", "Done"],
    success: ["完成", "Done"],
    failed: ["失败", "Failed"],
    error: ["失败", "Failed"],
    cancelled: ["已取消", "Cancelled"],
    stopped: ["已停止", "Stopped"],
    interrupted: ["已中断", "Interrupted"],
    incomplete: ["不完整", "Incomplete"],
    running: ["运行中", "Running"],
    pending: ["待处理", "Pending"],
    resolved: ["已处理", "Resolved"],
    delegated: ["已委派", "Delegated"],
  };
  return labels[status ?? ""]?.[en ? 1 : 0] ?? (en ? "Info" : "信息");
}

function ToolStatusIcon({ status, en }: { status?: string; en: boolean }) {
  const failed = ["failed", "error", "cancelled", "incomplete"].includes(status ?? "");
  if (!["completed", "success", "failed", "error", "cancelled", "incomplete"].includes(status ?? "")) return null;
  const Icon = failed ? CircleX : CheckCircle2;
  return (
    <span
      className={`tool-status-icon ${failed ? "is-failed" : "is-success"}`}
      role="img"
      aria-label={failed ? (en ? "Tool failed" : "工具失败") : en ? "Tool completed" : "工具完成"}
      title={failed ? (en ? "Tool failed" : "工具失败") : en ? "Tool completed" : "工具完成"}
    >
      <Icon size={15} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}
function repeatedToolLabel(item: ConversationItem, count: number, en: boolean): string {
  const firstTool = item.children?.find((child) => child.kind === "tool");
  const description = firstTool ? describeTool(firstTool, en) : undefined;
  if (description?.kind === "terminal")
    return en ? `Run ${count} terminal commands` : `执行 ${count} 次终端命令`;
  const label = item.title ?? (en ? "tool" : "工具");
  if (description?.key === "mcp:topolumia") {
    const match = /^(.*?)(科研操作|科研环境|科研上下文|节点关系|科研信息|节点|来源|内容块|研究附件|研究文件|格式说明|候选变更)$/.exec(label);
    if (match)
      return en ? `${match[1]} ${count} ${match[2]}` : `${match[1]} ${count} 次${match[2]}`;
  }
  return en ? `Call ${label} ${count} times` : `调用 ${label} ${count} 次`;
}
function containsApproval(item: ConversationItem): boolean {
  return (
    (item.kind === "approval" && item.status === "pending") ||
    Boolean(item.children?.some(containsApproval))
  );
}

function Expander({
  className,
  item,
  state,
  summary,
  bodyClass,
  renderBody,
  forceOpen = false,
}: {
  className: string;
  item: ConversationItem;
  state?: string;
  summary: ReactNode;
  bodyClass: string;
  renderBody: () => ReactNode;
  forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className={className}
      data-state={state}
      aria-busy={state === "running"}
      data-view-key={`${item.kind}:${item.key}`}
      open={forceOpen || open}
      data-agent-id={item.agentId}
      data-motion-key={`${item.kind}:${item.key}`}
      data-motion-role={item.kind}
      data-motion-candidate={
        ["activity-batch", "tool", "reasoning", "image-gallery"].includes(
          item.kind,
        )
          ? "true"
          : undefined
      }
      data-turn-key={item.turnKey}
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setOpen(event.currentTarget.open);
      }}
    >
      <summary>{summary}</summary>
      <div className={bodyClass}>{(open || forceOpen) && renderBody()}</div>
    </details>
  );
}

function Message({
  item,
  en,
  onSource,
  deferMessages,
}: Pick<Props, "en" | "onSource" | "deferMessages"> & { item: ConversationItem }) {
  const [feedback, setFeedback] = useState("");
  const partial =
    item.completion && !["completed", "streaming"].includes(item.completion);
  const copy = async (value: string) => {
    try {
      await copyText(value);
      setFeedback(en ? "Copied" : "已复制");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "复制失败");
    }
  };
  return (
    <article
      className={`message ${item.role === "user" ? "user" : ""}`}
      data-native-message={item.nativeMessageId}
      data-message-key={item.key}
      data-user-message={item.role === "user" ? item.key : undefined}
      tabIndex={-1}
      data-motion-key={`message:${item.key}`}
      data-motion-role={item.role}
      data-turn-key={item.turnKey}
      data-motion-actor={item.agentId ?? item.parentToolUseId}
      data-motion-candidate={item.streaming ? "true" : undefined}
      data-state={item.streaming ? "running" : undefined}
    >
      {item.role !== "user" && (item.streaming || partial) && (
        <header>
          {item.streaming && (
            <>
              <span
                className="reply-presence motion-indicator"
                data-motion-indicator="true"
                aria-hidden="true"
              />
              <span className="streaming">{en ? "Streaming" : "正在生成"}</span>
            </>
          )}
          {partial && (
            <span className="content-completion" role="status">
              {conversationStatus(item.completion, en)}
            </span>
          )}
        </header>
      )}
      <DeferredContent eager={!deferMessages || Boolean(item.streaming)}>
        {() => <MessageBody text={item.text ?? ""} streaming={Boolean(item.streaming)} en={en} onCopy={copy} onSource={onSource} />}
      </DeferredContent>
      {item.attachments?.length && item.events?.[0]?.sessionId ? (
        <div className="message-attachments">
          <AgentAttachmentGallery
            attachments={item.attachments}
            sessionId={item.events[0].sessionId}
            en={en}
          />
        </div>
      ) : null}
      {(item.role === "user" || item.finalReply) && (
        <div className="message-actions">
          <button
            type="button"
            onClick={() => void copy(item.text ?? "")}
            aria-label={en ? "Copy message" : "复制消息"}
          >
            <Copy size={13} />
          </button>
          {feedback && <span role="status">{feedback}</span>}
        </div>
      )}
      {!item.finalReply && item.role !== "user" && feedback && (
        <span className="message-copy-feedback" role="status">
          {feedback}
        </span>
      )}
    </article>
  );
}

const MessageBody = memo(function MessageBody({ text, streaming, en, onCopy, onSource }: {
  text: string; streaming: boolean; en: boolean; onCopy: (value: string) => Promise<void>; onSource?: Props["onSource"];
}) {
  const html = useMemo(() => renderMarkdown(text, { en, highlight: !streaming }), [text, streaming, en]);
  return <div className="message-body" translate="no" onClick={event => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLElement>("[data-code-copy]");
    if (button) void onCopy(button.closest(".code-block")?.querySelector("code")?.textContent ?? "");
    const source = target.closest<HTMLElement>("[data-source-ref]");
    if (source?.dataset.sourceRef) onSource?.(source.dataset.sourceRef);
  }} dangerouslySetInnerHTML={{ __html: html }} />;
});

const ConversationRow = memo(function ConversationRow({
  item,
  ...props
}: Omit<Props, "items" | "groupActivities" | "afterItem"> & {
  item: ConversationItem;
}) {
  const { en, approvalPending, onApproval } = props;
  const partial =
    item.completion && !["completed", "streaming"].includes(item.completion);
  if (item.kind === "approval" && item.approval)
    return (
      <AgentApprovalCard
        approval={item.approval}
        en={en}
        disabled={approvalPending}
        canApproveHighRisk={props.canApproveHighRisk}
        onApproval={onApproval}
      />
    );
  if (item.kind === "message") return <Message {...props} item={item} />;
  if (item.kind === "image-gallery" || item.kind === "image") {
    const images = item.kind === "image" ? [item] : (item.children ?? []);
    const label = en
      ? `View ${images.length} ${images.length === 1 ? "image" : "images"}`
      : `查看${images.length}张图像`;
    return (
      <Expander
        item={item}
        className="tool-group image-view-group"
        state={item.status}
        bodyClass="tool-body image-gallery-body"
        summary={
          <>
            <AgentEventIcon item={item} />
            <span className="tool-call-title">{label}</span>
            <span className="streaming">
              {conversationStatus(item.status, en)}
            </span>
          </>
        }
        renderBody={() => <AgentImageGallery items={images} en={en} />}
      />
    );
  }
  if (item.kind === "activity-batch") {
    const summary = activitySummary(item.children ?? [], en);
    return (
      <Expander
        item={item}
        className="activity-batch"
        state={summary.status}
        bodyClass="activity-batch-body"
        summary={
          <>
            <AgentEventIcon item={item} />
            <span
              className="activity-summary-text"
              translate="no"
              title={summary.text}
            >
              {summary.primary}
            </span>
            {summary.secondary && (
              <span className="activity-summary-secondary" translate="no">
                {en ? "; " : "；"}
                {summary.secondary}
              </span>
            )}
            {summary.status === "running" && (
              <span className="activity-state streaming">
                {en ? "Running" : "运行中"}
              </span>
            )}
            {summary.incomplete > 0 && (
              <span className="activity-state">
                {en
                  ? `${summary.incomplete} incomplete`
                  : `${summary.incomplete} 项未完成`}
              </span>
            )}
          </>
        }
        renderBody={() => (
          <ConversationItems
            {...props}
            items={groupToolRuns(item.children ?? [], en)}
            groupActivities={false}
          />
        )}
      />
    );
  }
  if (item.kind === "subagent")
    return (
      <Expander
        item={item}
        className="subagent-group"
        state={item.status}
        bodyClass="subagent-body"
        forceOpen={containsApproval(item)}
        summary={
          <>
            <AgentEventIcon item={item} />
            <span>{en ? "Subagent" : "子 Agent"}</span>
            <strong translate="no" title={item.title}>
              {item.title}
            </strong>
            <span className="streaming">
              {conversationStatus(item.status, en)}
            </span>
          </>
        }
        renderBody={() => (
          <>
            {item.detail && <p translate="no">{item.detail}</p>}
            <ConversationItems
              {...props}
              items={item.children ?? []}
              agentLabel={item.title}
            />
          </>
        )}
      />
    );
  if (item.kind === "tool-batch") {
    const count = item.callCount ?? item.children?.length ?? 0;
    return (
      <Expander
        item={item}
        className="tool-group tool-batch"
        state={item.status}
        bodyClass="tool-body"
        summary={
          <>
            <AgentEventIcon item={item} />
            <span className="tool-call-title" translate="no" title={item.title}>
              {repeatedToolLabel(item, count, en)}
            </span>
          </>
        }
        renderBody={() => (
          <ConversationItems
            {...props}
            items={item.children ?? []}
            groupActivities={false}
          />
        )}
      />
    );
  }
  if (item.kind === "tool") {
    const researchLabel = topolumiaToolLabel(item, en, item.status);
    const label = toolCallLabel(item, en, item.status);
    return (
      <Expander
        item={item}
        className="tool-group"
        state={item.status}
        bodyClass="tool-body"
        summary={
          <>
            <AgentEventIcon item={item} />
            <span className="tool-call-title" translate="no" title={label}>
              {label}
            </span>
            {(item.callCount ?? 1) > 1 && (
              <span className="streaming">×{item.callCount}</span>
            )}
            {item.status === "running" ? (
              !researchLabel && (
                <span className="streaming">
                  {conversationStatus(item.status, en)}
                </span>
              )
            ) : (
              <ToolStatusIcon status={item.status} en={en} />
            )}
          </>
        }
        renderBody={() => (
          <>
            {compactTraceEvents(item.events ?? []).map((event, index) => (
              <div className="tool-final-result" key={event.id}>
                {(item.callCount ?? 1) > 1 && (
                  <small>
                    {en ? `Call ${index + 1}` : `第 ${index + 1} 次调用`}
                  </small>
                )}
                <ToolResult event={event} en={en} onSource={props.onSource} />
              </div>
            ))}
          </>
        )}
      />
    );
  }
  return (
    <Expander
      item={item}
      className={`tool-group ${item.kind === "reasoning" || item.kind === "status" ? "compact-event" : ""}`}
      state={item.streaming ? "running" : item.status}
      bodyClass={
        item.kind === "reasoning"
          ? "tool-detail reasoning-detail"
          : "tool-detail"
      }
      summary={
        <>
          <AgentEventIcon item={item} />
          {item.kind === "reasoning"
            ? en
              ? "Reasoning summary"
              : "推理摘要"
            : item.title}
          {item.kind !== "reasoning" && (
            <span className="streaming">
              {conversationStatus(item.status, en)}
            </span>
          )}
          {partial && (
            <span className="content-completion">
              {conversationStatus(item.completion, en)}
            </span>
          )}
        </>
      }
      renderBody={() =>
        item.kind === "reasoning" ? (
          <span
            dangerouslySetInnerHTML={{
              __html: renderReasoningSummary(item.text ?? ""),
            }}
          />
        ) : (
          item.detail
        )
      }
    />
  );
});

export function ConversationItems({
  items: source,
  groupActivities = true,
  afterItem,
  deferMessages = source.length > 100,
  ...props
}: Props) {
  const items = useMemo(
    () => (groupActivities ? groupActivityRuns(source) : source),
    [source, groupActivities],
  );
  return (
    <>
      {items.map((item) => (
        <Fragment key={item.key}>
          <ConversationRow item={item} {...props} deferMessages={deferMessages} />
          {afterItem?.(item)}
        </Fragment>
      ))}
    </>
  );
}
