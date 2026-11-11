import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
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
const ROWS_PER_PAGE = 100;
type Cell = string | number | boolean | null;
const asNumber = (value: Cell) => typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const blank = (value: Cell | undefined) => value === null || value === undefined || value === "";

export function PresentedTable({ preview, en = false }: { preview: TablePreview; en?: boolean }) {
  const [page, setPage] = useState(0), [sort, setSort] = useState<{ key: string; descending: boolean } | null>(null);
  // A column of figures is set as figures: right-aligned, tabular, sorted by value.
  const numeric = useMemo(() => new Set(preview.columns.filter(column => {
    let seen = false;
    for (const row of preview.rows) { const value = row[column.key]; if (blank(value)) continue; if (asNumber(value) === null) return false; seen = true; }
    return seen;
  }).map(column => column.key)), [preview.columns, preview.rows]);
  const rows = useMemo(() => {
    if (!sort) return preview.rows;
    const direction = sort.descending ? -1 : 1, byNumber = numeric.has(sort.key);
    return [...preview.rows].sort((a, b) => {
      const left = a[sort.key], right = b[sort.key];
      // Empty cells stay at the end in either direction.
      if (blank(left) || blank(right)) return blank(left) === blank(right) ? 0 : blank(left) ? 1 : -1;
      return direction * (byNumber ? asNumber(left)! - asNumber(right)! : String(left).localeCompare(String(right), undefined, { numeric: true }));
    });
  }, [preview.rows, sort, numeric]);
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / ROWS_PER_PAGE) - 1)), offset = current * ROWS_PER_PAGE;
  if (!preview.grid) return <div><div className="research-table-wrap"><table className="research-table is-data"><thead><tr>{preview.columns.map(column => {
    const active = sort?.key === column.key;
    return <th key={column.key} className={numeric.has(column.key) ? "is-numeric" : undefined} aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}>
      <button type="button" className="research-table-sort" title={en ? "Sort by this column" : "按此列排序"} onClick={() => { setPage(0); setSort(active ? (sort.descending ? null : { key: column.key, descending: true }) : { key: column.key, descending: false }); }}>
        <span>{column.label}</span>{active && (sort.descending ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />)}
      </button>
    </th>;
  })}</tr></thead><tbody>{rows.slice(offset, offset + ROWS_PER_PAGE).map((row, index) => <tr key={offset + index}>{preview.columns.map(column => <td key={column.key} className={numeric.has(column.key) ? "is-numeric" : undefined}>{String(row[column.key] ?? "—")}</td>)}</tr>)}</tbody></table></div>{rows.length > ROWS_PER_PAGE && <nav className="research-pagination" aria-label={en ? "Table rows" : "表格行分页"}><button className="button" disabled={!current} onClick={() => setPage(current - 1)}>{en ? "Previous rows" : "上一页表格"}</button><span>{offset + 1}–{Math.min(offset + ROWS_PER_PAGE, rows.length)} / {rows.length}</span><button className="button" disabled={offset + ROWS_PER_PAGE >= rows.length} onClick={() => setPage(current + 1)}>{en ? "Next rows" : "下一页表格"}</button></nav>}</div>;
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
