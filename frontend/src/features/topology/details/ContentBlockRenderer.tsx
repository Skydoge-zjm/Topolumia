import type { ResearchObjectRef } from "@/features/research/model";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { renderMarkdown } from "@/shared/lib/markdown";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { ExternalLink, FileCode2, FileText, Table2 } from "lucide-react";
import { AssetTablePreview } from "./AssetTablePreview";
import { ExperimentRecordBlock } from "./ExperimentRecordBlock";
import { AssetTextPreview } from "./AssetTextPreview";

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

export function ContentBlockRenderer({ block, en, owner, assetUrl, candidateId }: { block: ContentBlock; en: boolean; owner: ResearchObjectRef; assetUrl?: (id: string) => string; candidateId?: string }) {
  const reps=block.representations ?? [];
  const hasInline=Boolean(block.payload && (["richText","metric","link","quote","code","chart","experimentRecord"].includes(block.type) || block.type==="table" && block.payload.columns?.length));
  const defaultView=block.primaryRepresentationId || (hasInline ? "inline" : reps[0]?.id);
  const [selected,setSelected]=useState<string | undefined>();
  const current=selected && (selected === "inline" || reps.some(r=>r.id===selected)) ? selected : defaultView;
  const representation=reps.find(r=>r.id===current);
  const options=block.type==="experimentRecord" ? [] : [...(hasInline ? [{value:"inline",label:en?"Content":"内容数据"}] : []),...reps.map(r=>({value:r.id,label:r.label || r.role || r.kind}))];
  return <div translate="no">{options.length>1 && <SelectMenu ariaLabel={en?"Content representation":"内容表示方式"} value={current || options[0].value} onChange={setSelected} options={options} />}{representation ? representation.kind==="link" ? <a className="content-block-link" href={representation.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15}/>{representation.label || representation.url}</a> : <AssetRepresentation block={block} representation={representation} owner={owner} en={en} candidateId={candidateId} /> : <InlineContent block={block} owner={owner} en={en} assetUrl={assetUrl} candidateId={candidateId} />}</div>;
}
function AssetRepresentation({block,representation,owner,en,candidateId}:{block:ContentBlock;representation:any;owner: ResearchObjectRef;en:boolean;candidateId?:string}){
  const id=representation.assetId,query=useQuery({queryKey:["research-asset",projectId(),id],queryFn:()=>api<any>("/api/research-assets/"+encodeURIComponent(id))});
  const a=query.data?.asset,href="/api/research-assets/"+encodeURIComponent(id)+"/content?projectId="+encodeURIComponent(projectId());
  if(query.isPending)return <p role="status">{en?"Loading file…":"正在读取文件…"}</p>;
  if(query.error)return <p role="alert">{query.error.message}</p>;
  if(a?.mediaType?.startsWith("image/"))return <figure className="content-block-image"><a href={href} target="_blank" rel="noopener noreferrer" aria-label={en?"Open original image":"查看原图"} title={en?"Open original image":"查看原图"}><img src={href} alt={block.payload?.alt || block.title} loading="lazy"/></a><figcaption>{block.payload?.caption || representation.label}</figcaption></figure>;
  if(/\.(tex|xlsx|csv)$/i.test(a?.originalName ?? ""))return <div><AssetTablePreview candidateId={candidateId} owner={owner} assetId={id} en={en} blockId={block.id} blockRevision={block.revision} representationId={representation.id} originalName={a.originalName}/>{block.type==="table" && block.payload?.caption && <p className="research-hint">{block.payload.caption}</p>}</div>;
  if(a?.mediaType==="application/pdf")return <div><iframe title={block.title} src={href} style={{width:"100%",height:560,border:0}}/><a href={href}>{en?"Download PDF":"下载 PDF"}</a></div>;
  if(/\.(md|txt|json|jsonl|yaml|yml|toml|ini|cfg|py|sh|ps1|log|out)$/i.test(a?.originalName ?? ""))return <div><AssetTextPreview assetId={id} checksum={a.checksum} en={en}/><a className="content-block-file" href={href}><FileText size={16}/>{a.originalName}</a></div>;
  return <a className="content-block-file" href={href}><FileText size={16}/>{a?.originalName || representation.label || (en?"Download file":"下载文件")}</a>;
}
function InlineContent({block,en,owner,candidateId}: {block:ContentBlock;en:boolean;owner: ResearchObjectRef;assetUrl?: (id:string)=>string;candidateId?:string}){
  const p=block.payload ?? {};
  if(block.type==="experimentRecord")return <ExperimentRecordBlock block={block} owner={owner} en={en} candidateId={candidateId} />;
  if(block.type==="richText")return p.format==="plain" ? <div className="research-pre-wrap">{p.body || "—"}</div> : <div className="agent-markdown" dangerouslySetInnerHTML={{__html:renderMarkdown(p.body || "", { en })}}/>;
  if(block.type==="metric")return <div className="research-table-scroll"><table><thead><tr><th>{en?"Metric":"指标"}</th><th>{en?"Value":"数值"}</th><th>{en?"Condition":"条件"}</th></tr></thead><tbody>{(p.items ?? []).map((item:any,index:number)=><tr key={index}><td>{item.name}</td><td>{String(item.value)} {item.unit}</td><td>{[item.split,item.condition].filter(Boolean).join(" · ")}</td></tr>)}</tbody></table></div>;
  if(block.type==="table" && p.columns)return <div><AssetTablePreview candidateId={candidateId} owner={owner} en={en} blockId={block.id} blockRevision={block.revision} table={{schemaVersion:"research-table-preview.v1",columns:p.columns,rows:p.rows,sourceFormat:p.sourceFormat ?? "manual",totalRows:p.rows.length,truncated:false,grid:p.grid}}/>{p.caption && <p className="research-hint">{p.caption}</p>}</div>;
  if(block.type==="link")return <a className="content-block-link" href={p.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15}/>{p.label || p.url}</a>;
  if(block.type==="quote")return <blockquote className="content-block-quote"><p>{p.text}</p>{p.translation && <p>{p.translation}</p>}<small>{p.note}</small></blockquote>;
  if(block.type==="code")return <pre className="content-block-code"><code>{p.code}</code></pre>;
  if(block.type==="chart")return <div className="content-block-placeholder"><Table2 size={16}/>{en?"Chart rendering is not available yet.":"图表渲染尚未实现。"}</div>;
  return <div className="content-block-placeholder"><FileCode2 size={16}/>{block.excerpt || (en?"Select a file representation.":"请选择文件表示。")}</div>;
}
