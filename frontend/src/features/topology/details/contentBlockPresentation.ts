import { FileText, Image as ImageIcon, Link2, Table2 } from "lucide-react";
export function contentBlockIcon(type: string) {
  if (type === "image") return ImageIcon;
  if (type === "link") return Link2;
  if (type === "table" || type === "metric") return Table2;
  return FileText;
}
