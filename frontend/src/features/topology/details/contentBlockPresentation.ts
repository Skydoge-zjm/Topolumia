import { FileCode2, FileSpreadsheet, FileText, Image as ImageIcon, Link2, Quote, Sigma, Table2, ChartLine } from "lucide-react";

const labels: Record<string, [string, string]> = {
  experimentRecord: ["实验记录", "Experiment record"],
  richText: ["文字", "Text"], metric: ["指标", "Metrics"], table: ["表格", "Table"], image: ["图片", "Image"],
  document: ["文档", "Document"], spreadsheet: ["电子表格", "Spreadsheet"], link: ["链接", "Link"],
  quote: ["摘录", "Quote"], code: ["代码", "Code"], chart: ["图表", "Chart"], file: ["文件", "File"],
};
const icons: Record<string, typeof FileText> = {
  experimentRecord: ChartLine,
  richText: FileText, metric: Sigma, table: Table2, image: ImageIcon, document: FileText,
  spreadsheet: FileSpreadsheet, link: Link2, quote: Quote, code: FileCode2, chart: Table2, file: FileText,
};

export function contentBlockIcon(type: string) { return icons[type] ?? FileText; }
export function contentBlockLabel(type: string, en: boolean) { return labels[type]?.[en ? 1 : 0] ?? type; }
