const list = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const text = (value) => typeof value === "object" ? String(value?.["#text"] ?? "") : String(value ?? "");
const enabled = (value) => value !== undefined && value?.["@_val"] !== "0" && value?.["@_val"] !== "false";
const indexed = ["000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080"];
const defaultTheme = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47", "0563C1", "954F72"];
const formats = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 14: "mm-dd-yy", 49: "@" };

export function readXlsxStyles(stylesXml, themeXml) {
  const scheme = themeXml?.["a:theme"]?.["a:themeElements"]?.["a:clrScheme"];
  const themeNames = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
  const theme = scheme ? themeNames.map((name, index) => {
    const entry = scheme["a:" + name];
    return entry?.["a:srgbClr"]?.["@_val"] ?? entry?.["a:sysClr"]?.["@_lastClr"] ?? defaultTheme[index];
  }) : defaultTheme;
  const resolveColor = (value) => {
    if (!value || typeof value !== "object") return undefined;
    let rgb = value["@_rgb"]?.slice(-6) ?? theme[Number(value["@_theme"])] ?? indexed[Number(value["@_indexed"])];
    if (!rgb || !/^[0-9a-f]{6}$/i.test(rgb)) return undefined;
    const tint = Math.max(-1, Math.min(1, Number(value["@_tint"] ?? 0)));
    if (tint) rgb = rgb.match(/../g).map(hex => {
      const channel = parseInt(hex, 16);
      return Math.round(tint < 0 ? channel * (1 + tint) : channel + (255 - channel) * tint).toString(16).padStart(2, "0");
    }).join("");
    return "#" + rgb.toUpperCase();
  };
  const fontStyle = (font) => {
    const result = {};
    if (!font || typeof font !== "object") return result;
    if (font.b !== undefined) result.bold = enabled(font.b);
    if (font.i !== undefined) result.italic = enabled(font.i);
    if (font.u !== undefined) result.underline = enabled(font.u);
    const color = resolveColor(font.color); if (color) result.color = color;
    const size = Number(font.sz?.["@_val"]); if (size > 0 && size <= 72) result.fontSize = size;
    return result;
  };
  const sheet = stylesXml?.styleSheet ?? {};
  const fonts = list(sheet.fonts?.font), fills = list(sheet.fills?.fill), borders = list(sheet.borders?.border);
  const customFormats = Object.fromEntries(list(sheet.numFmts?.numFmt).map(item => [item["@_numFmtId"], item["@_formatCode"]]));
  const styles = list(sheet.cellXfs?.xf).map(xf => {
    const style = fontStyle(fonts[Number(xf["@_fontId"] ?? 0)]);
    const pattern = fills[Number(xf["@_fillId"] ?? 0)]?.patternFill;
    if (pattern?.["@_patternType"] === "solid") {
      const background = resolveColor(pattern.fgColor);
      if (background) style.background = background;
    }
    const border = borders[Number(xf["@_borderId"] ?? 0)], edges = {};
    for (const edge of ["top", "bottom", "left", "right"]) {
      const side = border?.[edge], kind = side?.["@_style"];
      if (!kind) continue;
      edges[edge] = { style: ["thin", "medium", "thick", "dotted", "dashed", "double"].includes(kind) ? kind : "thin", color: resolveColor(side.color) ?? "#000000" };
    }
    if (Object.keys(edges).length) style.borders = edges;
    const alignment = xf.alignment;
    if (alignment) {
      const horizontal = alignment["@_horizontal"];
      if (["left", "center", "right", "justify"].includes(horizontal)) style.horizontal = horizontal;
      const vertical = alignment["@_vertical"];
      if (["top", "center", "bottom"].includes(vertical)) style.vertical = vertical === "center" ? "middle" : vertical;
      if (alignment["@_wrapText"] !== undefined) style.wrap = enabled({ "@_val": alignment["@_wrapText"] });
    }
    const format = customFormats[xf["@_numFmtId"]] ?? formats[xf["@_numFmtId"]];
    if (format && format !== "General") style.numberFormat = format;
    return style;
  });
  const runs = (item) => list(item?.r).map(run => {
    const font = fontStyle(run.rPr);
    delete font.fontSize;
    return { text: text(run.t), ...font };
  });
  return { styles, runs };
}

export function formatXlsxValue(value, format) {
  if (typeof value !== "number" || !format || format === "General" || format === "@") return String(value ?? "");
  const section = format.split(";")[value < 0 ? 1 : 0] ?? format.split(";")[0];
  const clean = section.replace(/\[[^\]]*]/g, "").replace(/"[^"]*"/g, "").replace(/\\./g, "");
  if (/[ymdhis]/i.test(clean.replace(/E[+-]0+/gi, ""))) return String(value);
  if (!/[0#]/.test(clean)) return String(value);
  const decimal = clean.match(/\.([0#]+)/)?.[1] ?? "";
  const minimum = Math.min(12, (decimal.match(/0/g) ?? []).length);
  const maximum = Math.min(12, decimal.length);
  const numeric = clean.includes("%") ? value * 100 : value;
  if (/E[+-]0+/i.test(clean)) return numeric.toExponential(maximum).toUpperCase();
  const displayed = new Intl.NumberFormat("en-US", { minimumFractionDigits: minimum, maximumFractionDigits: maximum, useGrouping: /#,##/.test(clean) }).format(numeric);
  const literal = section.match(/"([^"]*)"/)?.[1] ?? "";
  return displayed + (clean.includes("%") ? "%" : "") + literal;
}

export function parseCellReference(reference) {
  const match = String(reference ?? "").match(/^([A-Z]+)([1-9][0-9]*)$/i);
  if (!match) return null;
  let column = 0;
  for (const char of match[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64;
  return { row: Number(match[2]) - 1, column: column - 1 };
}

export function applyMergedRanges(cells, ranges) {
  const occupied = new Set();
  for (const range of ranges) {
    const parts = String(range).split(":"), start = parseCellReference(parts[0]), end = parseCellReference(parts[1] ?? parts[0]);
    if (!start || !end || end.row < start.row || end.column < start.column) throw new Error("Invalid merged-cell range");
    if (start.row >= cells.length || start.column >= cells[0]?.length) continue;
    const bottom = Math.min(end.row, cells.length - 1), right = Math.min(end.column, cells[0].length - 1);
    const anchor = cells[start.row][start.column];
    anchor.rowSpan = bottom - start.row + 1; anchor.colSpan = right - start.column + 1;
    // Merged cells often store bottom/right borders on their final cells.
    const last = cells[bottom][right];
    if (last.style?.borders) anchor.style = { ...anchor.style, borders: { ...anchor.style?.borders, bottom: last.style.borders.bottom ?? anchor.style?.borders?.bottom, right: last.style.borders.right ?? anchor.style?.borders?.right } };
    for (let row = start.row; row <= bottom; row++) for (let column = start.column; column <= right; column++) {
      const key = row + ":" + column;
      if (occupied.has(key)) throw new Error("Overlapping merged-cell ranges");
      occupied.add(key);
      if (row !== start.row || column !== start.column) cells[row][column].covered = true;
    }
  }
}
