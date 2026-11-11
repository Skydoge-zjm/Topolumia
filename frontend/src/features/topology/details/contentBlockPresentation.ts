import { Braces, ChartLine, ChartNoAxesCombined, FileSpreadsheet, FileText, Image as ImageIcon, Link2, Paperclip, Quote, Sigma, Table2, TextAlignStart } from "lucide-react";

const labels: Record<string, [string, string]> = {
  experimentRecord: ["实验记录", "Experiment record"],
  richText: ["文字", "Text"], metric: ["指标", "Metrics"], table: ["表格", "Table"], image: ["图片", "Image"],
  document: ["文档", "Document"], spreadsheet: ["电子表格", "Spreadsheet"], link: ["链接", "Link"],
  quote: ["摘录", "Quote"], code: ["代码", "Code"], chart: ["图表", "Chart"], file: ["文件", "File"],
};
const icons: Record<string, typeof FileText> = {
  experimentRecord: ChartLine,
  richText: TextAlignStart, metric: Sigma, table: Table2, image: ImageIcon, document: FileText,
  spreadsheet: FileSpreadsheet, link: Link2, quote: Quote, code: Braces, chart: ChartNoAxesCombined, file: Paperclip,
};

export function contentBlockIcon(type: string) { return icons[type] ?? FileText; }
export function contentBlockLabel(type: string, en: boolean) { return labels[type]?.[en ? 1 : 0] ?? type; }

/** What each kind of block holds, in the order a researcher reaches for them. */
export const blockTypeChoices: { type: string; label: [string, string]; holds: [string, string] }[] = [
  { type: "richText", label: ["文字 / Markdown", "Rich text / Markdown"], holds: ["说明、推导、观察与结论", "Explanation, reasoning, observations"] },
  { type: "metric", label: ["指标", "Metrics"], holds: ["带条件与单位的最终数值", "Final figures with conditions and units"] },
  { type: "table", label: ["表格", "Table"], holds: ["粘贴，或导入 TeX / XLSX / CSV", "Paste, or import TeX / XLSX / CSV"] },
  { type: "image", label: ["图片 / 截图", "Image"], holds: ["图、截图与图注", "Figures, screenshots, captions"] },
  { type: "code", label: ["代码 / 命令", "Code"], holds: ["脚本、命令与配置片段", "Scripts, commands, configuration"] },
  { type: "file", label: ["文件", "File"], holds: ["配置文件、日志等原始材料", "Config files, logs, raw material"] },
  { type: "document", label: ["文档", "Document"], holds: ["PDF、TeX 或 Markdown 文档", "PDF, TeX or Markdown documents"] },
  { type: "spreadsheet", label: ["电子表格", "Spreadsheet"], holds: ["保留原工作表的 XLSX / CSV", "XLSX / CSV kept as worksheets"] },
  { type: "quote", label: ["原文摘录", "Quote"], holds: ["原文、译文与出处", "Source text, translation, origin"] },
  { type: "link", label: ["链接", "Link"], holds: ["外部页面、仪表盘与代码仓库", "Pages, dashboards, repositories"] },
  { type: "chart", label: ["图表", "Chart"], holds: ["把一个表格内容块画成图", "Plot a table block"] },
  { type: "experimentRecord", label: ["实验记录", "Experiment record"], holds: ["多次运行的曲线、数据与来源", "Curves, data and sources of runs"] },
];
