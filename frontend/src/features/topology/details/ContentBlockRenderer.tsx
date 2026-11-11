import type { ResearchObjectRef } from "@/features/research/model";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { renderMarkdown } from "@/shared/lib/markdown";
import { safeUrl } from "@/features/research/model";
import { ChevronDown, Download, ExternalLink, FileText } from "lucide-react";
import { AssetTablePreview } from "./AssetTablePreview";
import { ExperimentRecordBlock } from "./ExperimentRecordBlock";
import { AssetTextPreview } from "./AssetTextPreview";
import { ChartBlock } from "./ChartBlock";
import { CodeView } from "./CodeView";
import { ImageFigure } from "./ImageFigure";
import { MetricView } from "./MetricView";
import "./details.css";

export type ContentBlock = {
  id: string;
  owner?: ResearchObjectRef;
  title: string;
  type: string;
  role?: "body";
  order: number;
  payload: any;
  assetIds?: string[];
  sourceRefs?: any[];
  review?: string;
  revision: number;
  excerpt?: string;
  representations?: any[];
  primaryRepresentationId?: string;
};

const TEXT_FILE = /\.(md|txt|json|jsonl|yaml|yml|toml|ini|cfg|py|sh|ps1|log|out|tex|r|sql|js|ts)$/i;
const TABLE_FILE = /\.(tex|xlsx|csv)$/i;
const roleLabels: Record<string, [string, string]> = { source: ["原始来源", "Original"], transcription: ["转录数据", "Transcription"], rendering: ["排版版本", "Rendering"], supplement: ["补充材料", "Supplement"] };
const assetHref = (id: string) => "/api/research-assets/" + encodeURIComponent(id) + "/content?projectId=" + encodeURIComponent(projectId());
function fileSize(bytes?: number) {
  if (!bytes || !Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"]; let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return (value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)) + " " + units[unit];
}

export function ContentBlockRenderer({ block, en, owner, candidateId }: { block: ContentBlock; en: boolean; owner: ResearchObjectRef; assetUrl?: (id: string) => string; candidateId?: string }) {
  const reps = block.representations ?? [];
  const hasInline = Boolean(block.payload && (["richText", "metric", "link", "quote", "code", "chart", "experimentRecord"].includes(block.type) || block.type === "table" && block.payload.columns?.length));
  const defaultView = block.primaryRepresentationId || (hasInline ? "inline" : reps[0]?.id);
  const [selected, setSelected] = useState<string | undefined>();
  const current = selected && (selected === "inline" || reps.some(rep => rep.id === selected)) ? selected : defaultView;
  const representation = reps.find(rep => rep.id === current);
  // An experiment record manages its own source files; they are not alternative views of the block.
  const options = block.type === "experimentRecord" ? [] : [...(hasInline ? [{ value: "inline", label: en ? "Content" : "内容数据", role: "" }] : []), ...reps.map(rep => ({ value: rep.id as string, label: (rep.label || rep.url || roleLabels[rep.role]?.[en ? 1 : 0] || rep.kind) as string, role: rep.role as string }))];
  return (
    <div translate="no" className="content-block-body" data-block-type={block.type}>
      {options.length > 1 && <div className="representation-tabs" role="tablist" aria-label={en ? "Content representation" : "内容表示方式"}>
        {options.map(option => (
          <button key={option.value} type="button" role="tab" aria-selected={(current ?? options[0].value) === option.value} title={option.label} onClick={() => setSelected(option.value)}>
            <span>{option.label}</span>{option.role && roleLabels[option.role] && option.label !== roleLabels[option.role][en ? 1 : 0] && <small>{roleLabels[option.role][en ? 1 : 0]}</small>}
          </button>
        ))}
      </div>}
      {representation
        ? representation.kind === "link"
          ? <LinkCard url={representation.url} label={representation.label} en={en} />
          : <AssetRepresentation key={representation.id} block={block} representation={representation} owner={owner} en={en} candidateId={candidateId} />
        : <InlineContent block={block} owner={owner} en={en} candidateId={candidateId} />}
    </div>
  );
}

function LinkCard({ url, label, kind, note, en }: { url?: string; label?: string; kind?: string; note?: string; en: boolean }) {
  const href = safeUrl(url ?? "");
  if (!href) return <p className="research-hint">{url || (en ? "No address recorded." : "尚未填写链接地址。")}</p>;
  const host = new URL(href).host.replace(/^www\./, "");
  return (
    <div className="link-card">
      <a href={href} target="_blank" rel="noopener noreferrer">
        <ExternalLink size={15} aria-hidden="true" />
        <span className="link-card-label">{label || href}</span>
      </a>
      <span className="link-card-host">{host}</span>
      {kind && <span className="relation-type">{kind}</span>}
      {note && <p>{note}</p>}
    </div>
  );
}

/** One line identifying a stored file; the original is always one click away. */
function FileRow({ href, name, mediaType, bytes, en, children }: { href: string; name: string; mediaType?: string; bytes?: number; en: boolean; children?: React.ReactNode }) {
  return (
    <div className="file-row">
      <FileText size={16} aria-hidden="true" />
      <span className="file-row-name" title={name}>{name}</span>
      <span className="file-row-meta">{[fileSize(bytes), mediaType && !/octet-stream/.test(mediaType) ? mediaType.split("/").pop() : ""].filter(Boolean).join(" · ")}</span>
      {children}
      <a className="content-block-file" href={href} download aria-label={(en ? "Download " : "下载 ") + name} title={en ? "Download original" : "下载原文件"}><Download size={15} /></a>
    </div>
  );
}

function AssetRepresentation({ block, representation, owner, en, candidateId }: { block: ContentBlock; representation: any; owner: ResearchObjectRef; en: boolean; candidateId?: string }) {
  const id = representation.assetId, query = useQuery({ queryKey: ["research-asset", projectId(), id], queryFn: () => api<any>("/api/research-assets/" + encodeURIComponent(id)) });
  // Text sources of a few screens open by default; documents open on request so a long node stays scannable.
  const [open, setOpen] = useState<boolean | null>(null);
  const asset = query.data?.asset, href = assetHref(id), name: string = asset?.originalName || representation.label || (en ? "File" : "文件");
  if (query.isPending) return <p role="status" className="research-hint">{en ? "Loading file…" : "正在读取文件…"}</p>;
  if (query.error) return <p role="alert">{query.error.message}<button className="button" onClick={() => void query.refetch()}>{en ? "Retry" : "重试"}</button></p>;
  if (asset?.mediaType?.startsWith("image/")) return <ImageFigure src={href} alt={block.payload?.alt || block.title} caption={block.payload?.caption || (representation.label !== name ? representation.label : undefined)} locator={block.payload?.locator} en={en} />;
  if (TABLE_FILE.test(name)) return <div><AssetTablePreview candidateId={candidateId} owner={owner} assetId={id} en={en} blockId={block.id} blockRevision={block.revision} representationId={representation.id} originalName={name} />{block.type === "table" && block.payload?.caption && <p className="content-block-caption">{block.payload.caption}</p>}</div>;
  const pdf = asset?.mediaType === "application/pdf", textFile = TEXT_FILE.test(name) || /^text\//.test(asset?.mediaType ?? "");
  if (!pdf && !textFile) return <FileRow href={href} name={name} mediaType={asset?.mediaType} bytes={asset?.sizeBytes} en={en} />;
  const shown = open ?? (textFile && (asset?.sizeBytes ?? 0) <= 24_000);
  return (
    <div className="file-preview">
      <FileRow href={href} name={name} mediaType={asset?.mediaType} bytes={asset?.sizeBytes} en={en}>
        <button type="button" className="file-row-toggle" aria-expanded={shown} onClick={() => setOpen(!shown)}>{shown ? (en ? "Hide preview" : "收起预览") : (en ? "Preview" : "预览")}<ChevronDown size={14} /></button>
      </FileRow>
      {shown && (pdf
        ? <iframe className="file-preview-pdf" title={block.title} src={href} />
        : <AssetTextPreview assetId={id} checksum={asset.checksum} filename={name} en={en} />)}
    </div>
  );
}

function InlineContent({ block, en, owner, candidateId }: { block: ContentBlock; en: boolean; owner: ResearchObjectRef; candidateId?: string }) {
  const p = block.payload ?? {};
  if (block.type === "experimentRecord") return <ExperimentRecordBlock block={block} owner={owner} en={en} candidateId={candidateId} />;
  if (block.type === "richText") return !String(p.body ?? "").trim()
    ? <p className="research-hint">{en ? "Nothing written yet." : "尚未填写内容。"}</p>
    : p.format === "plain" ? <div className="research-pre-wrap research-prose">{p.body}</div> : <div className="agent-markdown research-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.body, { en }) }} />;
  if (block.type === "metric") return <MetricView items={p.items ?? []} en={en} />;
  if (block.type === "table" && p.columns) return <div><AssetTablePreview candidateId={candidateId} owner={owner} en={en} blockId={block.id} blockRevision={block.revision} table={{ schemaVersion: "research-table-preview.v1", columns: p.columns, rows: p.rows, sourceFormat: p.sourceFormat ?? "manual", totalRows: p.rows.length, truncated: false, grid: p.grid }} />{p.caption && <p className="content-block-caption">{p.caption}</p>}</div>;
  if (block.type === "link") return <LinkCard url={p.url} label={p.label} kind={p.kind} note={p.note} en={en} />;
  if (block.type === "quote") return (
    <figure className={"content-block-quote" + (p.translation ? " has-translation" : "")}>
      <blockquote><p>{p.text}</p></blockquote>
      {p.translation && <div className="content-block-quote-translation"><p>{p.translation}</p></div>}
      {p.note && <figcaption>{p.note}</figcaption>}
    </figure>
  );
  if (block.type === "code") return <CodeView code={String(p.code ?? "")} language={p.language} filename={p.filename} en={en} />;
  if (block.type === "chart") return <ChartBlock payload={p} owner={owner} en={en} />;
  return <p className="research-hint">{block.excerpt || (en ? "No file attached to this block yet." : "这个内容块还没有附加文件。")}</p>;
}
