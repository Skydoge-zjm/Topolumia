import { afterEach, expect, it, vi } from "vitest";
import { animateAgentElement } from "./agentMotion";

afterEach(() => vi.unstubAllGlobals());

function fixture(reduce = false) {
  const listeners = new Set<() => void>();
  const media = {
    matches: reduce,
    addEventListener: (_name: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_name: string, listener: () => void) =>
      listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => media);
  const element = document.createElement("div");
  const records: Array<{
    cancel: ReturnType<typeof vi.fn>;
    finish: () => void;
    finished: Promise<void>;
  }> = [];
  const animate = vi.fn(
    (frames: Keyframe[], options: KeyframeAnimationOptions) => {
      void frames;
      void options;
      let finish!: () => void, fail!: () => void;
      const finished = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = () => reject(new Error("cancelled"));
      });
      const record = { finished, finish, cancel: vi.fn(fail) };
      records.push(record);
      return record as unknown as Animation;
    },
  );
  Object.defineProperty(element, "animate", { value: animate });
  return { element, animate, records, media, listeners };
}

it("interrupts the previous channel and continues from its current visible state", async () => {
  const f = fixture();
  const first = animateAgentElement(
    f.element,
    [{ opacity: 0 }, { opacity: 1 }],
    220,
  );
  f.element.style.opacity = "0.45";
  animateAgentElement(f.element, [{ opacity: 1 }, { opacity: 0 }], 180);
  expect(first?.cancel).toHaveBeenCalledOnce();
  expect(f.animate.mock.calls[1][0]).toEqual([
    { opacity: "0.45" },
    { opacity: 0 },
  ]);
  f.records[1].finish();
  await Promise.resolve();
  expect(f.listeners.size).toBe(0);
});

it("uses at most an 80ms opacity transition with no movement when reduced motion is enabled", () => {
  const f = fixture(true);
  animateAgentElement(
    f.element,
    [
      { opacity: 0, transform: "translateX(16px)" },
      { opacity: 1, transform: "translateX(0)" },
    ],
    220,
  );
  expect(f.animate.mock.calls[0][0]).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  expect(f.animate.mock.calls[0][1]).toMatchObject({ duration: 80 });
  f.records[0].finish();
});

it("cancels an in-flight animation if the system preference switches to reduced motion", async () => {
  const f = fixture();
  animateAgentElement(f.element, [{ opacity: 0 }, { opacity: 1 }], 220);
  f.media.matches = true;
  for (const listener of f.listeners) listener();
  expect(f.records[0].cancel).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(f.listeners.size).toBe(0);
});
