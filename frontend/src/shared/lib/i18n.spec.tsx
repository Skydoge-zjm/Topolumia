import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useLocalizedDom } from "./i18n";

afterEach(cleanup);

function Fixture({ locale }: { locale: "zh" | "en" }) {
  useLocalizedDom(locale);
  return (
    <div id="root">
      <h1>研究总览</h1>
      <p translate="no" title="Sync">
        Sync · Reasoning summary · 研究总览
      </p>
    </div>
  );
}

it("translates interface labels while preserving native transcript text and attributes in both locales", () => {
  const view = render(<Fixture locale="en" />);
  expect(screen.getByRole("heading")).toHaveTextContent("Research overview");
  expect(
    screen.getByText("Sync · Reasoning summary · 研究总览"),
  ).toHaveAttribute("title", "Sync");
  view.rerender(<Fixture locale="zh" />);
  expect(screen.getByRole("heading")).toHaveTextContent("研究总览");
  expect(
    screen.getByText("Sync · Reasoning summary · 研究总览"),
  ).toHaveAttribute("title", "Sync");
});
