import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InlineField, TagEditor } from "./InlineField";

afterEach(cleanup);

it.each([{ isComposing: true }, { keyCode: 229 }])("keeps a title draft while the IME confirms or cancels a candidate (%j)", async composition => {
  const save = vi.fn(async () => {});
  render(<InlineField value="原名称" label="Node name" en canEdit onSave={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Node name：原名称" }));
  const input = screen.getByRole("textbox", { name: "Node name" });
  fireEvent.change(input, { target: { value: "新的研究标题" } });
  expect(fireEvent.keyDown(input, { key: "Enter", ...composition })).toBe(true);
  expect(fireEvent.keyDown(input, { key: "Escape", ...composition })).toBe(true);
  expect(save).not.toHaveBeenCalled();
  expect(input).toHaveValue("新的研究标题");
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith("新的研究标题"));
});

it.each([{ isComposing: true }, { keyCode: 229 }])("keeps a tag draft during IME punctuation and confirmation (%j)", async composition => {
  const save = vi.fn(async () => {});
  render(<TagEditor tags={["已有标签"]} en canEdit onSave={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Tag" }));
  const input = screen.getByRole("textbox", { name: "New tag" });
  fireEvent.change(input, { target: { value: "研究进展" } });
  for (const key of ["Enter", "，", "Escape"]) expect(fireEvent.keyDown(input, { key, ...composition })).toBe(true);
  expect(save).not.toHaveBeenCalled();
  expect(input).toHaveValue("研究进展");
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith(["已有标签", "研究进展"]));
});
