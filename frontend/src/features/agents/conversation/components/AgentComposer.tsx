import { useLayoutEffect, useRef } from "react";
import { ArrowUp, ImagePlus, X } from "lucide-react";
import type { AgentSession, AgentImageAttachment } from "@/shared/types/api";
import { attachmentImageUrl } from "../../tools/agentAttachments";
import { SelectMenu } from "../../../../shared/ui/SelectMenu";
import { AgentMessageQueue } from "./AgentMessageQueue";

export type AgentSubmission = {
  text: string;
  model?: string;
  reasoningEffort: string;
  clientMessageId: string;
  attachmentIds?: string[];
  attachments?: AgentImageAttachment[];
};
export function AgentComposer({
  session,
  draft,
  setDraft,
  en,
  submitting,
  stopping,
  model,
  effort,
  models,
  efforts,
  setModel,
  setEffort,
  onSend,
  onStop,
  onRemove,
  onEdit,
  onResume,
  failed,
  onRecover,
  onRetry,
  images,
  onAddImages,
  onRemoveImage,
  uploading,
  imageError,
}: {
  session?: AgentSession;
  draft: string;
  setDraft: (text: string) => void;
  en: boolean;
  submitting: boolean;
  stopping: boolean;
  model: string;
  effort: string;
  models: Array<{ value: string; label: string }>;
  efforts: Array<{ value: string; label: string }>;
  setModel: (value: string) => void;
  setEffort: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onRemove: (id: string) => void;
  onEdit: (id: string, text: string) => Promise<void>;
  onResume: () => void;
  failed?: { input: AgentSubmission; error: string };
  onRecover: () => void;
  onRetry: () => void;
  images: AgentImageAttachment[];
  onAddImages: (files: File[]) => void;
  onRemoveImage: (id: string) => void;
  uploading: boolean;
  imageError?: string;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const node = input.current;
    if (node) {
      node.style.height = "0px";
      node.style.height = `${Math.min(144, Math.max(36, node.scrollHeight))}px`;
    }
  }, [draft]);
  const executing = ["running", "awaiting_permission"].includes(
      session?.status ?? "",
    ),
    stop = executing && !draft.trim() && !images.length && !uploading;
  const sendable =
    session &&
    !session.archived &&
    ["ready", "detached", "running", "awaiting_permission"].includes(
      session.status,
    );
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!submitting && !uploading && (draft.trim() || images.length))
          onSend();
      }}
    >
      <AgentMessageQueue
        messages={session?.queuedMessages ?? []}
        paused={Boolean(session?.queuePaused)}
        disabled={false}
        busy={executing}
        en={en}
        onRemove={onRemove}
        onEdit={onEdit}
        onResume={onResume}
      />
      {failed && (
        <div className="composer-recovery" role="alert">
          <span>{failed.error}</span>
          <button type="button" disabled={submitting} onClick={onRetry}>
            {en ? "Retry original message" : "重试原消息"}
          </button>
          <button type="button" onClick={onRecover}>
            {en ? "Restore message" : "恢复到输入框"}
          </button>
        </div>
      )}
      <div className="composer-frame">
        {images.length > 0 && session && (
          <div className="composer-images" translate="no">
            {images.map((image) => (
              <div className="composer-image" key={image.id}>
                <img
                  src={attachmentImageUrl(session!.id, image.id)}
                  alt={image.name}
                  title={image.name}
                />
                <button
                  type="button"
                  aria-label={
                    en ? `Remove ${image.name}` : `移除图片 ${image.name}`
                  }
                  onClick={() => onRemoveImage(image.id)}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        {uploading && (
          <div className="composer-image-feedback" role="status">
            {en ? "Uploading images…" : "正在上传图片…"}
          </div>
        )}
        {imageError && (
          <div className="composer-image-feedback" role="alert">
            {imageError}
          </div>
        )}
        <textarea
          ref={input}
          aria-label={en ? "Research message" : "研究消息"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.items]
              .filter(
                (item) =>
                  item.kind === "file" && item.type.startsWith("image/"),
              )
              .map((item) => item.getAsFile())
              .filter((file): file is File => Boolean(file));
            if (!files.length) return;
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            if (text)
              setDraft(
                draft.slice(0, event.currentTarget.selectionStart) +
                  text +
                  draft.slice(event.currentTarget.selectionEnd),
              );
            if (session && !session.archived) onAddImages(files);
          }}
          maxLength={10_000}
          placeholder={
            session?.archived
              ? en
                ? "Restore this conversation to continue"
                : "恢复归档后继续会话"
              : en
                ? "Ask a research question or paste an image…"
                : "提出研究问题，或粘贴图片…"
          }
          rows={1}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-footer">
          <input
            ref={fileInput}
            className="composer-file-input"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            aria-label={en ? "Choose images" : "选择图片"}
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              onAddImages(files);
            }}
          />
          <button
            type="button"
            className="composer-attach"
            aria-label={en ? "Attach images" : "添加图片"}
            title={en ? "Attach images" : "添加图片"}
            disabled={!sendable}
            onClick={() => fileInput.current?.click()}
          >
            <ImagePlus size={17} />
          </button>
          {submitting && <span className="composer-status" role="status">{en ? "Sending…" : "正在发送…"}</span>}
          <div
            className="composer-model-control"
            title={
              en ? "Settings for the next message" : "下一条消息使用的设置"
            }
          >
            <SelectMenu
              value={model}
              onChange={setModel}
              ariaLabel={en ? "Model" : "模型"}
              options={models}
            />
            <SelectMenu
              value={effort}
              onChange={setEffort}
              ariaLabel={en ? "Reasoning effort" : "推理强度"}
              options={efforts}
            />
          </div>
          <button
            className={`composer-send ${stop ? "is-stop" : ""}`}
            type={stop ? "button" : "submit"}
            onClick={stop ? onStop : undefined}
            disabled={
              stop
                ? stopping
                : !sendable ||
                  (!draft.trim() && !images.length) ||
                  submitting ||
                  uploading
            }
            aria-label={
              stop
                ? stopping
                  ? en
                    ? "Stopping Agent"
                    : "正在停止 Agent"
                  : en
                    ? "Stop Agent"
                    : "停止 Agent"
                : executing
                  ? en
                    ? "Queue message"
                    : "排队发送"
                  : en
                    ? "Send message"
                    : "发送消息"
            }
          >
            <span className="composer-control-arrow" aria-hidden="true">
              <ArrowUp size={17} />
            </span>
            <span className="composer-control-stop" aria-hidden="true">
              <span className="composer-stop-icon" />
            </span>
          </button>
        </div>
      </div>
    </form>
  );
}
