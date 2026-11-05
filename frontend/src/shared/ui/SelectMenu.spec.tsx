import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SelectMenu } from "./SelectMenu";

afterEach(cleanup);
it("Agent model selectors support keyboard selection and Escape focus recovery", async () => {
  const change = vi.fn();
  const user = userEvent.setup();
  render(
    <SelectMenu
      ariaLabel="Agent model"
      options={[
        { value: "a", label: "Model A" },
        { value: "b", label: "Model B" },
      ]}
      onChange={change}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Agent model" });
  trigger.focus();
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(change).toHaveBeenCalledWith("b");
  expect(trigger).toHaveTextContent("Model B");
  expect(trigger).toHaveFocus();
  await user.keyboard("{ArrowDown}{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(trigger).toHaveFocus();
});
