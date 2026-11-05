import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { MessageSquare } from "lucide-react";
import type { ConversationItem } from "@/features/agents/conversation/model/agentConversation";
import {
  conversationWaypoints,
  navigationExcerpt,
} from "@/features/agents/conversation/model/conversationNavigation";
import type { ConversationWaypoint } from "@/features/agents/conversation/model/conversationNavigation";
import {
  AGENT_MOTION,
  animateAgentElement,
  reducedAgentMotion,
} from "@/features/agents/motion/agentMotion";

export function ConversationNavigator({
  items,
  scrollRef,
  en,
  onNavigate,
}: {
  items: ConversationItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
  en: boolean;
  onNavigate: () => void;
}) {
  const waypointCache = useRef(new Map<string, ConversationWaypoint>());
  const waypoints = useMemo(() => {
    const next = new Map<string, ConversationWaypoint>();
    const entries = conversationWaypoints(items).map((item) => {
      const old = waypointCache.current.get(item.key);
      const value =
        old?.text === item.text && old.reply === item.reply ? old : item;
      next.set(item.key, value);
      return value;
    });
    waypointCache.current = next;
    return entries;
  }, [items]);
  const [activeKey, setActiveKey] = useState<string>();
  const navRef = useRef<HTMLElement>(null);
  const highlight = useRef<{
    node: HTMLElement;
    overlay: HTMLElement | null;
    timer: number;
  } | null>(null);
  const keys = JSON.stringify(waypoints.map((item) => item.key));

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || keys === "[]") return;
    const included = new Set<string>(JSON.parse(keys));
    const anchors = [
      ...scroll.querySelectorAll<HTMLElement>("[data-user-message]"),
    ].filter((node) => included.has(node.dataset.userMessage ?? ""));
    let frame = 0;
    const measure = () => {
      frame = 0;
      const readingLine =
        scroll.getBoundingClientRect().top +
        Math.min(80, scroll.clientHeight / 4);
      let current = anchors.at(-1);
      if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >= 4) {
        let low = 0,
          high = anchors.length - 1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (anchors[middle].getBoundingClientRect().top <= readingLine)
            low = middle + 1;
          else high = middle - 1;
        }
        current = anchors[Math.max(0, high)];
      }
      setActiveKey(current?.dataset.userMessage);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    scroll.addEventListener("scroll", schedule, { passive: true });
    scroll.addEventListener("toggle", schedule, true);
    window.addEventListener("resize", schedule);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(scroll);
    const contentObserver = new MutationObserver(schedule);
    contentObserver.observe(scroll, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      contentObserver.disconnect();
      scroll.removeEventListener("scroll", schedule);
      scroll.removeEventListener("toggle", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [keys, scrollRef]);

  useEffect(() => {
    navRef.current
      ?.querySelector<HTMLButtonElement>("[aria-current]")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeKey]);

  useEffect(
    () => () => {
      if (highlight.current) {
        clearTimeout(highlight.current.timer);
        highlight.current.overlay?.remove();
        highlight.current.node.classList.remove("is-nav-target");
      }
    },
    [],
  );

  const jump = useCallback(
    (key: string) => {
      const scroll = scrollRef.current;
      const target = [
        ...(scroll?.querySelectorAll<HTMLElement>("[data-user-message]") ?? []),
      ].find((node) => node.dataset.userMessage === key);
      if (!scroll || !target) return;
      onNavigate();
      setActiveKey(key);
      const top =
        scroll.scrollTop +
        target.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top -
        24;
      if (scroll.scrollTo) scroll.scrollTo({ top, behavior: "auto" });
      else scroll.scrollTop = top;
      target.focus({ preventScroll: true });
      if (highlight.current) {
        clearTimeout(highlight.current.timer);
        highlight.current.overlay?.remove();
        highlight.current.node.classList.remove("is-nav-target");
      }
      target.classList.add("is-nav-target");
      let overlay: HTMLElement | null = null;
      if (!reducedAgentMotion()) {
        overlay = document.createElement("span");
        overlay.className = "message-locate-overlay";
        overlay.setAttribute("aria-hidden", "true");
        target.append(overlay);
        animateAgentElement(
          overlay,
          [{ opacity: 0.36 }, { opacity: 0 }],
          AGENT_MOTION.locate,
        );
      }
      highlight.current = {
        node: target,
        overlay,
        timer: window.setTimeout(() => {
          overlay?.remove();
          target.classList.remove("is-nav-target");
          highlight.current = null;
        }, AGENT_MOTION.locate),
      };
    },
    [onNavigate, scrollRef],
  );
  const moveFocus = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const next =
        event.key === "ArrowDown"
          ? Math.min(index + 1, waypoints.length - 1)
          : event.key === "ArrowUp"
            ? Math.max(index - 1, 0)
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? waypoints.length - 1
                : null;
      if (next === null) return;
      event.preventDefault();
      const buttons =
        navRef.current?.querySelectorAll<HTMLButtonElement>("button");
      buttons?.[next]?.focus();
    },
    [waypoints.length],
  );

  if (!waypoints.length) return null;
  const selected = activeKey ?? waypoints.at(-1)?.key;
  return (
    <nav
      className="conversation-nav"
      ref={navRef}
      aria-label={en ? "Message navigation" : "消息导航"}
    >
      <Tooltip.Provider delayDuration={180} skipDelayDuration={400}>
        <ol>
          {waypoints.map((waypoint, index) => (
            <NavigatorMark
              key={waypoint.key}
              waypoint={waypoint}
              index={index}
              total={waypoints.length}
              selected={selected === waypoint.key}
              en={en}
              onJump={jump}
              onMove={moveFocus}
            />
          ))}
        </ol>
      </Tooltip.Provider>
    </nav>
  );
}

const NavigatorMark = memo(function NavigatorMark({
  waypoint,
  index,
  total,
  selected,
  en,
  onJump,
  onMove,
}: {
  waypoint: ConversationWaypoint;
  index: number;
  total: number;
  selected: boolean;
  en: boolean;
  onJump: (key: string) => void;
  onMove: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void;
}) {
  return (
    <li>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className="conversation-nav-mark"
            translate="no"
            tabIndex={selected ? 0 : -1}
            aria-current={selected ? "location" : undefined}
            aria-label={
              en
                ? `Jump to user message ${index + 1}: ${navigationExcerpt(waypoint.text, 64)}`
                : `定位到第 ${index + 1} 条用户消息：${navigationExcerpt(waypoint.text, 64)}`
            }
            onKeyDown={(event) => onMove(event, index)}
            onClick={() => onJump(waypoint.key)}
          >
            <span aria-hidden="true" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="conversation-nav-preview"
            side="right"
            sideOffset={10}
            collisionPadding={12}
          >
            <div className="conversation-nav-preview-meta">
              <MessageSquare size={13} aria-hidden="true" />
              <span>{en ? "User message" : "用户消息"}</span>
              <span>
                {index + 1} / {total}
              </span>
            </div>
            <strong translate="no">{waypoint.text}</strong>
            {waypoint.reply && <p translate="no">{waypoint.reply}</p>}
            <Tooltip.Arrow className="conversation-nav-preview-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </li>
  );
});
