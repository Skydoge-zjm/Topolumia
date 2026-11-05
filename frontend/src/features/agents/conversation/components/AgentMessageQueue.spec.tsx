import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentMessageQueue } from "./AgentMessageQueue";

const originalAnimate = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "animate",
);
afterEach(() => {
  cleanup();
  if (originalAnimate)
    Object.defineProperty(Element.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(Element.prototype, "animate");
});

it("fades a removed middle row in place and only animates genuinely new queued messages", async () => {
  const animations: Array<{ finish: () => void }> = [];
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: vi.fn(() => {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      animations.push({ finish });
      return { finished, cancel: vi.fn() };
    }),
  });
  const messages = ["q1", "q2", "q3"].map((id) => ({
    id,
    text: id,
    createdAt: "",
  }));
  const props = {
    paused: false,
    disabled: false,
    busy: true,
    en: false,
    onRemove: vi.fn(),
    onResume: vi.fn(),
  };
  const { container, rerender } = render(
    <AgentMessageQueue {...props} messages={messages} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "展开队列" }));
  expect(animations).toHaveLength(0);
  rerender(
    <AgentMessageQueue {...props} messages={[messages[0], messages[2]]} />,
  );
  const ids = () =>
    [...container.querySelectorAll("[data-queue-id]")].map((node) =>
      node.getAttribute("data-queue-id"),
    );
  expect(ids()).toEqual(["q1", "q2", "q3"]);
  expect(container.querySelector("[data-queue-id='q2']")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await act(async () => animations[0].finish());
  expect(ids()).toEqual(["q1", "q3"]);
  rerender(
    <AgentMessageQueue
      {...props}
      messages={[
        messages[0],
        messages[2],
        { id: "q4", text: "New", createdAt: "" },
      ]}
    />,
  );
  expect(animations).toHaveLength(2);
  await act(async () => animations[1].finish());
});

it("edits only an unstarted queued message and renders same-ID text revisions", async () => {
  const onEdit = vi.fn().mockResolvedValue(undefined);
  const props = {
    paused: false,
    disabled: false,
    busy: true,
    en: false,
    onRemove: vi.fn(),
    onResume: vi.fn(),
    onEdit,
  };
  const { rerender } = render(
    <AgentMessageQueue
      {...props}
      messages={[
        { id: "q1", text: "Original", model: "gpt-6-luna", createdAt: "" },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "编辑待发送消息 1" }));
  fireEvent.change(screen.getByRole("textbox", { name: "编辑待发送消息" }), {
    target: { value: "Revised" },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "保存" })),
  );
  expect(onEdit).toHaveBeenCalledWith("q1", "Revised");
  rerender(
    <AgentMessageQueue
      {...props}
      messages={[
        { id: "q1", text: "Revised", model: "gpt-6-luna", createdAt: "" },
      ]}
    />,
  );
  expect(screen.getByText("Revised")).toBeVisible();
  expect(screen.getByText("gpt-6-luna")).toBeVisible();
});
