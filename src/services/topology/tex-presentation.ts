const namedColors = { white: "#FFFFFF", black: "#000000", red: "#FF0000", green: "#00AA00", blue: "#0000FF", yellow: "#FFFF00", cyan: "#00FFFF", gray: "#808080", orange: "#FF8000" };
function texColor(value) {
  const [name, percent = "100", base = "white"] = String(value ?? "").split("!");
  const foreground = namedColors[name.toLowerCase()], background = namedColors[base.toLowerCase()];
  if (/^[0-9a-f]{6}$/i.test(name)) return "#" + name.toUpperCase();
  if (!foreground || !background) return undefined;
  const fraction = Math.max(0, Math.min(1, Number(percent) / 100));
  return "#" + [1, 3, 5].map(index => Math.round(parseInt(foreground.slice(index, index + 2), 16) * fraction + parseInt(background.slice(index, index + 2), 16) * (1 - fraction)).toString(16).padStart(2, "0")).join("").toUpperCase();
}
const group = (source, position) => {
  let start = position;
  while (/\s/.test(source[start] ?? "") && start < source.length) start++;
  if (source[start] !== "{") return null;
  let depth = 1;
  for (let index = start + 1; index < source.length; index++) {
    if (source[index - 1] === "\\") continue;
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return { value: source.slice(start + 1, index), end: index + 1 };
  }
  return null;
};
const command = (source, name, argumentCount) => {
  const match = new RegExp("\\\\" + name + "\\b").exec(source);
  if (!match) return null;
  let end = match.index + match[0].length;
  const arguments_ = [];
  for (let index = 0; index < argumentCount; index++) {
    const parsed = group(source, end);
    if (!parsed) return null;
    arguments_.push(parsed.value); end = parsed.end;
  }
  return { arguments: arguments_, start: match.index, end };
};
function splitOutsideGroups(source, separator) {
  const pieces = []; let depth = 0, piece = "";
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\\" && /[{}&%]/.test(source[index + 1] ?? "")) { piece += source.slice(index, index + 2); index++; continue; }
    if (source[index] === "{") depth++;
    if (source[index] === "}") depth--;
    if (depth === 0 && source.slice(index, index + separator.length) === separator) {
      pieces.push(piece); piece = ""; index += separator.length - 1;
    } else piece += source[index];
  }
  pieces.push(piece);
  return pieces;
}
function alignmentColumns(preamble) {
  const columns = [];
  for (let index = 0; index < preamble.length; index++) {
    const char = preamble[index];
    if (/[lcrpmb]/.test(char)) columns.push(char === "c" ? "center" : char === "r" ? "right" : "left");
    if (preamble[index + 1] === "{") { const parsed = group(preamble, index + 1); if (parsed) index = parsed.end - 1; }
  }
  return columns;
}
function styleAndText(source, parseText) {
  let content = source;
  const style = {};
  if (/\\(?:textbf|mathbf|bfseries)\b/.test(content)) style.bold = true;
  if (/\\(?:textit|emph|itshape)\b/.test(content)) style.italic = true;
  if (/\\underline\b/.test(content)) style.underline = true;
  const color = content.match(/\\textcolor(?:\[HTML\])?\s*\{([^{}]+)\}/)?.[1];
  if (color) style.color = texColor(color);
  const background = content.match(/\\cellcolor(?:\[HTML\])?\s*\{([^{}]+)\}/)?.[1];
  if (background) style.background = texColor(background);
  content = content.replace(/\\(?:textcolor|cellcolor)(?:\[HTML\])?\s*\{[^{}]+\}/g, "");
  const value = parseText(content);
  return { value, style };
}

export function parseTexPresentation(source, parseText) {
  const uncommented = source.split("\n").map(line => line.replace(/(?<!\\)%.*$/, "")).join("\n");
  const begin = /\\begin\s*\{tabular(\*)?\}(?:\[[^\]]*])?/.exec(uncommented);
  if (!begin) throw new Error("TeX 文件中没有找到 tabular 表格环境。");
  let preamble = group(uncommented, begin.index + begin[0].length);
  if (begin[1] && preamble) preamble = group(uncommented, preamble.end);
  if (!preamble) throw new Error("TeX 表格列定义无效。");
  const end = uncommented.indexOf("\\end{tabular" + (begin[1] ? "*" : "") + "}", preamble.end);
  if (end < 0) throw new Error("TeX 表格缺少 end{tabular}。");
  let body = uncommented.slice(preamble.end, end);
  body = body.replace(/\\(?:cline|cmidrule)(?:\([^)]*\))?\s*\{[^}]*}/g, "");
  const rawRows = splitOutsideGroups(body, "\\\\").map(row => row.replace(/^\s*\[[^\]]*]/, "").trim()).filter(row => row.replace(/\\(?:toprule|midrule|bottomrule|hline|addlinespace)\b/g, "").trim());
  if (rawRows.length > 301) throw new Error("TeX 表格超过 300 行预览限制。");
  const alignments = alignmentColumns(preamble.value), cells = [];
  let maxColumns = alignments.length;
  const ensure = (row, column) => {
    if (row >= 301 || column >= 60) throw new Error("TeX 表格合并范围超过预览限制。");
    cells[row] ??= [];
    cells[row][column] ??= { value: "" };
    return cells[row][column];
  };
  for (const [rowIndex, rawRow] of rawRows.entries()) {
    const rowBackground = texColor(rawRow.match(/\\rowcolor(?:\[HTML\])?\s*\{([^{}]+)\}/)?.[1]);
    const row = rawRow.replace(/\\rowcolor(?:\[HTML\])?\s*\{[^{}]+}/g, "").replace(/\\(?:toprule|midrule|bottomrule|hline|addlinespace)\b/g, "");
    let column = 0;
    for (const token of splitOutsideGroups(row, "&")) {
      if (ensure(rowIndex, column).covered && !token.trim()) { column++; continue; }
      while (ensure(rowIndex, column).covered) column++;
      let content = token.trim(), colSpan = 1, rowSpan = 1, horizontal = alignments[column] ?? "left";
      const multiColumn = command(content, "multicolumn", 3);
      if (multiColumn) {
        colSpan = Number(multiColumn.arguments[0]);
        horizontal = alignmentColumns(multiColumn.arguments[1])[0] ?? horizontal;
        content = content.slice(0, multiColumn.start) + multiColumn.arguments[2] + content.slice(multiColumn.end);
      }
      const multiRow = command(content, "multirow", 3);
      if (multiRow) {
        rowSpan = Number(multiRow.arguments[0]);
        content = content.slice(0, multiRow.start) + multiRow.arguments[2] + content.slice(multiRow.end);
      }
      if (!Number.isSafeInteger(colSpan) || colSpan < 1 || !Number.isSafeInteger(rowSpan) || rowSpan < 1) throw new Error("暂不支持该 TeX 合并单元格定义。");
      const parsed = styleAndText(content, parseText);
      const anchor = ensure(rowIndex, column);
      Object.assign(anchor, parsed, { colSpan, rowSpan, style: { horizontal, vertical: rowSpan > 1 ? "middle" : "top", ...(rowBackground ? { background: rowBackground } : {}), ...parsed.style } });
      for (let dy = 0; dy < rowSpan; dy++) for (let dx = 0; dx < colSpan; dx++) if (dy || dx) ensure(rowIndex + dy, column + dx).covered = true;
      column += colSpan; maxColumns = Math.max(maxColumns, column);
    }
  }
  const normalized = Array.from({ length: cells.length }, (_, row) => Array.from({ length: maxColumns }, (_, column) => cells[row]?.[column] ?? { value: "" }));
  return { cells: normalized, columnWidths: Array(maxColumns).fill(130), rowHeights: Array(cells.length).fill(32) };
}

export function exportTexPresentation(grid, escape) {
  const anchors = [];
  for (let row = 0; row < grid.cells.length; row++) for (let column = 0; column < grid.cells[row].length; column++) {
    const cell = grid.cells[row][column];
    if (!cell.covered) anchors.push({ row, column, rowSpan: cell.rowSpan ?? 1, colSpan: cell.colSpan ?? 1 });
  }
  const rows = grid.cells.map((cells, row) => {
    const parts = [];
    for (let column = 0; column < cells.length;) {
      const cell = cells[column], style = cell.style ?? {};
      let content = escape(cell.text ?? cell.value);
      let colSpan = cell.colSpan ?? 1;
      if (cell.covered) {
        const owner = anchors.find(anchor => anchor.row <= row && anchor.row + anchor.rowSpan > row && anchor.column <= column && anchor.column + anchor.colSpan > column);
        if (owner?.row === row) { column = owner.column + owner.colSpan; continue; }
        colSpan = owner?.colSpan ?? 1;
        content = "";
      } else {
        if (style.bold) content = "\\textbf{" + content + "}";
        if (style.italic) content = "\\textit{" + content + "}";
        if (style.underline) content = "\\underline{" + content + "}";
        if (style.color) content = "\\textcolor[HTML]{" + style.color.slice(1) + "}{" + content + "}";
        if (style.background) content = "\\cellcolor[HTML]{" + style.background.slice(1) + "}" + content;
        if ((cell.rowSpan ?? 1) > 1) content = "\\multirow{" + cell.rowSpan + "}{*}{" + content + "}";
      }
      if (colSpan > 1) content = "\\multicolumn{" + colSpan + "}{" + (style.horizontal === "right" ? "r" : style.horizontal === "left" ? "l" : "c") + "}{" + content + "}";
      parts.push(content); column += colSpan;
    }
    return parts.join(" & ") + " \\\\";
  });
  return ["% Requires booktabs, multirow and xcolor[table]", "\\begin{tabular}{" + grid.cells[0].map(() => "l").join("") + "}", "\\toprule", ...rows, "\\bottomrule", "\\end{tabular}"].join("\n");
}
