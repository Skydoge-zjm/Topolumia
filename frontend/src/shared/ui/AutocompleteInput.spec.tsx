import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AutocompleteInput } from "./AutocompleteInput";

afterEach(cleanup);
const options = [
  { value: "gpt-6-luna", label: "6 Luna" },
  { value: "gpt-6.1-sol", label: "6.1 Sol" },
];

it("selects filtered suggestions with the keyboard, preserves input focus and keeps custom values form-compatible", async () => {
  const submitted = vi.fn(),
    escaped = vi.fn(),
    user = userEvent.setup();
  function Form() {
    const [value, setValue] = useState("");
    return (
      <form
        onKeyDown={(event) => {
          if (event.key === "Escape") escaped();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          submitted(new FormData(event.currentTarget).get("model"));
        }}
      >
        <AutocompleteInput
          value={value}
          onChange={setValue}
          options={options}
          name="model"
          required
          maxLength={160}
          ariaLabel="Model"
          suggestionsLabel="Show model suggestions"
        />
        <button type="submit">Save</button>
      </form>
    );
  }
  render(<Form />);
  const input = screen.getByRole("combobox", { name: "Model" });
  await user.type(input, "Sol");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await user.keyboard("{ArrowDown}{Enter}");
  expect(input).toHaveValue("gpt-6.1-sol");
  expect(input).toHaveFocus();
  expect(submitted).not.toHaveBeenCalled();
  await user.keyboard("{ArrowDown}{Escape}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(escaped).not.toHaveBeenCalled();
  await user.clear(input);
  await user.type(input, "my-custom-model");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(submitted).toHaveBeenCalledWith("my-custom-model");
});

it("lets pointer selection keep the input active and respects disabled fields", async () => {
  const changed = vi.fn(),
    user = userEvent.setup();
  const view = render(
    <AutocompleteInput
      value="gpt-6-luna"
      onChange={changed}
      options={options}
      ariaLabel="Model"
      suggestionsLabel="Show model suggestions"
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Show model suggestions" }),
  );
  await user.click(screen.getByRole("option", { name: /6.1 Sol/ }));
  expect(changed).toHaveBeenCalledWith("gpt-6.1-sol");
  expect(screen.getByRole("combobox")).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  view.rerender(
    <AutocompleteInput
      value="gpt-6-luna"
      onChange={changed}
      options={options}
      disabled
      ariaLabel="Model"
      suggestionsLabel="Show model suggestions"
    />,
  );
  expect(screen.getByRole("combobox")).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Show model suggestions" }),
  ).toBeDisabled();
});
