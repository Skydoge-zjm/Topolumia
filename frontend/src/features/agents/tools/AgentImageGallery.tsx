import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ImageOff, X } from "lucide-react";
import type { ConversationItem } from "../conversation/model/agentConversation";
import { compactTraceEvents } from "@domain/agents/agent-trace";
import { imageViewPath } from "@domain/agents/agent-images";
import { projectId } from "@/shared/lib/api";
import type { AgentImageAttachment } from "@domain/agents/agent-attachments";
import { attachmentImageUrl } from "./agentAttachments";

type GalleryImage = { key: string; name: string; path?: string; url?: string };

function ImageTile({
  image,
  en,
  onOpen,
}: {
  image: GalleryImage;
  en: boolean;
  onOpen: (button: HTMLButtonElement) => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      className="agent-image-tile"
      disabled={!image.url || failed}
      aria-label={en ? `Enlarge ${image.name}` : `放大查看 ${image.name}`}
      title={image.path}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <span className="agent-image-thumbnail">
        {image.url && !failed ? (
          <img
            src={image.url + "&variant=thumbnail"}
            alt={image.name}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="agent-image-unavailable">
            <ImageOff size={22} aria-hidden="true" />
            {en ? "Image unavailable" : "图像无法读取"}
          </span>
        )}
      </span>
      <span className="agent-image-name">{image.name}</span>
    </button>
  );
}

export function AgentImageGallery({
  items,
  en,
}: {
  items: ConversationItem[];
  en: boolean;
}) {
  const images: GalleryImage[] = items.map((item, index) => {
    const event = compactTraceEvents(item.events ?? []).at(-1);
    const path = event && imageViewPath(event);
    const name =
      path?.replace(/\\/g, "/").split("/").at(-1) ||
      (en ? `Image ${index + 1}` : `图像 ${index + 1}`);
    return {
      key: item.key,
      name,
      path,
      url:
        event && path
          ? `/api/agent-sessions/${encodeURIComponent(event.sessionId)}/images/${encodeURIComponent(event.id)}?projectId=${encodeURIComponent(projectId())}&revision=${event.updatedCursor ?? event.cursor}`
          : undefined,
    };
  });
  return <ImageGallery images={images} en={en} />;
}

export function AgentAttachmentGallery({
  attachments,
  sessionId,
  en,
}: {
  attachments: AgentImageAttachment[];
  sessionId: string;
  en: boolean;
}) {
  return (
    <ImageGallery
      en={en}
      images={attachments.map((image) => ({
        key: image.id,
        name: image.name,
        url: attachmentImageUrl(sessionId, image.id),
      }))}
    />
  );
}

function ImageGallery({ images, en }: { images: GalleryImage[]; en: boolean }) {
  const [selected, setSelected] = useState<GalleryImage | null>(null);
  const origin = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <div className="agent-image-grid" translate="no">
        {images.map((image) => (
          <ImageTile
            key={`${image.key}:${image.url}`}
            image={image}
            en={en}
            onOpen={(button) => {
              origin.current = button;
              setSelected(image);
            }}
          />
        ))}
      </div>
      <Dialog.Root
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay agent-image-overlay" />
          <Dialog.Content aria-describedby={undefined}
            className="agent-image-dialog" translate="no"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              origin.current?.focus();
            }}
          >
            <header>
              <div>
                <Dialog.Title>{selected?.name}</Dialog.Title>

              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={en ? "Close image" : "关闭大图"}
                >
                  <X size={20} />
                </button>
              </Dialog.Close>
            </header>
            {selected?.url && (
              <img
                className="agent-image-full"
                src={selected.url}
                alt={selected.name}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
