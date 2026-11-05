export const AGENT_MOTION = {
  press: 80,
  icon: 110,
  message: 150,
  content: 120,
  queueExit: 100,
  drawerEnter: 220,
  drawerExit: 180,
  presenceDelay: 180,
  locate: 900,
};
export const AGENT_EASING = {
  enter: "cubic-bezier(0, 0, .38, .9)",
  standard: "cubic-bezier(.2, 0, .38, .9)",
  exit: "cubic-bezier(.2, 0, 1, .9)",
};
const channels = new WeakMap<Element, Map<string, Animation>>();

export function reducedAgentMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function animateAgentElement(
  element: Element,
  frames: Keyframe[],
  duration: number,
  channel = "presence",
  easing = AGENT_EASING.enter,
): Animation | null {
  const running = channels.get(element) ?? new Map<string, Animation>();
  const previous = running.get(channel);
  const current = previous ? getComputedStyle(element) : null;
  const first = { ...frames[0] };
  if (current && first.opacity !== undefined) first.opacity = current.opacity;
  if (current && first.transform !== undefined)
    first.transform = current.transform;
  previous?.cancel();
  if (typeof element.animate !== "function") return null;
  const media =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  const reduced = Boolean(media?.matches);
  // Reduced motion retains only a short opacity change, with no displacement.
  const keyframes = reduced
    ? frames.map((frame) => ({ opacity: frame.opacity ?? 1 }))
    : [first, ...frames.slice(1)];
  const animation = element.animate(keyframes, {
    duration: reduced ? Math.min(80, duration) : duration,
    easing,
  });
  running.set(channel, animation);
  channels.set(element, running);
  const onPreference = () => {
    if (media?.matches) animation.cancel();
  };
  media?.addEventListener?.("change", onPreference);
  const cleanup = () => {
    if (running.get(channel) === animation) running.delete(channel);
    media?.removeEventListener?.("change", onPreference);
  };
  animation.finished.then(cleanup, cleanup);
  return animation;
}

export function cancelAgentAnimations(element: Element | null) {
  if (!element) return;
  for (const animation of channels.get(element)?.values() ?? [])
    animation.cancel();
  channels.delete(element);
}

export function enterAgentElement(
  element: Element,
  distance = 4,
  duration = AGENT_MOTION.message,
) {
  return animateAgentElement(
    element,
    [
      { opacity: 0, transform: `translateY(${distance}px)` },
      { opacity: 1, transform: "translateY(0)" },
    ],
    duration,
  );
}
