import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { AgentEvent } from "@/shared/types/api";
import {
  AGENT_MOTION,
  animateAgentElement,
  enterAgentElement,
} from "./agentMotion";

export function useTranscriptMotion({
  events,
  cursor,
  ready,
  working,
  scrollRef,
  onInspect,
}: {
  events: AgentEvent[];
  cursor: number;
  ready: boolean;
  working: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onInspect: () => void;
}) {
  const baseline = useRef<number | null>(null);
  const seen = useRef(new Set<string>());
  const replies = useRef(new Set<string>());
  const statuses = useRef(new Map<string, string>());
  const scheduleRef = useRef<() => void>(() => {});
  const inspectRef = useRef(onInspect);
  inspectRef.current = onInspect;
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let frame = 0;
    let active: HTMLElement | null = null;
    let pending: HTMLElement | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    const completionTimers = timers.current;
    let anchor: { summary: HTMLElement; top: number } | null = null;
    const clear = () => {
      if (active) delete active.dataset.motionActive;
      active = null;
      clearTimeout(pendingTimer);
      pending = null;
    };
    const measure = () => {
      frame = 0;
      const fallback = scroll.querySelector<HTMLElement>(
        "[data-motion-fallback]",
      );
      if (
        scroll.parentElement?.dataset.motionEnabled !== "true" ||
        document.hidden
      ) {
        clear();
        if (fallback) fallback.hidden = true;
        return;
      }
      const bounds = scroll.getBoundingClientRect();
      const candidates = [
        ...scroll.querySelectorAll<HTMLElement>(
          "[data-motion-candidate]:not([data-motion-fallback])[data-state='running']",
        ),
      ].filter((node) => {
        if (
          node.parentElement?.closest(
            "[data-motion-candidate][data-state='running']",
          )
        )
          return false;
        const indicator = node.querySelector<HTMLElement>(
          ":scope > summary [data-motion-indicator], :scope > header [data-motion-indicator]",
        );
        const rect = indicator?.getBoundingClientRect();
        return (
          rect &&
          rect.height > 0 &&
          rect.bottom > bounds.top &&
          rect.top < bounds.bottom
        );
      });
      if (fallback)
        fallback.hidden =
          candidates.length > 0 ||
          scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 120;
      const candidate =
        candidates
          .at(-1)
          ?.querySelector<HTMLElement>(
            ":scope > summary [data-motion-indicator], :scope > header [data-motion-indicator]",
          ) ??
        (fallback && !fallback.hidden
          ? fallback.querySelector<HTMLElement>("[data-motion-indicator]")
          : null);
      if (candidate && (candidate === active || candidate === pending)) return;
      clear();
      if (!candidate) return;
      pending = candidate;
      pendingTimer = setTimeout(() => {
        if (
          pending === candidate &&
          candidate.isConnected &&
          candidate.closest<HTMLElement>("[data-motion-candidate]")?.dataset
            .state === "running" &&
          scroll.parentElement?.dataset.motionEnabled === "true"
        ) {
          active = candidate;
          active.dataset.motionActive = "true";
          pending = null;
        }
      }, AGENT_MOTION.presenceDelay);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    scheduleRef.current = schedule;
    const remember = (event: Event) => {
      if (event instanceof KeyboardEvent && !["Enter", " "].includes(event.key))
        return;
      const summary = (event.target as Element)?.closest<HTMLElement>(
        "summary",
      );
      if (!summary || !scroll.contains(summary)) return;
      anchor = { summary, top: summary.getBoundingClientRect().top };
      inspectRef.current();
    };
    const toggle = (event: Event) => {
      const details = event.target as HTMLDetailsElement;
      if (details.tagName !== "DETAILS") return;
      if (anchor?.summary.parentElement === details) {
        scroll.scrollTop +=
          anchor.summary.getBoundingClientRect().top - anchor.top;
        anchor = null;
      }
      if (details.open) {
        const body = details.querySelector<HTMLElement>(
          ":scope > .tool-body, :scope > .tool-detail, :scope > .activity-batch-body, :scope > .subagent-body",
        );
        if (body) enterAgentElement(body, 2, AGENT_MOTION.content);
      }
      schedule();
    };
    const observer = new MutationObserver(schedule);
    observer.observe(scroll, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    resize?.observe(scroll);
    scroll.addEventListener("scroll", schedule, { passive: true });
    scroll.addEventListener("click", remember, true);
    scroll.addEventListener("keydown", remember, true);
    scroll.addEventListener("toggle", toggle, true);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      cancelAnimationFrame(frame);
      clear();
      observer.disconnect();
      resize?.disconnect();
      scroll.removeEventListener("scroll", schedule);
      scroll.removeEventListener("click", remember, true);
      scroll.removeEventListener("keydown", remember, true);
      scroll.removeEventListener("toggle", toggle, true);
      document.removeEventListener("visibilitychange", schedule);
      for (const timer of completionTimers) clearTimeout(timer);
    };
  }, [scrollRef]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !ready) return;
    const nodes = [
      ...scroll.querySelectorAll<HTMLElement>("[data-motion-key]"),
    ];
    if (baseline.current === null) {
      baseline.current = cursor;
      for (const node of nodes) {
        seen.current.add(node.dataset.motionKey!);
        if (node.dataset.state)
          statuses.current.set(node.dataset.motionKey!, node.dataset.state);
      }
      enterAgentElement(scroll, 0, AGENT_MOTION.content);
    } else {
      const liveTurns = new Set(
        events
          .filter(
            (event) =>
              event.type === "turn.started" && event.cursor > baseline.current!,
          )
          .map((event) => event.turnId),
      );
      for (const node of nodes) {
        const key = node.dataset.motionKey!;
        const fresh = !seen.current.has(key);
        const live = liveTurns.has(node.dataset.turnKey);
        if (
          node.dataset.motionRole === "assistant" &&
          !node.querySelector(".message-body")?.textContent?.trim()
        )
          continue;
        if (fresh && live && node.getClientRects().length) {
          if (node.dataset.motionRole === "user") enterAgentElement(node);
          if (node.dataset.motionRole === "assistant") {
            const actor = `${node.dataset.turnKey}:${node.dataset.motionActor ?? "main"}`;
            if (!replies.current.has(actor) && node.textContent?.trim()) {
              replies.current.add(actor);
              enterAgentElement(node);
            }
          }
          if (node.dataset.motionRole === "approval")
            enterAgentElement(node, 0, 220);
        }
        const previous = statuses.current.get(key);
        if (
          live &&
          node.dataset.state === "completed" &&
          previous !== "completed"
        ) {
          const badge = node.querySelector<HTMLElement>(
            ":scope > summary .motion-complete-badge",
          );
          if (badge) {
            node.dataset.motionCompleted = "true";
            animateAgentElement(
              badge,
              [{ opacity: 0 }, { opacity: 1 }],
              AGENT_MOTION.icon,
            );
            const timer = setTimeout(() => {
              delete node.dataset.motionCompleted;
              timers.current.delete(timer);
            }, AGENT_MOTION.locate);
            timers.current.add(timer);
          }
        }
        if (node.dataset.state) statuses.current.set(key, node.dataset.state);
        seen.current.add(key);
      }
    }
    scheduleRef.current();
  }, [events, cursor, ready, working, scrollRef]);
}
