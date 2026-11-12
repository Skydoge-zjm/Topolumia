import { useState } from "react";
import { ChevronDown, ExternalLink, Rows3 } from "lucide-react";
import { cleanText, paperAuthorNames, paperAuthors, paperIdentifiers, paperLinks } from "./paperIdentity";

/** One line under the title: who wrote it, where it appeared, and how to reach the original. */
export function PaperCitation({ core, en }: { core: Record<string, any>; en: boolean }) {
  const line = [paperAuthors(core, en), cleanText(core.venue), core.year ? String(core.year) : ""].filter(Boolean).join(" · ");
  const identifiers = paperIdentifiers(core);
  if (!line && !identifiers.length) return null;
  return <p className="research-citation">{line && <span>{line}</span>}{identifiers.map(item => item.href
    ? <a key={item.key} href={item.href} target="_blank" rel="noopener noreferrer">{item.label}<ExternalLink size={12} /></a>
    : <span key={item.key}>{item.label}</span>)}</p>;
}

export function PaperBibliography({ core, en, initialExpanded }: { core: Record<string, any>; en: boolean; initialExpanded: boolean }) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const authors = paperAuthorNames(core);
  const abstract = cleanText(core.abstract), field = cleanText(core.field), urls = paperLinks(core);
  const tags = (Array.isArray(core.tags) ? core.tags : []).map(cleanText).filter(Boolean);
  const other = (Array.isArray(core.identifiers?.other) ? core.identifiers.other : []).map(cleanText).filter(Boolean);
  if (!authors.length && !abstract && !field && !urls.length && !tags.length && !other.length) return null;
  return <details className="research-bibliography" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><Rows3 size={17} /><span><strong>{en ? "Bibliographic information" : "文献基础信息"}</strong></span><ChevronDown size={17} className="research-bibliography-toggle" /></summary>
    {abstract && <p className="research-abstract-text">{abstract}</p>}
    <dl className="research-field-details">
      {authors.length > 0 && <div className="research-wide"><dt>{en ? "Authors" : "作者"}</dt><dd>{authors.join(en ? ", " : "、")}</dd></div>}
      {field && <div><dt>{en ? "Research field" : "研究领域"}</dt><dd>{field}</dd></div>}
      {urls.length > 0 && <div><dt>{en ? "Original links" : "原文链接"}</dt><dd>{urls.map(url => <a key={url} href={url} target="_blank" rel="noopener noreferrer">{url}</a>)}</dd></div>}
      {other.length > 0 && <div><dt>{en ? "Other identifiers" : "其他标识"}</dt><dd>{other.join(" · ")}</dd></div>}
      {tags.length > 0 && <div className="research-wide"><dt>{en ? "Tags" : "标签"}</dt><dd><ul className="tag-list">{tags.map(tag => <li key={tag}>{tag}</li>)}</ul></dd></div>}
    </dl>
  </details>;
}
