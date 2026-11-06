import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PaperBibliography } from "./PaperBibliography";

afterEach(cleanup);

const authors = Array.from({ length: 8 }, (_, index) => `Author ${index + 1}`);

it("shows every author after expanding the bibliography", async () => {
  const core = { nodeName: "Example paper", authors, abstract: "Research abstract." };
  render(<PaperBibliography core={core} en initialExpanded={false} />);

  fireEvent.click(screen.getByText("Bibliographic information"));

  await waitFor(() => {
    for (const author of authors) expect(screen.getByText(author, { exact: false })).toBeVisible();
  });
});

it("keeps the full author list accessible without other bibliographic fields", () => {
  render(<PaperBibliography core={{ nodeName: "Example paper", authors }} en={false} initialExpanded />);

  for (const author of authors) expect(screen.getByText(author, { exact: false })).toBeVisible();
});
