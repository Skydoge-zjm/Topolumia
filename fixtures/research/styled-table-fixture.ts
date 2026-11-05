import { strToU8, zipSync } from "fflate";

/** A complete workbook fixture with independent OOXML, as produced by Excel. */
export function styledXlsxFixture() {
  const cell = (ref, value, style = 0) => typeof value === "number" ? '<c r="' + ref + '" s="' + style + '"><v>' + value + "</v></c>" : '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t>' + value + "</t></is></c>";
  const row = (index, cells, height) => '<row r="' + index + '" ht="' + height + '" customHeight="1">' + cells + "</row>";
  const sheet = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="18"/><col min="2" max="2" width="22"/><col min="3" max="5" width="16"/></cols><sheetData>' +
    row(1, cell("A1", "Method", 1) + cell("C1", "ImageNet 4x", 1), 30) +
    row(2, ["Variant", "Model", "FID ↓", "PSNR ↑", "SSIM ↑"].map((value, index) => cell(String.fromCharCode(65 + index) + "2", value, 2)).join(""), 26) +
    row(3, cell("A3", "Baselines") + cell("B3", "Regression") + cell("C3", 15.2) + cell("D3", 27.9) + cell("E3", 0.801, 4), 24) +
    row(4, cell("B4", "Bicubic") + cell("C4", 28.2) + cell("D4", 22.1) + cell("E4", 0.67, 4), 24) +
    row(5, cell("A5", "Ours") + '<c r="B5" s="0" t="inlineStr"><is><r><rPr><b/></rPr><t>SR</t></r><r><rPr><color rgb="FFDC2626"/></rPr><t>3</t></r></is></c>' + cell("C5", 5.2, 3) + cell("D5", 26.4, 3) + cell("E5", 0.762, 4), 28) +
    row(6, cell("A6", "Formatting fixture: illustrative values used to check merged notes, text wrapping and row height.", 5), 42) +
    '</sheetData><mergeCells count="4"><mergeCell ref="A1:B1"/><mergeCell ref="C1:E1"/><mergeCell ref="A3:A4"/><mergeCell ref="A6:E6"/></mergeCells></worksheet>';
  const styles = '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts><fonts count="5"><font><sz val="11"/></font><font><b/><sz val="12"/><color rgb="FFFFFFFF"/></font><font><b/><sz val="11"/></font><font><b/><sz val="11"/><color rgb="FF166534"/></font><font><i/><sz val="10"/><color rgb="FF475569"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8F2F1"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FF94A3B8"/></left><right style="thin"><color rgb="FF94A3B8"/></right><top style="thin"><color rgb="FF94A3B8"/></top><bottom style="thin"><color rgb="FF94A3B8"/></bottom></border></borders><cellXfs count="6"><xf fontId="0" fillId="0" borderId="1"><alignment vertical="center"/></xf><xf fontId="1" fillId="2" borderId="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf fontId="2" fillId="4" borderId="1"><alignment horizontal="center" vertical="center"/></xf><xf fontId="3" fillId="3" borderId="1" numFmtId="2"><alignment horizontal="right" vertical="center"/></xf><xf fontId="0" fillId="0" borderId="1" numFmtId="164"><alignment horizontal="right" vertical="center"/></xf><xf fontId="4" fillId="0" borderId="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf></cellXfs></styleSheet>';
  const files = {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Styled results" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": sheet,
    "xl/styles.xml": styles,
    "xl/theme/theme1.xml": '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Research"><a:themeElements><a:clrScheme name="Research"><a:accent1><a:srgbClr val="155E63"/></a:accent1></a:clrScheme></a:themeElements></a:theme>',
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)])));
}

export function styledTexFixture() {
  const slash = String.fromCharCode(92), endRow = slash + slash;
  return [
    slash + "begin{tabular}{llrrr}",
    slash + "toprule",
    slash + "multicolumn{2}{c}{" + slash + "textbf{Method}} & " + slash + "multicolumn{3}{c}{" + slash + "cellcolor{blue!10}" + slash + "textbf{ImageNet 4x}} " + endRow,
    slash + "midrule",
    "Variant & Model & FID & PSNR & SSIM " + endRow,
    slash + "midrule",
    slash + "multirow{2}{*}{Baselines} & Regression & 15.2 & 27.9 & 0.801 " + endRow,
    "& Bicubic & 28.2 & 22.1 & 0.670 " + endRow,
    slash + "rowcolor{green!10}",
    "Ours & " + slash + "textbf{SR3} & " + slash + "textbf{5.20} & 26.4 & 0.762 " + endRow,
    slash + "bottomrule",
    slash + "end{tabular}",
  ].join("\n");
}
