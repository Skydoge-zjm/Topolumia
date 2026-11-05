import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ExternalLink, Plus, Trash2, X } from "lucide-react";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { renderMarkdown } from "@/shared/lib/markdown";
import { safeUrl } from "../model";
import type { ResearchLink, Metric } from "../model";
export function ResearchDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content aria-describedby={undefined} translate="no" className="research-dialog research-workspace">
    <header><div><Dialog.Title>{title}</Dialog.Title></div><button className="button" aria-label="关闭 / Close" onClick={onClose}><X size={18} /></button></header>{children}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function MarkdownBody({ body, en = false }: { body: string; en?: boolean }) {
  return body ? <div className="message-body research-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(body, { en }) }} /> : <p className="research-empty">{en ? "No content recorded yet." : "尚未记录正文。"}</p>;
}
export function LinkList({ links, en = false }: { links: ResearchLink[]; en?: boolean }) {
  return links.length ? <div className="research-links">{links.map((link, index) => {
    const url = safeUrl(link.url); return url ? <div key={index}><a href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} /><span>{link.label || link.url}</span><small>{link.kind}</small></a>
      {link.kind === "image" && <a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={link.label || (en ? "Research output" : "科研产出")} loading="lazy" referrerPolicy="no-referrer" /></a>}</div> : null;
  })}</div> : <p className="research-empty">{en ? "No links or outputs attached." : "尚未关联链接或产出。"}</p>;
}
export function LinkEditor({ value, onChange, en }: { value: ResearchLink[]; onChange: (links: ResearchLink[]) => void; en: boolean }) {
  const edit = (index: number, patch: Partial<ResearchLink>) => onChange(value.map((link, i) => i === index ? { ...link, ...patch } : link));
  return <fieldset className="research-fieldset"><legend>{en ? "Links and outputs" : "链接与产出"}</legend>{value.map((link, index) => <div className="research-link-editor" key={index}>
    <input aria-label={`${en ? "Link label" : "链接名称"} ${index + 1}`} placeholder={en ? "Label" : "名称"} value={link.label} onChange={event => edit(index, { label: event.target.value })} />
    <input type="url" required aria-label={`${en ? "Link URL" : "链接地址"} ${index + 1}`} placeholder="https://…" value={link.url} onChange={event => edit(index, { url: event.target.value })} />
    <SelectMenu ariaLabel={en ? "Link type" : "链接类型"} value={link.kind} onChange={kind => edit(index, { kind })} options={["paper", "code", "dataset", "wandb", "tensorboard", "mlflow", "artifact", "image", "report", "other"].map(value => ({ value, label: ({ paper: "论文", code: "代码", dataset: "数据集", artifact: "产出", image: "图片", report: "报告", other: "其他" } as Record<string, string>)[value] && !en ? ({ paper: "论文", code: "代码", dataset: "数据集", artifact: "产出", image: "图片", report: "报告", other: "其他" } as Record<string, string>)[value] : value }))} />
    <button type="button" className="button" aria-label={`${en ? "Remove link" : "移除链接"} ${index + 1}`} onClick={() => onChange(value.filter((_, i) => i !== index))}><Trash2 size={15} /></button>
  </div>)}<button type="button" className="button" onClick={() => onChange([...value, { label: "", url: "", kind: "other" }])}><Plus size={15} />{en ? "Add link" : "添加链接"}</button></fieldset>;
}
export function MetricTable({ metrics, en = false }: { metrics: Metric[]; en?: boolean }) {
  return metrics.length ? <div className="research-table-wrap"><table className="research-table"><thead><tr>{(en ? ["Metric", "Value", "Unit", "Split", "Direction"] : ["指标", "数值", "单位", "数据划分", "方向"]).map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{metrics.map((metric, index) => <tr key={index}><td>{metric.name}</td><td>{metric.value}</td><td>{metric.unit || "—"}</td><td>{metric.split || "—"}</td><td>{metric.direction === "min" ? "↓" : metric.direction === "max" ? "↑" : "—"}</td></tr>)}</tbody></table></div> : <p className="research-empty">{en ? "No metrics recorded." : "尚无结果指标。"}</p>;
}
