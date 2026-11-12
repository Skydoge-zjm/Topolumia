import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Download, X } from "lucide-react";

/** A figure at reading size; click to inspect it at full size without leaving the page. */
export function ImageFigure({ src, alt, caption, locator, en }: { src: string; alt: string; caption?: string; locator?: string; en: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <figure className="content-block-image">
      <button type="button" className="content-block-image-open" aria-label={en ? "View image at full size" : "放大查看图片"} onClick={() => setOpen(true)}>
        <img src={src} alt={alt} loading="lazy" />
      </button>
      {(caption || locator) && <figcaption>{caption}{locator && <span className="content-block-image-locator">{locator}</span>}</figcaption>}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="lightbox-overlay" />
          <Dialog.Content className="lightbox" aria-describedby={undefined} translate="no">
            <header>
              <Dialog.Title>{alt}</Dialog.Title>
              <a className="button" href={src} target="_blank" rel="noopener noreferrer"><Download size={14} />{en ? "Open original" : "查看原图"}</a>
              <Dialog.Close className="button" aria-label="关闭 / Close"><X size={16} /></Dialog.Close>
            </header>
            <div className="lightbox-stage" onClick={() => setOpen(false)}><img src={src} alt={alt} /></div>
            {caption && <p>{caption}</p>}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </figure>
  );
}
