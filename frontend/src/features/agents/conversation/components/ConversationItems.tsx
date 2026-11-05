import type { ConversationItem } from "@/features/agents/conversation/model/agentConversation";
import { renderMarkdown, renderReasoningSummary } from "@/shared/lib/markdown";
import {
  groupActivityRuns,
  activitySummary,
} from "@/features/agents/conversation/model/agentActivity";
import { compactTraceEvents } from "@domain/agents/agent-trace";
import { AgentEventIcon } from "../../icons/AgentEventIcon";
import { Check, Copy, NotebookPen } from "lucide-react";
import { Fragment, memo, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { copyText } from "@/shared/lib/copyText";
import {
  toolCallLabel,
  topolumiaToolLabel,
} from "@/features/agents/tools/agentTool";
import { ToolResult } from "../../tools/ToolResult";
import {
  AgentImageGallery,
  AgentAttachmentGallery,
} from "../../tools/AgentImageGallery";
import { AgentApprovalCard } from "../../approvals/AgentApprovalCard";
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
  onSave?: (item: ConversationItem) => Promise<void>;
  onSource?: (ref: string, version?: string) => void;
  afterItem?: (item: ConversationItem) => ReactNode;
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
  onSave,
  onSource,
}: Pick<Props, "en" | "onSave" | "onSource"> & { item: ConversationItem }) {
  const [feedback, setFeedback] = useState(""),
    [saving, setSaving] = useState(false),
    [saved, setSaved] = useState(false);
  const html = useMemo(
    () => renderMarkdown(item.text ?? "", { en, highlight: !item.streaming }),
    [item.text, item.streaming, en],
  );
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
  const save = async () => {
    if (!onSave || saving || saved) return;
    setSaving(true);
    setFeedback("");
    try {
      await onSave(item);
      setSaved(true);
      setFeedback(en ? "Submitted for research review" : "已提交研究变更审阅");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      setSaving(false);
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
      {item.role !== "user" && (item.phase || item.streaming || partial) && (
        <header>
          {item.phase === "commentary" && (
            <span className="streaming">{en ? "Progress" : "进展"}</span>
          )}
          {item.phase === "final_answer" && (
            <span className="streaming">{en ? "Answer" : "答复"}</span>
          )}
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
      <div
        className="message-body"
        translate="no"
        onClick={(event) => {
          const target = event.target as HTMLElement;
          const button = target.closest<HTMLElement>("[data-code-copy]");
          if (button)
            void copy(
              button.closest(".code-block")?.querySelector("code")
                ?.textContent ?? "",
            );
          const source = target.closest<HTMLElement>("[data-source-ref]");
          if (source?.dataset.sourceRef) onSource?.(source.dataset.sourceRef);
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
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
          {item.role === "assistant" &&
            !item.streaming &&
            onSave &&
            item.sourceEventIds?.length && (
              <button
                type="button"
                disabled={saving || saved}
                onClick={() => void save()}
                aria-label={en ? "Propose research note" : "整理为科研笔记"}
              >
                <NotebookPen size={13} />
                {saving
                  ? en
                    ? "Saving…"
                    : "提交中…"
                  : saved
                    ? en
                      ? "Submitted"
                      : "已提交"
                    : en
                      ? "Research note"
                      : "科研笔记"}
              </button>
            )}
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
            {summary.failed > 0 && (
              <span className="activity-state has-failures">
                {en ? `${summary.failed} failed` : `${summary.failed} 项失败`}
              </span>
            )}
            {summary.incomplete > 0 && (
              <span className="activity-state">
                {en
                  ? `${summary.incomplete} incomplete`
                  : `${summary.incomplete} 项未完成`}
              </span>
            )}
            <span className="motion-complete-badge" aria-hidden="true">
              <Check size={12} />
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
            {(!researchLabel || item.status !== "running") && (
              <span className="streaming">
                {conversationStatus(item.status, en)}
              </span>
            )}
            <span className="motion-complete-badge" aria-hidden="true">
              <Check size={12} />
            </span>
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
          <ConversationRow item={item} {...props} />
          {afterItem?.(item)}
        </Fragment>
      ))}
    </>
  );
}
