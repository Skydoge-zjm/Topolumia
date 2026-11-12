import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { AppError } from "../../lib/errors.js";
import { applyMergedRanges, formatXlsxValue, parseCellReference, readXlsxStyles } from "./xlsx-presentation.js";
import { exportTexPresentation, parseTexPresentation } from "./tex-presentation.js";
import { exportStyledXlsx } from "./xlsx-export.js";
import type { IndexedTable } from "../../domain/research/types.js";
import type { TableGrid } from "../../domain/research/table-presentation.js";
import { workbookDocumentSchema, relationshipsDocumentSchema, sharedStringsDocumentSchema, worksheetDocumentSchema, type XmlCell, type XmlRichString } from "./xlsx-xml.js";
type CellValue = TableGrid["cells"][number][number]["value"];
type TableCell = TableGrid["cells"][number][number];
export type TableRange = { offset?:number;limit?:number;columnKeys?:string[] };
export type TableImportOptions = { sheetName?:string;range?:TableRange|null };

const MAX_PREVIEW_ROWS = 300;
const MAX_PREVIEW_COLUMNS = 60;
const MAX_PREVIEW_CELLS = 12_000;
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, trimValues: false });
const list = <T>(value: T | T[] | undefined | null): T[] => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
const xmlEscape = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function makeTable(headers: CellValue[], rows: CellValue[][], sourceFormat: "xlsx" | "tex" | "csv", sheetName: string | undefined = undefined, range: TableRange | null = null): IndexedTable {
  const columns = headers.map((label, index) => ({ key: "c" + (index + 1), label: String(label || ("Column " + (index + 1))).trim() }));
  if (!columns.length) throw new AppError("TABLE_PARSE_EMPTY", "文件中没有可预览的表格列。", { status: 422 });
  if (range) {
    const offset = range.offset ?? 0, limit = range.limit ?? 20, availableRows = rows.length + 1;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= availableRows || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError("RANGE_INVALID", "Select 1–100 rows at a valid offset.", { status: 422 });
    const selected = range.columnKeys ? columns.filter(column => range.columnKeys!.includes(column.key)) : columns;
    if (range.columnKeys?.some(key => !selected.some(column => column.key === key))) throw new AppError("RANGE_INVALID", "Unknown column key.", { status: 422 });
    const count = Math.min(limit, availableRows - offset);
    if (selected.length > 60 || selected.length * count > 2000) throw new AppError("RANGE_INVALID", "Select at most 60 columns and 2000 cells.", { status: 422 });
    const indices = selected.map(column => columns.indexOf(column));
    const cells = Array.from({ length: count }, (_, index) => {
      const row = offset + index === 0 ? headers : rows[offset + index - 1];
      return indices.map(column => ({ value: row[column] ?? null }));
    });
    return { schemaVersion: "research-table-preview.v1", columns: selected, rows: [], grid: { cells }, sourceFormat, rangeOffset: offset, availableRows, totalRows: rows.length, truncated: false };
  }
  const boundedRows = rows.slice(0, MAX_PREVIEW_ROWS).map((row) => Object.fromEntries(columns.map((column, index) => [column.key, row[index] ?? ""])));
  return { schemaVersion: "research-table-preview.v1", columns, rows: boundedRows, sourceFormat, ...(sheetName ? { sheetName } : {}), truncated: rows.length > MAX_PREVIEW_ROWS, totalRows: rows.length };
}

function parseTexCell(cell: unknown) {
  return String(cell ?? "")
    .replace(/\\multicolumn\s*\{[^{}]*\}\s*\{[^{}]*\}\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\multirow\s*\{[^{}]*\}\s*\{[^{}]*\}\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:textbf|textit|emph|underline|mathrm|mathbf|operatorname)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:centering|small|scriptsize|footnotesize|normalsize|large|Large|toprule|midrule|bottomrule|hline|addlinespace|tabularnewline)\b/g, "")
    .replace(/\\cline\s*\{[^}]*\}/g, "")
    .replace(/\\(?:begin|end)\s*\{[^{}]+\}/g, "")
    .replace(/\\(?:label|caption)\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}/g, "")
    .replace(/\\([%_&#])/g, "$1")
    .replace(/\\\{/g, "{").replace(/\\\}/g, "}")
    .replace(/\\times\b/g, "×").replace(/\\pm\b/g, "±").replace(/\\downarrow\b/g, "↓").replace(/\\uparrow\b/g, "↑")
    .replace(/\\,/g, " ").replace(/\$+/g, "").replace(/\\[a-zA-Z]+\*?/g, "").replace(/[{}]/g, "").trim();
}

export function parseTexTable(buffer: Uint8Array) {
  const source = Buffer.from(buffer).toString("utf8").replace(/\r\n?/g, "\n");
  let grid;
  try { grid = parseTexPresentation(source, parseTexCell); }
  catch (error) { throw new AppError("TEX_TABLE_INVALID", error instanceof Error ? error.message : String(error), { status: 422 }); }
  if (!grid.cells.length || !grid.cells[0]?.length) throw new AppError("TEX_TABLE_EMPTY", "TeX 表格没有数据行。", { status: 422 });
  const rows = grid.cells.map(row => row.map(cell => cell.covered ? "" : cell.value));
  return { ...makeTable(rows[0], rows.slice(1), "tex"), grid };
}

const cellColumnIndex = (reference: unknown) => {
  const letters = String(reference ?? "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  let index = 0;
  for (const char of letters) index = index * 26 + char.charCodeAt(0) - 64;
  return index - 1;
};
const xmlText = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : value && typeof value === "object" ? String("#text" in value ? value["#text"] ?? "" : "") : "";
const richString = (value: XmlRichString | undefined) => {
  if (!value || typeof value !== "object") return "";
  if (value.t !== undefined) return xmlText(value.t);
  return list(value.r).map((run) => xmlText(run?.t)).join("");
};
const xlsxCellValue = (cell: XmlCell, shared: string[]): CellValue => {
  const type = cell?.["@_t"], value = cell?.v;
  if (type === "s") return shared[Number(value)] ?? "";
  if (type === "inlineStr") return richString(cell.is);
  if (type === "str" || type === "e") return String(value ?? "");
  if (type === "b") return String(value) === "1";
  if (value === undefined || value === null || value === "") return "";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : String(value);
};

const workbookParsers = new Map<object, { readXml: (name: string) => unknown; bytes: number }>();
let workbookBytes = 0;
export async function parseXlsxTable(buffer: Uint8Array, { sheetName, range = null }: TableImportOptions = {}): Promise<IndexedTable> {
  const cached = workbookParsers.get(buffer);
  let readXml = cached?.readXml;
  if (cached) { workbookParsers.delete(buffer); workbookParsers.set(buffer, cached); }
  if (!readXml) {
  let files, expandedBytes = 0;
  try {
    files = unzipSync(new Uint8Array(buffer), { filter: (file) => {
      if (!/^xl\/(?:workbook\.xml|styles\.xml|theme\/theme[0-9]+\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(file.name)) return false;
      expandedBytes += file.originalSize;
      if (file.originalSize > 16 * 1024 * 1024 || expandedBytes > 32 * 1024 * 1024) throw new AppError("TABLE_PREVIEW_LIMIT", "工作簿解压后超过预览大小限制。", { status: 413 });
      return true;
    } });
  }
  catch (error) { throw new AppError("XLSX_PARSE_FAILED", "无法读取 XLSX 压缩包。", { status: 422, detail: { reason: String(error instanceof Error ? error.message : error).slice(0, 400) } }); }
  const parsed = new Map<string, unknown>();
  readXml = (name) => {
    if (!parsed.has(name)) parsed.set(name, files[name] ? xmlParser.parse(strFromU8(files[name])) : null);
    return parsed.get(name);
  };
  const bytes = expandedBytes + buffer.length;
  if (bytes <= 16 * 1024 * 1024) {
    workbookParsers.set(buffer, { readXml, bytes }); workbookBytes += bytes;
    while (workbookBytes > 16 * 1024 * 1024 || workbookParsers.size > 8) {
      const oldest = workbookParsers.keys().next().value!;
      workbookBytes -= workbookParsers.get(oldest)!.bytes; workbookParsers.delete(oldest);
    }
  }
  }
  const workbook = workbookDocumentSchema.parse(readXml("xl/workbook.xml"))?.workbook;
  if (!workbook) throw new AppError("XLSX_PARSE_FAILED", "XLSX 中缺少工作簿定义。", { status: 422 });
  const rels = list(relationshipsDocumentSchema.parse(readXml("xl/_rels/workbook.xml.rels"))?.Relationships?.Relationship);
  const sheets = list(workbook.sheets?.sheet);
  const selected = sheetName ? sheets.find((sheet) => sheet["@_name"] === sheetName) : sheets[0];
  if (!selected) throw new AppError("XLSX_SHEET_NOT_FOUND", "XLSX 文件中没有找到工作表。", { status: 422 });
  const relationship = rels.find((item) => item["@_Id"] === selected["@_r:id"]);
  if (!relationship) throw new AppError("XLSX_SHEET_NOT_FOUND", "工作表关系无效。", { status: 422 });
  const target = String(relationship["@_Target"] ?? "");
  const sheetPath = target.startsWith("/") ? target.slice(1) : target.startsWith("xl/") ? target : "xl/" + target;
  const worksheet = worksheetDocumentSchema.parse(readXml(sheetPath))?.worksheet;
  if (!worksheet) throw new AppError("XLSX_SHEET_NOT_FOUND", "工作表文件不存在。", { status: 422 });
  const sharedItems = list(sharedStringsDocumentSchema.parse(readXml("xl/sharedStrings.xml"))?.sst?.si);
  const shared = sharedItems.map(richString);
  const presentation = readXlsxStyles(readXml("xl/styles.xml"), readXml("xl/theme/theme1.xml"));
  const rows = list(worksheet.sheetData?.row);
  if (range) {
    const offset = range.offset ?? 0, limit = range.limit ?? 20;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError("RANGE_INVALID", "Select 1–100 rows at a valid offset.", {status:422});
    const values = new Map<number,CellValue[]>(), metadata = new Map<number,TableCell[]>(); let availableRows = 0, columnCount = 0;
    const mergeRefs = list(worksheet.mergeCells?.mergeCell).map(m => m["@_ref"]);
    const headerEnd = Math.min(10, Math.max(1, ...mergeRefs.map(r => { const [a,b] = String(r).split(":").map(parseCellReference); return a?.row === 0 ? (b?.row ?? 0) + 1 : 1; })));
    for (const [i,row] of rows.entries()) {
      const rowIndex = Number(row["@_r"] ?? i + 1) - 1; availableRows = Math.max(availableRows, rowIndex + 1);
      const keep = rowIndex < headerEnd || rowIndex >= offset && rowIndex < offset + limit;
      const cells: CellValue[] = [], meta: TableCell[] = [];
      for (const c of list(row.c)) {
        const column = cellColumnIndex(c["@_r"]); columnCount = Math.max(columnCount,column + 1); if (!keep) continue;
        const value = xlsxCellValue(c,shared), style = presentation.styles[Number(c["@_s"] ?? 0)] ?? {};
        cells[column] = value; meta[column] = { value, text: formatXlsxValue(value,style.numberFormat), style: {numberFormat: style.numberFormat}, ...(c.f !== undefined ? {formulaStatus:c.v === undefined ? "noCachedValue" : "cached"} : {}) };
      }
      if (keep) {values.set(rowIndex,cells);metadata.set(rowIndex,meta);}
    }
    if (offset >= availableRows) throw new AppError("RANGE_INVALID", "Row offset exceeds worksheet.", {status:422});
    const keys = range.columnKeys ?? Array.from({length:Math.min(12,columnCount)},(_,i)=>"c"+(i+1));
    if (keys.length > 60 || keys.length * Math.min(limit,availableRows-offset) > 2000) throw new AppError("RANGE_INVALID", "Select at most 60 columns and 2000 cells.", {status:422});
    const indices = keys.map(k => {const m=/^c([1-9][0-9]*)$/.exec(k); const index=m?Number(m[1])-1:-1;if(index<0||index>=columnCount)throw new AppError("RANGE_INVALID", "Unknown column key.",{status:422});return index;});
    const count = Math.min(limit,availableRows-offset), cells = Array.from({length:count},(_,i)=>indices.map(c=>metadata.get(offset+i)?.[c]??{value:null}));
    return {schemaVersion:"research-table-preview.v1",sourceFormat:"xlsx",sheetName:selected["@_name"],sheetNames:sheets.map(s=>s["@_name"]).slice(0,40),columns:keys.map((key,i)=>({key,label:String(values.get(0)?.[indices[i]]??key)})),rows:[],grid:{cells},rangeOffset:offset,availableRows,totalRows:Math.max(0,availableRows-1),truncated:false,headerContext:{rows:Array.from({length:headerEnd},(_,i)=>({index:i,values:indices.map(c=>values.get(i)?.[c]??null)})),merges:mergeRefs.slice(0,40)}};
  }
  const matrix: CellValue[][] = [], cellMetadata: TableCell[][] = [], rowHeights: number[] = [];
  let maxColumn = 0, maxRow = 0;
  for (const [rowIndex, row] of rows.entries()) {
    const realRow = Math.max(0, Number(row["@_r"] ?? rowIndex + 1) - 1);
    maxRow = Math.max(maxRow, realRow + 1);
    const rowValues: CellValue[] = [], metadata: TableCell[] = [];
    for (const cell of list(row.c)) {
      const index = cellColumnIndex(cell["@_r"]);
      maxColumn = Math.max(maxColumn, index + 1);
      if (realRow > MAX_PREVIEW_ROWS) continue;
      rowValues[index] = xlsxCellValue(cell, shared);
      const style = presentation.styles[Number(cell["@_s"] ?? row["@_s"] ?? 0)] ?? {};
      const richItem = cell["@_t"] === "s" ? sharedItems[Number(cell.v)] : cell.is;
      metadata[index] = { value: rowValues[index], text: formatXlsxValue(rowValues[index], style.numberFormat), style, ...(richItem?.r ? { runs: presentation.runs(richItem) } : {}) };
    }
    if (realRow <= MAX_PREVIEW_ROWS) {
      matrix[realRow] = rowValues; cellMetadata[realRow] = metadata;
      rowHeights[realRow] = Math.max(0, Math.min(1_000, Number(row["@_ht"] ?? 20) * 4 / 3));
    }
  }
  const mergedRanges = list(worksheet.mergeCells?.mergeCell).map(merge => merge["@_ref"]);
  for (const range of mergedRanges) {
    const end = parseCellReference(String(range).split(":").at(-1));
    if (end) { maxColumn = Math.max(maxColumn, end.column + 1); maxRow = Math.max(maxRow, end.row + 1); }
  }
  if (!maxRow || !maxColumn) throw new AppError("XLSX_TABLE_EMPTY", "工作表没有可预览的数据。", { status: 422 });
  const boundedRowCount = Math.min(maxRow, MAX_PREVIEW_ROWS + 1);
  if (maxColumn > MAX_PREVIEW_COLUMNS || boundedRowCount * maxColumn > MAX_PREVIEW_CELLS) throw new AppError("TABLE_PREVIEW_LIMIT", "XLSX 表格超过预览列数或单元格数限制。", { status: 413 });
  const normalized = Array.from({ length: boundedRowCount }, (_, row) => Array.from({ length: maxColumn }, (_, index) => matrix[row]?.[index] ?? ""));
  const table = makeTable(normalized[0], normalized.slice(1), "xlsx", selected["@_name"]);
  table.truncated = maxRow > MAX_PREVIEW_ROWS + 1;
  table.totalRows = Math.max(0, maxRow - 1);
  const cells = normalized.map((values, row) => values.map((value, column) => cellMetadata[row]?.[column] ?? { value }));
  applyMergedRanges(cells, mergedRanges);
  const columnWidths = Array(maxColumn).fill(120);
  for (const col of list(worksheet.cols?.col)) {
    const first = Math.max(0, Number(col["@_min"]) - 1), last = Math.min(maxColumn - 1, Number(col["@_max"]) - 1);
    for (let column = first; column <= last; column++) columnWidths[column] = Math.max(20, Math.min(2_000, Number(col["@_width"] ?? 16) * 7 + 5));
  }
  table.sheetNames = sheets.map(sheet => sheet["@_name"]).slice(0,40);
  table.grid = { cells, columnWidths, rowHeights: Array.from({ length: boundedRowCount }, (_, index) => rowHeights[index] ?? 27) };
  if (worksheet.conditionalFormatting) table.grid.warnings = ["该工作表含条件格式；当前预览显示静态单元格样式，未计算条件格式规则。"];
  return table;
}

export async function importTablePreview(buffer: Uint8Array, filename: string, mediaType = "", options: TableImportOptions = {}) {
  const extension = String(filename ?? "").toLowerCase().split(".").pop();
  if (extension === "tex" || /x-tex|latex/i.test(mediaType)) return parseTexTable(buffer);
  if (extension === "xlsx" || /spreadsheetml/i.test(mediaType)) return parseXlsxTable(buffer, options);
  if (extension === "csv") {
    const source = Buffer.from(buffer).toString("utf8");
    const rows = [];
    for (const line of source.split(/\r?\n/).filter(Boolean)) {
      const cells = []; let cell = "", quoted = false;
      for (let index = 0; index < line.length; index++) {
        const char = line[index];
        if (char === "\"" && quoted && line[index + 1] === "\"") { cell += "\""; index++; }
        else if (char === "\"") quoted = !quoted;
        else if (char === "," && !quoted) { cells.push(cell); cell = ""; }
        else cell += char;
      }
      cells.push(cell); rows.push(cells);
    }
    return makeTable(rows[0] ?? [], rows.slice(1), "csv", undefined, options.range);
  }
  return null;
}

const columnName = (index: number) => {
  let value = index + 1, name = "";
  while (value > 0) { const remainder = (value - 1) % 26; name = String.fromCharCode(65 + remainder) + name; value = Math.floor((value - 1) / 26); }
  return name;
};
export function exportXlsxTable(table: IndexedTable, sheetName = "Table") {
  if (table.grid) return exportStyledXlsx(table.grid, sheetName);
  const escape = xmlEscape;
  const rows = [table.columns.map((column) => column.label), ...table.rows.map((row) => table.columns.map((column) => row[column.key] ?? ""))];
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const ref = columnName(columnIndex) + (rowIndex + 1);
      if (typeof value === "number" && Number.isFinite(value)) return '<c r="' + ref + '"><v>' + value + "</v></c>";
      return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + escape(value) + "</t></is></c>";
    }).join("");
    return '<row r="' + (rowIndex + 1) + '">' + cells + "</row>";
  }).join("");
  const safeSheetName = String(sheetName || "Table").replace(/[\\/*?:[\]]/g, " ").slice(0, 31) || "Table";
  const files = {
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + escape(safeSheetName) + '" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + sheetRows + "</sheetData></worksheet>"),
  };
  return zipSync(files, { level: 6 });
}

export function exportTexTable(table: IndexedTable) {
  const escapes: Record<string,string> = { "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "%": "\\%", "&": "\\&", "#": "\\#", "_": "\\_", "$": "\\$", "↓": "$\\downarrow$", "↑": "$\\uparrow$", "×": "$\\times$", "±": "$\\pm$", "—": "---" };
  const escape = (value: unknown) => String(value ?? "").replace(/[\\{}%&#_$↓↑×±—]/g, (char) => escapes[char]);
  if (table.grid) return Buffer.from(exportTexPresentation(table.grid, escape), "utf8");
  const align = table.columns.map(() => "l").join("");
  const lines = ["\\begin{tabular}{" + align + "}", "\\toprule", table.columns.map((column) => escape(column.label)).join(" & ") + " \\\\", "\\midrule"];
  for (const row of table.rows) lines.push(table.columns.map((column) => escape(row[column.key])).join(" & ") + " \\\\");
  lines.push("\\bottomrule", "\\end{tabular}");
  return Buffer.from(lines.join("\n"), "utf8");
}
