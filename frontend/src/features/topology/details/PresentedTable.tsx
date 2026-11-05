import type { CSSProperties } from "react";
import type { TableCellStyle, TableGrid } from "@domain/research/table-presentation";

export type TablePreview = {
  schemaVersion?: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string | number | boolean | null>>;
  sourceFormat: string;
  sheetName?: string;
  truncated: boolean;
  totalRows: number;
  grid?: TableGrid;
};
const borderCss = (border: NonNullable<TableCellStyle["borders"]>["top"]) => {
  if (!border) return undefined;
  const width = border.style === "double" ? 3 : border.style === "medium" ? 2 : border.style === "thick" ? 3 : 1;
  return width + "px " + (["thin", "medium", "thick"].includes(border.style) ? "solid" : border.style) + " " + (border.color ?? "#000000");
};
function cellCss(style: TableCellStyle = {}): CSSProperties {
  return {
    fontWeight: style.bold === undefined ? undefined : style.bold ? 700 : 400,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration: style.underline ? "underline" : undefined,
    fontSize: style.fontSize ? style.fontSize + "pt" : undefined,
    color: style.color,
    backgroundColor: style.background,
    textAlign: style.horizontal,
    verticalAlign: style.vertical,
    whiteSpace: style.wrap ? "pre-wrap" : "pre",
    borderTop: borderCss(style.borders?.top),
    borderBottom: borderCss(style.borders?.bottom),
    borderLeft: borderCss(style.borders?.left),
    borderRight: borderCss(style.borders?.right),
  };
}
const columnName = (index: number) => {
  let value = index + 1, name = "";
  while (value > 0) { const remainder = (value - 1) % 26; name = String.fromCharCode(65 + remainder) + name; value = Math.floor((value - 1) / 26); }
  return name;
};
export function PresentedTable({ preview }: { preview: TablePreview }) {
  if (!preview.grid) return <div className="research-table-wrap"><table className="research-table"><thead><tr>{preview.columns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{preview.rows.map((row, index) => <tr key={index}>{preview.columns.map(column => <td key={column.key}>{String(row[column.key] ?? "—")}</td>)}</tr>)}</tbody></table></div>;
  const grid = preview.grid;
  return <div className="research-table-wrap"><table className="research-table research-styled-table">
    {grid.columnWidths && <colgroup>{grid.columnWidths.map((width, index) => <col key={index} style={{ width }} />)}</colgroup>}
    <tbody>{grid.cells.map((row, rowIndex) => <tr key={rowIndex} style={{ height: grid.rowHeights?.[rowIndex] }}>
      {row.map((cell, columnIndex) => cell.covered ? null : <td
        key={columnIndex}
        data-cell={columnName(columnIndex) + (rowIndex + 1)}
        rowSpan={cell.rowSpan ?? 1}
        colSpan={cell.colSpan ?? 1}
        style={cellCss(cell.style)}
      >{cell.runs?.length ? cell.runs.map((run, index) => <span key={index} style={cellCss(run)}>{run.text}</span>) : cell.text ?? String(cell.value ?? "")}</td>)}
    </tr>)}</tbody>
  </table></div>;
}
