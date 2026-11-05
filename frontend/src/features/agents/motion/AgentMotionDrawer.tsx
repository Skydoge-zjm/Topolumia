import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AGENT_EASING,
  AGENT_MOTION,
  animateAgentElement,
  cancelAgentAnimations,
} from "@/features/agents/motion/agentMotion";

export function AgentMotionDrawer({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const [present, setPresent] = useState(open);
  const ref = useRef<HTMLElement>(null);
  if (open && !present) setPresent(true);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    let current = true;
    const animation = animateAgentElement(
      node,
      open
        ? [
            { opacity: 0, transform: "translateX(16px)" },
            { opacity: 1, transform: "translateX(0)" },
          ]
        : [
            { opacity: 1, transform: "translateX(0)" },
            { opacity: 0, transform: "translateX(16px)" },
          ],
      open ? AGENT_MOTION.drawerEnter : AGENT_MOTION.drawerExit,
      "presence",
      AGENT_EASING.standard,
    );
    if (!open) {
      const finish = () => {
        if (current) setPresent(false);
      };
      if (animation) animation.finished.then(finish, finish);
      else finish();
    }
    return () => {
      current = false;
    };
  }, [open, present]);
  useLayoutEffect(() => () => cancelAgentAnimations(ref.current), []);
  useLayoutEffect(() => {
    const grid = ref.current?.closest<HTMLElement>(".agent-grid");
    const composer = grid?.querySelector<HTMLElement>(".composer");
    if (!present || !grid || !composer) return;
    const measure = () =>
      grid.style.setProperty(
        "--agent-composer-height",
        `${Math.ceil(composer.getBoundingClientRect().height)}px`,
      );
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(composer);
    return () => {
      observer?.disconnect();
      grid.style.removeProperty("--agent-composer-height");
    };
  }, [present]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, onClose]);
  return present ? (
    <aside
      className="research-drawer"
      ref={ref}
      aria-label={label}
      aria-hidden={!open}
      inert={!open}
    >
      {children}
    </aside>
  ) : null;
}
