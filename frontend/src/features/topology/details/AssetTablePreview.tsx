import type { ResearchObjectRef } from "@/features/research/model";
import { useQuery } from "@tanstack/react-query";
import { Download, FileSpreadsheet } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { PresentedTable } from "./PresentedTable";
import type { TablePreview } from "./PresentedTable";

type PreviewResponse = { preview: TablePreview | null; asset: { originalName: string; mediaType: string; processing?: string; compiled?: { state: string; pdf?: string | boolean; image?: string | boolean; error?: string } }; error: string | null };

export function AssetTablePreview({ owner, assetId, en, blockId, table, blockRevision, representationId, originalName: suppliedName, candidateId }: { owner: ResearchObjectRef; assetId?: string; en: boolean; blockId?: string; blockRevision?: number; representationId?: string; table?: TablePreview; originalName?: string; candidateId?: string }) {
  const [selection, setSelection] = useState<{ assetId?: string; view: string } | null>(null);
  const query = useQuery({
    queryKey: ["research-asset-preview", projectId(), owner, assetId],
    enabled: Boolean(assetId),
    queryFn: () => api<PreviewResponse>("/api/research-assets/" + encodeURIComponent(assetId!) + "/preview"),
    retry: false,
    refetchInterval: query => ["queued","running"].includes(query.state.data?.asset.processing ?? "") ? 500 : false,
  });
  const preview = table && (table.grid || table.sourceFormat === "manual") ? table : query.data?.preview ?? table;
  const originalName = suppliedName ?? query.data?.asset.originalName;
  const assetBase = assetId ? "/api/research-assets/" + encodeURIComponent(assetId) : "";
  const projectQuery = "projectId=" + encodeURIComponent(projectId());
  const assetHref = assetBase ? assetBase + "/content?" + projectQuery : "";
  const compiled = query.data?.asset.compiled;
  const hasCompiledPreview = compiled?.state === "ready" && Boolean(compiled.image || compiled.pdf);
  const hasRenderedPreview = hasCompiledPreview || Boolean(preview?.grid);
  const selectedView = hasRenderedPreview ? (selection && selection.assetId === assetId ? selection.view : "rendered") : "data";
  if (query.isPending && !table) return <p role="status" className="content-block-processing">{en ? "Preparing table preview…" : "正在准备表格预览…"}</p>;
  if (!preview && ["queued","running"].includes(query.data?.asset.processing ?? "")) return <p role="status">{en?"Preparing file preview…":"正在生成文件预览…"}</p>;
  if (!preview) return <div className="content-block-import-error"><p>{query.data?.error || query.error?.message || (en ? "This file has no table preview. The original is preserved." : "无法预览此文件中的表格，原文件仍已保存。")}</p>{assetHref && <a className="button" href={assetHref}><Download size={14} />{en ? "Download original" : "下载原文件"}</a>}</div>;
  const dataPreview = preview.grid ? {
    ...preview,
    grid: {
      ...preview.grid,
      rowHeights: undefined,
      cells: preview.grid.cells.map(row => row.map(cell => ({ ...cell, text: undefined, style: undefined, runs: undefined }))),
    },
  } : preview;
  return <Tabs.Root className="imported-table-preview" value={selectedView} onValueChange={view => setSelection({ assetId, view })}>
    <header><span><FileSpreadsheet size={15} />{originalName || (en ? "Imported table" : "导入的表格")}</span><span>{preview.sheetName || preview.sourceFormat.toUpperCase()}{preview.truncated ? (en ? " · preview limited" : " · 仅预览部分行") : ""}</span></header>
    {hasRenderedPreview && <Tabs.List className="table-preview-tabs" aria-label={en ? "Table display mode" : "表格展示方式"}>
      <Tabs.Trigger value="rendered">{en ? "Rendered preview" : "渲染预览"}</Tabs.Trigger>
      <Tabs.Trigger value="data">{en ? "Table data" : "表格数据"}</Tabs.Trigger>
    </Tabs.List>}
    {compiled?.state === "failed" && <p className="research-warning">{compiled.error}</p>}
    {hasRenderedPreview && <Tabs.Content value="rendered" className="table-preview-panel">
      {hasCompiledPreview ? <div className="compiled-tex-preview">{compiled?.image ? <a href={assetBase + "/content?variant=compiledPdf&" + projectQuery} target="_blank" rel="noopener noreferrer"><img src={assetBase + "/content?variant=previewImage&" + projectQuery} alt={en ? "Compiled TeX table" : "TeX 编译表格预览"} /></a> : <a href={assetBase + "/content?variant=compiledPdf&" + projectQuery} target="_blank" rel="noopener noreferrer">{en ? "Open compiled PDF" : "查看编译后的 PDF"}</a>}</div> : <PresentedTable preview={preview} en={en} />}
    </Tabs.Content>}
    <Tabs.Content value="data" className="table-preview-panel"><PresentedTable preview={dataPreview} en={en} /></Tabs.Content>
    {preview.grid?.warnings?.map(warning => <p className="research-hint" key={warning}>{warning}</p>)}
    <footer><span>{preview.totalRows} {en ? "rows" : "行"}</span><div>{assetHref && <a href={assetHref}><Download size={14} />{en ? "Original" : "原文件"}</a>}{compiled?.state === "ready" && <a href={assetBase + "/content?variant=compiledPdf&" + projectQuery} target="_blank" rel="noopener noreferrer"><Download size={14} />PDF</a>}{blockId && <><TableExport candidateId={candidateId} owner={owner} blockId={blockId} revision={blockRevision} representationId={representationId} format="xlsx" en={en}/><TableExport candidateId={candidateId} owner={owner} blockId={blockId} revision={blockRevision} representationId={representationId} format="tex" en={en}/></>}</div></footer>
  </Tabs.Root>;
}
import { useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";

function TableExport({owner,blockId,revision,representationId,format,en,candidateId}:{owner: ResearchObjectRef;blockId:string;revision?:number;representationId?:string;format:string;en:boolean;candidateId?:string}){
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  return <span><button type="button" className="button" disabled={busy || revision===undefined} onClick={async()=>{setBusy(true);setError("");try{const input={target:{kind:"block",owner,blockId,expectedRevision:revision,representationId,candidateId},variant:format,idempotencyKey:crypto.randomUUID()};let result:any;for(let i=0;i<120;i++){result=await api<any>("/api/research/exports",{method:"POST",body:JSON.stringify(input)});if(result.data.status==="ready")break;await new Promise(resolve=>setTimeout(resolve,500));}if(result.data.status!=="ready")throw new Error(en?"Export is still processing.":"导出仍在处理中，请稍后重试。");const anchor=document.createElement("a");anchor.href=result.data.contentPath+"&projectId="+encodeURIComponent(projectId());anchor.download="";anchor.click();}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setBusy(false);}}}><Download size={14}/>{busy?"…":format.toUpperCase()}</button>{error && <small role="alert">{error}</small>}</span>;
}
