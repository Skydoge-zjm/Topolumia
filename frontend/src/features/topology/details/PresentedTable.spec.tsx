import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PresentedTable } from "./PresentedTable";

afterEach(cleanup);
it("renders a merged grid without duplicate covered cells and applies cell and rich-text styles", () => {
  render(<PresentedTable preview={{
    columns: [], rows: [], sourceFormat: "xlsx", truncated: false, totalRows: 2,
    grid: {
      columnWidths: [120, 160],
      rowHeights: [40, 32, 32],
      cells: [
        [{ value: "Results", colSpan: 2, style: { bold: true, color: "#FFFFFF", background: "#155E63", horizontal: "center", wrap: true } }, { value: "", covered: true }],
        [{ value: "Group", rowSpan: 2, style: { vertical: "middle" } }, { value: 5.2, text: "5.20", style: { bold: true, background: "#DCFCE7", horizontal: "right", borders: { top: { style: "double", color: "#166534" } } } }],
        [{ value: "", covered: true }, { value: "SR3", runs: [{ text: "SR", bold: true }, { text: "3", color: "#DC2626" }] }],
      ],
    },
  }} />);
  expect(screen.getByRole("cell", { name: "Results" })).toHaveAttribute("colspan", "2");
  expect(screen.getByRole("cell", { name: "Results" })).toHaveStyle({ fontWeight: 700, backgroundColor: "#155E63", color: "#FFFFFF", textAlign: "center" });
  expect(screen.getByRole("cell", { name: "Group" })).toHaveAttribute("rowspan", "2");
  expect(screen.getByRole("cell", { name: "5.20" })).toHaveStyle({ backgroundColor: "#DCFCE7", textAlign: "right" });
  expect(screen.getAllByRole("cell")).toHaveLength(4);
  expect(screen.getByText("SR")).toHaveStyle({ fontWeight: 700 });
  expect(screen.getByText("3")).toHaveStyle({ color: "#DC2626" });
});
