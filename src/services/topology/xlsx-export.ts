import { strToU8, zipSync } from "fflate";

const escape = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const columns = (index) => { let value = index + 1, name = ""; while (value > 0) { name = String.fromCharCode(65 + (value - 1) % 26) + name; value = Math.floor((value - 1) / 26); } return name; };
const attr = (name, value) => value === undefined ? "" : " " + name + '="' + escape(value) + '"';
const fontXml = (style) => '<font><name val="Arial"/><sz val="' + (style.fontSize ?? 11) + '"/>' + (style.bold ? "<b/>" : "") + (style.italic ? "<i/>" : "") + (style.underline ? "<u/>" : "") + (style.color ? '<color rgb="FF' + style.color.slice(1) + '"/>' : "") + "</font>";

export function exportStyledXlsx(grid, sheetName) {
  const styles: Record<string, any>[] = [{}], styleIds = new Map([["{}", 0]]);
  for (const row of grid.cells) for (const cell of row) {
    const key = JSON.stringify(cell.style ?? {});
    if (!styleIds.has(key)) { styleIds.set(key, styles.length); styles.push(cell.style); }
  }
  const numberFormats = [], numberIds = new Map();
  const cellXfs = styles.map((style, index) => {
    let numFmtId = 0;
    if (style.numberFormat) {
      if (!numberIds.has(style.numberFormat)) { numberIds.set(style.numberFormat, 164 + numberFormats.length); numberFormats.push(style.numberFormat); }
      numFmtId = numberIds.get(style.numberFormat);
    }
    const alignment = '<alignment' + attr("horizontal", style.horizontal) + attr("vertical", style.vertical === "middle" ? "center" : style.vertical) + attr("wrapText", style.wrap === undefined ? undefined : style.wrap ? 1 : 0) + "/>";
    return '<xf numFmtId="' + numFmtId + '" fontId="' + index + '" fillId="' + (style.background ? index + 2 : 0) + '" borderId="' + index + '" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1">' + alignment + "</xf>";
  }).join("");
  const fonts = styles.map(fontXml).join("");
  const fills = '<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' + styles.map(style => style.background ? '<fill><patternFill patternType="solid"><fgColor rgb="FF' + style.background.slice(1) + '"/><bgColor indexed="64"/></patternFill></fill>' : '<fill><patternFill patternType="none"/></fill>').join("");
  const borders = styles.map(style => "<border>" + ["left", "right", "top", "bottom"].map(edge => {
    const border = style.borders?.[edge];
    return border ? "<" + edge + ' style="' + border.style + '"><color rgb="FF' + (border.color ?? "#000000").slice(1) + '"/></' + edge + ">" : "<" + edge + "/>";
  }).join("") + "<diagonal/></border>").join("");
  const numFmts = numberFormats.length ? '<numFmts count="' + numberFormats.length + '">' + numberFormats.map((format, index) => '<numFmt numFmtId="' + (164 + index) + '" formatCode="' + escape(format) + '"/>').join("") + "</numFmts>" : "";
  const styleSheet = '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + numFmts + '<fonts count="' + styles.length + '">' + fonts + '</fonts><fills count="' + (styles.length + 2) + '">' + fills + '</fills><borders count="' + styles.length + '">' + borders + '</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="' + styles.length + '">' + cellXfs + "</cellXfs></styleSheet>";
  const merges = [];
  const sheetRows = grid.cells.map((row, r) => {
    const cells = row.map((cell, c) => {
      const ref = columns(c) + (r + 1), styleId = styleIds.get(JSON.stringify(cell.style ?? {})) ?? 0;
      if (!cell.covered && ((cell.rowSpan ?? 1) > 1 || (cell.colSpan ?? 1) > 1)) merges.push(ref + ":" + columns(c + (cell.colSpan ?? 1) - 1) + (r + (cell.rowSpan ?? 1)));
      const value = cell.covered ? "" : cell.value;
      const attributes = ' r="' + ref + '" s="' + styleId + '"';
      if (typeof value === "number") return "<c" + attributes + "><v>" + value + "</v></c>";
      if (typeof value === "boolean") return "<c" + attributes + ' t="b"><v>' + (value ? 1 : 0) + "</v></c>";
      let content = '<t xml:space="preserve">' + escape(value) + "</t>";
      if (cell.runs?.length) content = cell.runs.map(run => "<r><rPr>" + (run.bold ? "<b/>" : "") + (run.italic ? "<i/>" : "") + (run.underline ? "<u/>" : "") + (run.color ? '<color rgb="FF' + run.color.slice(1) + '"/>' : "") + '</rPr><t xml:space="preserve">' + escape(run.text) + "</t></r>").join("");
      return "<c" + attributes + ' t="inlineStr"><is>' + content + "</is></c>";
    }).join("");
    return '<row r="' + (r + 1) + '"' + attr("ht", grid.rowHeights?.[r] === undefined ? undefined : grid.rowHeights[r] * 3 / 4) + (grid.rowHeights?.[r] === undefined ? "" : ' customHeight="1"') + ">" + cells + "</row>";
  }).join("");
  const colXml = grid.columnWidths?.length ? "<cols>" + grid.columnWidths.map((width, index) => '<col min="' + (index + 1) + '" max="' + (index + 1) + '" width="' + Math.max(0, (width - 5) / 7) + '" customWidth="1"/>').join("") + "</cols>" : "";
  const mergeXml = merges.length ? '<mergeCells count="' + merges.length + '">' + merges.map(ref => '<mergeCell ref="' + ref + '"/>').join("") + "</mergeCells>" : "";
  const name = String(sheetName || "Table").replace(/[\\/*?:[\]]/g, " ").slice(0, 31);
  const files = {
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + escape(name) + '" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + colXml + "<sheetData>" + sheetRows + "</sheetData>" + mergeXml + "</worksheet>",
    "xl/styles.xml": styleSheet,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)])), { level: 6 });
}
