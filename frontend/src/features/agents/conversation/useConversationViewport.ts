import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { readAgentStorage, writeAgentStorage } from "../sessions/agentStorage";

type ReadingState = {
  follow: boolean;
  top: number;
  anchor?: string;
  offset?: number;
  expanded: Record<string, boolean>;
};
const initial: ReadingState = { follow: true, top: 0, expanded: {} };

export function useConversationViewport({
  scrollRef,
  storageKey,
  ready,
  revision,
  onRead,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  storageKey: string;
  ready: boolean;
  revision: number;
  onRead?: () => void;
}) {
  const saved = useRef(readAgentStorage<ReadingState>(storageKey, initial));
  const state = useRef<ReadingState>({
    ...initial,
    ...saved.current,
    expanded: saved.current.expanded ?? {},
  });
  const [following, setFollowing] = useState(state.current.follow),
    [hasNew, setHasNew] = useState(false);
  const initialized = useRef(false),
    adjusting = useRef(false),
    readRef = useRef(onRead),
    scheduleRef = useRef(() => {});
  const lastRevision = useRef<number | undefined>(undefined);
  const nodes = useRef<HTMLElement[]>([]);
  readRef.current = onRead;
  const setFollow = useCallback((value: boolean) => {
    state.current.follow = value;
    setFollowing(value);
    if (value) setHasNew(false);
  }, []);
  const capture = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    state.current.top = scroll.scrollTop;
    const top = scroll.getBoundingClientRect().top;
    let low = 0,
      high = nodes.current.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (nodes.current[mid].getBoundingClientRect().top <= top + 24)
        low = mid + 1;
      else high = mid - 1;
    }
    const anchor = nodes.current[Math.max(0, high)];
    if (anchor) {
      state.current.anchor = anchor.dataset.messageKey;
      state.current.offset = anchor.getBoundingClientRect().top - top;
    }
  }, [scrollRef]);
  const pause = useCallback(() => {
    setFollow(false);
    capture();
  }, [setFollow, capture]);
  const latest = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    setFollow(true);
    adjusting.current = true;
    scroll.scrollTop = scroll.scrollHeight;
    requestAnimationFrame(() => {
      adjusting.current = false;
      capture();
    });
    if (!document.hidden) readRef.current?.();
  }, [scrollRef, setFollow, capture]);
  const jump = useCallback(
    (key: string) => {
      const scroll = scrollRef.current,
        target = nodes.current.find((node) => node.dataset.messageKey === key);
      if (!scroll || !target) return;
      pause();
      adjusting.current = true;
      scroll.scrollTo?.({
        top:
          scroll.scrollTop +
          target.getBoundingClientRect().top -
          scroll.getBoundingClientRect().top -
          24,
        behavior: "auto",
      });
      target.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        adjusting.current = false;
        capture();
      });
    },
    [pause, scrollRef, capture],
  );

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !ready) return;
    let frame = 0,
      saveTimer: ReturnType<typeof setTimeout> | undefined,
      readTimer: ReturnType<typeof setTimeout> | undefined;
    const persist = () => {
      capture();
      writeAgentStorage(storageKey, state.current);
    };
    const refreshNodes = () => {
      nodes.current = [
        ...scroll.querySelectorAll<HTMLElement>("[data-message-key]"),
      ];
    };
    const restored = new WeakSet<HTMLDetailsElement>();
    const restoreDetails = (root: HTMLElement) => {
      const details = [
        ...(root.matches("details[data-view-key]")
          ? [root as HTMLDetailsElement]
          : []),
        ...root.querySelectorAll<HTMLDetailsElement>("details[data-view-key]"),
      ];
      for (const node of details) {
        if (restored.has(node)) continue;
        restored.add(node);
        const open = state.current.expanded[node.dataset.viewKey!];
        if (
          open !== undefined &&
          !node.querySelector(".agent-approval.is-pending")
        )
          node.open = open;
      }
    };
    const move = () => {
      frame = 0;
      if (!initialized.current) return;
      if (state.current.follow) {
        adjusting.current = true;
        scroll.scrollTop = scroll.scrollHeight;
        requestAnimationFrame(() => {
          adjusting.current = false;
        });
      } else {
        const anchor = scroll.clientHeight
          ? nodes.current.find(
              (node) => node.dataset.messageKey === state.current.anchor,
            )
          : undefined;
        if (anchor) {
          const shift =
            anchor.getBoundingClientRect().top -
            scroll.getBoundingClientRect().top -
            (state.current.offset ?? 0);
          if (Math.abs(shift) > 1) {
            adjusting.current = true;
            scroll.scrollTop += shift;
            requestAnimationFrame(() => {
              adjusting.current = false;
            });
          }
        }
      }
      if (state.current.follow && !document.hidden && !readTimer)
        readTimer = setTimeout(() => {
          readTimer = undefined;
          readRef.current?.();
        }, 700);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(move);
    };
    scheduleRef.current = schedule;
    refreshNodes();
    if (!initialized.current) {
      initialized.current = true;
      adjusting.current = true;
      if (state.current.follow) scroll.scrollTop = scroll.scrollHeight;
      else {
        const anchor = scroll.clientHeight
          ? nodes.current.find(
              (node) => node.dataset.messageKey === state.current.anchor,
            )
          : undefined;
        scroll.scrollTop = anchor
          ? scroll.scrollTop +
            anchor.getBoundingClientRect().top -
            scroll.getBoundingClientRect().top -
            (state.current.offset ?? 0)
          : state.current.top;
      }
      restoreDetails(scroll);
      adjusting.current = false;
      capture();
    }
    let priorTop = scroll.scrollTop;
    const onScroll = () => {
      if (adjusting.current) {
        priorTop = scroll.scrollTop;
        return;
      }
      const gap = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
      if (scroll.scrollTop < priorTop - 1 || gap > 16) setFollow(false);
      else if (gap < 8 && scroll.scrollTop > priorTop) setFollow(true);
      priorTop = scroll.scrollTop;
      capture();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 180);
    };
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0) pause();
    };
    const toggle = (event: Event) => {
      const node = event.target as HTMLDetailsElement;
      if (node.dataset.viewKey) {
        state.current.expanded[node.dataset.viewKey] = node.open;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(persist, 180);
      }
      refreshNodes();
    };
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (
            node instanceof HTMLElement &&
            (node.matches("details[data-view-key]") ||
              node.querySelector("details[data-view-key]"))
          )
            restoreDetails(node);
      if (
        records.some((record) =>
          [...record.addedNodes, ...record.removedNodes].some(
            (node) =>
              node instanceof HTMLElement &&
              (node.matches("[data-message-key]") ||
                node.querySelector("[data-message-key]")),
          ),
        )
      )
        refreshNodes();
      schedule();
    });
    observer.observe(scroll, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    if (scroll.firstElementChild) resize?.observe(scroll.firstElementChild);
    resize?.observe(scroll);
    const visibility = () => {
      persist();
      if (!document.hidden) schedule();
    };
    scroll.addEventListener("scroll", onScroll, { passive: true });
    scroll.addEventListener("wheel", wheel, { passive: true });
    scroll.addEventListener("toggle", toggle, true);
    window.addEventListener("pagehide", persist);
    document.addEventListener("visibilitychange", visibility);
    schedule();
    return () => {
      persist();
      observer.disconnect();
      resize?.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(saveTimer);
      clearTimeout(readTimer);
      scroll.removeEventListener("scroll", onScroll);
      scroll.removeEventListener("wheel", wheel);
      scroll.removeEventListener("toggle", toggle, true);
      window.removeEventListener("pagehide", persist);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [ready, storageKey, scrollRef, capture, pause, setFollow]);
  useLayoutEffect(() => {
    if (!ready) return;
    if (
      initialized.current &&
      lastRevision.current !== undefined &&
      revision > lastRevision.current &&
      !state.current.follow
    )
      setHasNew(true);
    lastRevision.current = revision;
    scheduleRef.current();
  }, [revision, ready]);
  return { following, hasNew, latest, pause, jump };
}
