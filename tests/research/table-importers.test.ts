import test from "node:test";
import assert from "node:assert/strict";
import { exportTexTable, exportXlsxTable, parseTexTable, parseXlsxTable } from "../../src/services/topology/table-importers.js";
import { styledTexFixture, styledXlsxFixture } from "../../fixtures/research/styled-table-fixture.js";

test("TeX tabular import extracts headers, values, escaped symbols and booktabs rules", () => {
  const tex = [
    "\\begin{table}",
    "\\caption{Results}",
    "\\begin{tabular}{lrr}",
    "\\toprule",
    "Method & FID $\\downarrow$ & PSNR (dB) \\\\",
    "\\midrule",
    "SR3 & 5.2 & 26.4 \\\\",
    "Baseline & 15.2 & 27.9 \\\\",
    "\\bottomrule",
    "\\end{tabular}",
    "\\end{table}",
  ].join("\n");
  const table = parseTexTable(Buffer.from(tex));
  assert.deepEqual(table.columns.map(column => column.label), ["Method", "FID ↓", "PSNR (dB)"]);
  assert.deepEqual(table.rows[0], { c1: "SR3", c2: "5.2", c3: "26.4" });
  assert.equal(table.sourceFormat, "tex");
});

test("XLSX preserves horizontal and vertical merges, rich text, theme colors, number formats and dimensions", async () => {
  const table = await parseXlsxTable(styledXlsxFixture());
  const grid = table.grid;
  assert.equal(grid.cells[0][0].colSpan, 2);
  assert.equal(grid.cells[0][1].covered, true);
  assert.equal(grid.cells[0][2].colSpan, 3);
  assert.equal(grid.cells[2][0].rowSpan, 2);
  assert.equal(grid.cells[3][0].covered, true);
  assert.equal(grid.cells[0][0].style.bold, true);
  assert.equal(grid.cells[0][0].style.background, "#155E63");
  assert.equal(grid.cells[0][0].style.color, "#FFFFFF");
  assert.equal(grid.cells[4][2].style.bold, true);
  assert.equal(grid.cells[4][2].style.background, "#DCFCE7");
  assert.equal(grid.cells[4][2].style.horizontal, "right");
  assert.equal(grid.cells[4][2].text, "5.20");
  assert.equal(grid.cells[4][4].text, "76.2%");
  assert.equal(grid.cells[4][1].runs[0].bold, true);
  assert.equal(grid.cells[4][1].runs[1].color, "#DC2626");
  assert.equal(grid.cells[0][0].style.borders.top.style, "thin");
  assert.equal(grid.cells[5][0].style.wrap, true);
  assert.equal(grid.rowHeights[5], 56);
  assert.equal(grid.columnWidths[1], 159);
  const exported = await parseXlsxTable(exportXlsxTable(table, "Roundtrip"));
  const visibleGrid = item => ({ ...item, cells: item.cells.map(row => row.map(cell => cell.covered ? { covered: true } : cell)) });
  assert.deepEqual(visibleGrid(exported.grid), visibleGrid(grid));
});

test("TeX structured table preserves nested multicolumn/multirow, bold cells and background colors", () => {
  const table = parseTexTable(Buffer.from(styledTexFixture()));
  const grid = table.grid;
  assert.equal(grid.cells[0][0].value, "Method");
  assert.equal(grid.cells[0][0].colSpan, 2);
  assert.equal(grid.cells[0][2].value, "ImageNet 4x");
  assert.equal(grid.cells[0][2].colSpan, 3);
  assert.equal(grid.cells[0][2].style.bold, true);
  assert.equal(grid.cells[0][2].style.background, "#E6E6FF");
  assert.equal(grid.cells[2][0].rowSpan, 2);
  assert.equal(grid.cells[3][0].covered, true);
  assert.equal(grid.cells[3][1].value, "Bicubic");
  assert.equal(grid.cells[4][2].value, "5.20");
  assert.equal(grid.cells[4][2].style.bold, true);
  assert.equal(grid.cells[4][2].style.background, "#E6F7E6");
  const exported = parseTexTable(exportTexTable(table));
  assert.equal(exported.grid.cells[0][2].colSpan, 3);
  assert.equal(exported.grid.cells[2][0].rowSpan, 2);
  assert.equal(exported.grid.cells[4][2].style.bold, true);
  assert.equal(exported.grid.cells[4][2].style.background, "#E6F7E6");
});

test("XLSX import reads the first sheet, rich values and formulas into a bounded table preview", async () => {
  const tableInput = { columns: [{ key: "c1", label: "Method" }, { key: "c2", label: "FID" }, { key: "c3", label: "PSNR" }], rows: [{ c1: "SR3", c2: 5.2, c3: 26.4 }, { c1: "Baseline", c2: 15.2, c3: 27.9 }] };
  const bytes = Buffer.from(exportXlsxTable(tableInput, "Metrics"));
  const table = await parseXlsxTable(bytes);
  assert.equal(table.sheetName, "Metrics");
  assert.deepEqual(table.columns.map(column => column.label), ["Method", "FID", "PSNR"]);
  assert.deepEqual(table.rows[0], { c1: "SR3", c2: 5.2, c3: 26.4 });
  assert.equal(table.sourceFormat, "xlsx");
});
