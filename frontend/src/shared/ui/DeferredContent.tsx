import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** Keep a measured placeholder while expensive content is outside the reading area. */
export function DeferredContent({ children, eager = false, estimatedHeight = 180 }: {
  children: () => ReactNode;
  eager?: boolean;
  estimatedHeight?: number;
}) {
  const element = useRef<HTMLDivElement>(null);
  const height = useRef(estimatedHeight);
  const [visible, setVisible] = useState(() => eager || typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (eager || typeof IntersectionObserver === "undefined" || !element.current) return;
    const node = element.current;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) height.current = Math.max(1, entry.boundingClientRect.height);
        setVisible(entry.isIntersecting);
      }
    }, { root: node.closest(".conversation-scroll"), rootMargin: "800px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [eager]);
  const shown = eager || visible;
  return <div ref={element} style={shown ? undefined : { minHeight: height.current }} aria-busy={!shown || undefined}>{shown ? children() : null}</div>;
}
