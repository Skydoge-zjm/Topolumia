import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction, RefObject } from "react";
import type { AgentSession, AgentImageAttachment } from "@/shared/types/api";
import type { AgentSubmission } from "./components/AgentComposer";
import { AgentTurnInputSchema } from "@/shared/types/schemas";
import {
  agentStorageKey,
  readAgentStorage,
  writeAgentStorage,
} from "../sessions/agentStorage";

type Failure = { input: AgentSubmission; error: string };
type Requester = <T>(path: string, options?: RequestInit) => Promise<T>;
type Options = {
  activeId?: string;
  activeRef: RefObject<string | undefined>;
  session?: AgentSession;
  draft: string;
  images: AgentImageAttachment[];
  model: string;
  effort: string;
  uploadingImages: boolean;
  en: boolean;
  key: string;
  setDraft: (text: string) => void;
  setImages: Dispatch<SetStateAction<AgentImageAttachment[]>>;
  setDraftState: Dispatch<SetStateAction<{ key: string; value: string }>>;
  put: (session: AgentSession) => void;
  refresh: (id?: string) => Promise<unknown>;
  request: Requester;
  setError: (text: string) => void;
};
export function useAgentSubmission({
  activeId,
  activeRef,
  session,
  draft,
  images,
  model,
  effort,
  uploadingImages,
  en,
  key,
  setDraft,
  setImages,
  setDraftState,
  put,
  refresh,
  request,
  setError,
}: Options) {
  const [sending, setSending] = useState<string[]>([]),
    sendingIds = useRef(new Set<string>());
  const [failures, setFailures] = useState<Record<string, Failure>>({});
  useEffect(() => {
    if (!activeId || !session || sendingIds.current.has(activeId)) return;
    const outboxKey = agentStorageKey("outbox", activeId),
      value = readAgentStorage<Failure | undefined>(outboxKey, undefined);
    if (!value?.input?.clientMessageId) return;
    const accepted = [
      ...(session.turns ?? []),
      ...(session.queuedMessages ?? []),
    ].some(
      (message) =>
        (message as { clientMessageId?: string }).clientMessageId ===
        value.input.clientMessageId,
    );
    if (accepted) {
      writeAgentStorage(outboxKey, undefined);
      const acceptedImages = new Set(
        value.input.attachments?.map((image) => image.id),
      );
      if (acceptedImages.size)
        setImages((current) =>
          current.filter((image) => !acceptedImages.has(image.id)),
        );
      if (readAgentStorage(key, "") === value.input.text) {
        writeAgentStorage(key, "");
        setDraftState({ key, value: "" });
      }
      setFailures((current) => {
        if (!current[activeId]) return current;
        const next = { ...current };
        delete next[activeId];
        return next;
      });
    } else
      setFailures((current) =>
        current[activeId]?.input.clientMessageId === value.input.clientMessageId
          ? current
          : { ...current, [activeId]: value },
      );
  }, [activeId, session, key, setImages, setDraftState]);
  const submit = async (input: AgentSubmission, retry = false) => {
    const id = activeId,
      capturedKey = key,
      capturedImagesKey = agentStorageKey("images", activeId),
      outboxKey = agentStorageKey("outbox", activeId);
    if (!id || !session || session.archived || sendingIds.current.has(id))
      return;
    sendingIds.current.add(id);
    setSending((current) => [...current, id]);
    writeAgentStorage(outboxKey, {
      input,
      error: en
        ? "Previous submission status is uncertain. Retry with the original message ID."
        : "上一条消息的提交状态需要确认，可用原标识重试。",
    });
    if (!retry || draft === input.text) setDraft("");
    const submittedImages = new Set(
      input.attachments?.map((image) => image.id),
    );
    if (submittedImages.size)
      setImages((current) =>
        current.filter((image) => !submittedImages.has(image.id)),
      );
    try {
      if (["detached", "failed", "closed"].includes(session.status))
        put(
          await request<AgentSession>(
            `/api/agent-sessions/${encodeURIComponent(id)}/resume`,
            {
              method: "POST",
              body: JSON.stringify({
                model: input.model,
                reasoningEffort: input.reasoningEffort,
              }),
            },
          ),
        );
      await request(`/api/agent-sessions/${encodeURIComponent(id)}/turns`, {
        method: "POST",
        body: JSON.stringify({
          text: input.text,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          clientMessageId: input.clientMessageId,
          attachmentIds:
            input.attachments?.map((image) => image.id) ?? input.attachmentIds,
        }),
      });
      writeAgentStorage(outboxKey, undefined);
      setFailures((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      if (activeRef.current === id) setError("");
      await refresh(id);
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : en
            ? "Message submission failed"
            : "消息发送失败";
      writeAgentStorage(outboxKey, { input, error: message });
      setFailures((current) => ({
        ...current,
        [id]: { input, error: message },
      }));
      if (!readAgentStorage(capturedKey, "")) {
        writeAgentStorage(capturedKey, input.text);
        if (activeRef.current === id)
          setDraftState({ key: capturedKey, value: input.text });
      }
      if (
        input.attachments?.length &&
        !readAgentStorage<AgentImageAttachment[]>(capturedImagesKey, []).length
      ) {
        writeAgentStorage(capturedImagesKey, input.attachments);
        if (activeRef.current === id) setImages(input.attachments);
      }
    } finally {
      sendingIds.current.delete(id);
      setSending((current) => current.filter((value) => value !== id));
    }
  };
  const send = () => {
    if (!session || (!draft.trim() && !images.length) || uploadingImages)
      return;
    try {
      const input = AgentTurnInputSchema.parse({
        text: draft,
        attachmentIds: images.map((image) => image.id),
        model: model || undefined,
        reasoningEffort: effort,
      });
      void submit({
        ...input,
        reasoningEffort: effort,
        clientMessageId: crypto.randomUUID(),
        attachments: images,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "输入无效");
    }
  };
  const failure = activeId ? failures[activeId] : undefined;
  const recover = () => {
    if (!failure) return;
    setDraft(failure.input.text);
    setImages(failure.input.attachments ?? []);
    writeAgentStorage(agentStorageKey("outbox", activeId), undefined);
    setFailures((current) => {
      const next = { ...current };
      delete next[activeId!];
      return next;
    });
  };
  return {
    send,
    failure,
    recover,
    retry: () => {
      if (failure) void submit(failure.input, true);
    },
    isSubmitting: Boolean(activeId && sending.includes(activeId)),
  };
}
