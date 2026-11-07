import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NodeCoreEditor } from "./NodeCoreEditor";

afterEach(cleanup);
it("starts a note with its body and free tags without a second content-type selection", async () => {
  const save = vi.fn(async () => {});
  render(
    <NodeCoreEditor
      kind="note"
      initial={{ nodeName: "" }}
      en
      composeBody
      onSave={save}
      onCancel={() => {}}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Node name" }), {
    target: { value: "Why did the run fail?" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Note body" }), {
    target: {
      value:
        "## Observation\nThe original log records an out-of-memory failure.",
    },
  });
  fireEvent.change(screen.getByRole("textbox", { name: /Tags/ }), {
    target: { value: "my-topic，观察" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save note" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeName: "Why did the run fail?",
        tags: ["my-topic", "观察"],
      }),
      "## Observation\nThe original log records an out-of-memory failure.",
    ),
  );
  expect(screen.queryByLabelText("Content type")).toBeNull();
});

it("keeps note text available after a rejected save", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("The object changed"))
    .mockResolvedValue(undefined);
  render(
    <NodeCoreEditor
      kind="note"
      initial={{ nodeName: "Analysis" }}
      en
      composeBody
      onSave={save}
      onCancel={() => {}}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Note body" }), {
    target: { value: "A draft worth preserving" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save note" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("The object changed"),
  );
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue(
    "A draft worth preserving",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save note" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1][1]).toBe("A draft worth preserving");
});
