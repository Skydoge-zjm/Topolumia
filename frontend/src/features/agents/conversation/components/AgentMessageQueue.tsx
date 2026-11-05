import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Pencil, Play, X } from "lucide-react";
import type { QueuedAgentMessage } from "@/shared/types/api";
import {
  AGENT_EASING,
  AGENT_MOTION,
  animateAgentElement,
  enterAgentElement,
} from "@/features/agents/motion/agentMotion";

type QueueRow = {
  message: QueuedAgentMessage;
  entering: boolean;
  exiting: boolean;
};

function QueuedRow({
  row,
  index,
  disabled,
  en,
  onRemove,
  onExited,
  onEdit,
}: {
  row: QueueRow;
  index: number;
  disabled: boolean;
  en: boolean;
  onRemove: (id: string) => void;
  onExited: (id: string) => void;
  onEdit?: (id: string, text: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false),
    [text, setText] = useState(row.message.text),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const save = async () => {
    if (!onEdit || (!text.trim() && !row.message.attachments?.length)) return;
    setBusy(true);
    setError("");
    try {
      await onEdit(row.message.id, text);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "修改失败");
    } finally {
      setBusy(false);
    }
  };
  const ref = useRef<HTMLLIElement>(null);
  const exited = useRef(onExited);
  exited.current = onExited;
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    let current = true;
    if (row.exiting) {
      const animation = animateAgentElement(
        node,
        [
          { opacity: 1, transform: "translateY(0)" },
          { opacity: 0, transform: "translateY(-2px)" },
        ],
        AGENT_MOTION.queueExit,
        "presence",
        AGENT_EASING.exit,
      );
      const finish = () => {
        if (current) exited.current(row.message.id);
      };
      if (animation) animation.finished.then(finish, finish);
      else finish();
    } else if (row.entering) enterAgentElement(node);
    return () => {
      current = false;
    };
  }, [row.exiting, row.entering, row.message.id]);
  return (
    <li
      ref={ref}
      data-queue-id={row.message.id}
      data-exiting={row.exiting || undefined}
      aria-hidden={row.exiting || undefined}
      inert={row.exiting}
    >
      <span className="queue-position" aria-hidden="true">
        {index + 1}
      </span>
      {editing ? (
        <div className="queue-editor">
          <textarea
            aria-label={en ? "Edit queued message" : "编辑待发送消息"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={10000}
          />
          <div>
            <button
              type="button"
              disabled={busy || (!text.trim() && !row.message.attachments?.length)}
              onClick={() => void save()}
            >
              {en ? "Save" : "保存"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              {en ? "Cancel" : "取消"}
            </button>
          </div>
          {error && <span role="alert">{error}</span>}
        </div>
      ) : (
        <>
          <span
            className="queue-message"
            translate="no"
            title={row.message.text}
          >
            {row.message.text || (en ? "Image message" : "图片消息")}
            {Boolean(row.message.attachments?.length) && <small>{en ? `${row.message.attachments!.length} images` : `${row.message.attachments!.length} 张图片`}</small>}
            <small>
              {row.message.model ?? (en ? "Default model" : "默认模型")}
            </small>
          </span>
          {onEdit && (
            <button
              type="button"
              disabled={disabled || row.exiting}
              aria-label={
                en
                  ? `Edit queued message ${index + 1}`
                  : `编辑待发送消息 ${index + 1}`
              }
              onClick={() => {
                setText(row.message.text);
                setEditing(true);
              }}
            >
              <Pencil size={12} />
            </button>
          )}
        </>
      )}
      <button
        type="button"
        disabled={disabled || row.exiting}
        onClick={() => onRemove(row.message.id)}
        aria-label={
          en
            ? `Remove queued message ${index + 1}`
            : `移除待发送消息 ${index + 1}`
        }
      >
        <X size={13} aria-hidden="true" />
      </button>
    </li>
  );
}

export function AgentMessageQueue({
  messages,
  paused,
  disabled,
  busy,
  en,
  ready = true,
  onRemove,
  onResume,
  onEdit,
}: {
  messages: QueuedAgentMessage[];
  paused: boolean;
  disabled: boolean;
  busy: boolean;
  en: boolean;
  ready?: boolean;
  onRemove: (id: string) => void;
  onResume: () => void;
  onEdit?: (id: string, text: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const key = JSON.stringify(
    messages.map((message) => [message.id, message.text]),
  );
  const [snapshot, setSnapshot] = useState({
    key,
    ready,
    rows: messages.map((message) => ({
      message,
      entering: false,
      exiting: false,
    })),
  });
  if (key !== snapshot.key || ready !== snapshot.ready) {
    const existing = new Map(snapshot.rows.map((row) => [row.message.id, row]));
    const live = new Map(messages.map((message) => [message.id, message]));
    // Retain a departing row in its original slot until its fade finishes.
    const rows = snapshot.rows.map((row) => ({
      message: live.get(row.message.id) ?? row.message,
      entering: false,
      exiting: !live.has(row.message.id),
    }));
    const added = messages
      .filter((message) => !existing.has(message.id))
      .map((message) => ({
        message,
        entering: snapshot.ready,
        exiting: false,
      }));
    setSnapshot({ key, ready, rows: [...rows, ...added] });
  }
  if (!snapshot.rows.length) return null;
  return (
    <section
      className="composer-queue"
      aria-label={en ? "Queued messages" : "待发送消息"}
    >
      <header>
        <span role="status">
          {en
            ? `${messages.length} queued${paused ? " · paused" : ""}`
            : `${messages.length} 条待发送${paused ? " · 已暂停" : ""}`}
        </span>
        {messages.length > 1 && (
          <button
            type="button"
            aria-label={
              expanded
                ? en
                  ? "Collapse queue"
                  : "折叠队列"
                : en
                  ? "Expand queue"
                  : "展开队列"
            }
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
        {paused && (
          <button type="button" disabled={disabled || busy} onClick={onResume}>
            <Play size={12} aria-hidden="true" />
            {en ? "Continue queue" : "继续队列"}
          </button>
        )}
      </header>
      <ol>
        {(expanded || paused ? snapshot.rows : snapshot.rows.slice(0, 1)).map(
          (row, index) => (
            <QueuedRow
              key={row.message.id}
              row={row}
              index={index}
              disabled={disabled}
              en={en}
              onRemove={onRemove}
              onEdit={onEdit}
              onExited={(id) =>
                setSnapshot((current) => ({
                  ...current,
                  rows: current.rows.filter(
                    (item) => item.message.id !== id || !item.exiting,
                  ),
                }))
              }
            />
          ),
        )}
      </ol>
    </section>
  );
}
