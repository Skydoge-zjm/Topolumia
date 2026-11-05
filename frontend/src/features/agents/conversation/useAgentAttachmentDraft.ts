import { useCallback, useRef, useState } from "react";
import type { SetStateAction } from "react";
import { api, projectId } from "@/shared/lib/api";
import {
  agentStorageKey,
  readAgentStorage,
  writeAgentStorage,
} from "../sessions/agentStorage";
import {
  MAX_AGENT_IMAGES,
  MAX_AGENT_IMAGE_BYTES,
  type AgentImageAttachment,
} from "@domain/agents/agent-attachments";

export function useAgentAttachmentDraft(
  sessionId: string | undefined,
  en: boolean,
) {
  const key = agentStorageKey("images", sessionId),
    project = projectId();
  const [state, setState] = useState(() => ({
    key,
    images: readAgentStorage<AgentImageAttachment[]>(key, []),
  }));
  const [pending, setPending] = useState<Record<string, number>>({});
  const pendingRef = useRef<Record<string, number>>({});
  const [error, setError] = useState({ key, message: "" });
  const images =
    state.key === key
      ? state.images
      : readAgentStorage<AgentImageAttachment[]>(key, []);
  const setImages = useCallback(
    (value: SetStateAction<AgentImageAttachment[]>) => {
      const images =
        typeof value === "function"
          ? value(readAgentStorage<AgentImageAttachment[]>(key, []))
          : value;
      writeAgentStorage(key, images);
      setState({ key, images });
    },
    [key],
  );
  const upload = async (files: File[]) => {
    if (!sessionId || !files.length) return;
    setError({ key, message: "" });
    if (
      readAgentStorage<AgentImageAttachment[]>(key, []).length +
        (pendingRef.current[key] ?? 0) +
        files.length >
      MAX_AGENT_IMAGES
    ) {
      setError({
        key,
        message: en
          ? `Attach up to ${MAX_AGENT_IMAGES} images per message.`
          : `每条消息最多添加 ${MAX_AGENT_IMAGES} 张图片。`,
      });
      return;
    }
    if (
      files.some(
        (file) =>
          file.size > MAX_AGENT_IMAGE_BYTES ||
          !/^image\/(png|jpeg|gif|webp)$/.test(file.type),
      )
    ) {
      setError({
        key,
        message: en
          ? "Use PNG, JPEG, GIF or WebP images, up to 5 MB each."
          : "支持 PNG、JPEG、GIF、WebP，每张不超过 5 MB。",
      });
      return;
    }
    pendingRef.current[key] = (pendingRef.current[key] ?? 0) + files.length;
    setPending({ ...pendingRef.current });
    try {
      for (const file of files) {
        const result = await api<{ attachment: AgentImageAttachment }>(
          `/api/agent-sessions/${encodeURIComponent(sessionId)}/attachments`,
          {
            method: "POST",
            body: file,
            headers: {
              "content-type": "application/octet-stream",
              "x-image-name": encodeURIComponent(
                file.name || "pasted-image.png",
              ),
              "x-rw-project-id": project,
            },
          },
        );
        setImages((current) => [...current, result.attachment]);
      }
    } catch (cause) {
      setError({
        key,
        message:
          cause instanceof Error
            ? cause.message
            : en
              ? "Image upload failed."
              : "图片上传失败。",
      });
    } finally {
      pendingRef.current[key] -= files.length;
      setPending({ ...pendingRef.current });
    }
  };
  return {
    images,
    setImages,
    upload,
    remove: async (id: string) => {
      if (!sessionId) return;
      try { await api(`/api/agent-sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }); setImages(current => current.filter(image => image.id !== id)); }
      catch (cause) { setError({ key, message: cause instanceof Error ? cause.message : String(cause) }); }
    },
    uploading: Boolean(pending[key]),
    error: error.key === key ? error.message : "",
  };
}
