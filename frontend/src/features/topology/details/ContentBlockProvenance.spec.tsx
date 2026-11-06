import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ContentBlockProvenance } from "./ContentBlockProvenance";
import { PaperCitation } from "./PaperBibliography";

afterEach(cleanup);

const identifiers = [
  ["doi", "10.1000/example", "https://doi.org/10.1000/example"],
  ["doi", "https://doi.org/10.1000/example", "https://doi.org/10.1000/example"],
  ["arxiv", "2502.14321v3", "https://arxiv.org/abs/2502.14321v3"],
  ["arxiv", "https://arxiv.org/abs/2502.14321v3", "https://arxiv.org/abs/2502.14321v3"],
] as const;

it.each(identifiers)("resolves %s source %s consistently with the paper citation", (kind, value, href) => {
  render(<>
    <ContentBlockProvenance sourceRefs={[{ kind, value, label: "Original source" }]} en />
    <PaperCitation core={{ identifiers: { [kind]: value } }} en />
  </>);

  expect(screen.getByRole("link", { name: "Original source" })).toHaveAttribute("href", href);
  expect(screen.getByRole("link", { name: kind === "doi" ? "DOI" : "arXiv" })).toHaveAttribute("href", href);
});
