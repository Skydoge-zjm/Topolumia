import { useState } from "react";
import { ChevronDown, Rows3 } from "lucide-react";

export function PaperBibliography({ core, en, initialExpanded }: { core: Record<string, any>; en: boolean; initialExpanded: boolean }) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const authors = Array.isArray(core.authors) ? core.authors : [];
  const fields = [
    [en ? "Paper title" : "论文标题", core.paperTitle],
    [en ? "Authors" : "作者", authors.join("；")],
    [en ? "Year" : "发表年份", core.year],
    [en ? "Venue" : "会议 / 期刊", core.venue],
    [en ? "Field" : "研究领域", core.field],
    ["DOI / arXiv", [core.identifiers?.doi, core.identifiers?.arxiv].filter(Boolean).join(" · ")],
    [en ? "Abstract" : "摘要", core.abstract],
  ].filter(([, value]) => value);
  return <details className="research-card research-node-core-card research-bibliography" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><Rows3 size={17} /><span><strong>{en ? "Bibliographic information" : "文献基础信息"}</strong></span><ChevronDown size={17} className="research-bibliography-toggle" /></summary>
    <dl className="research-field-details">{fields.map(([label, value]) => <div key={String(label)}><dt>{String(label)}</dt><dd>{String(value)}</dd></div>)}</dl>
  </details>;
}
