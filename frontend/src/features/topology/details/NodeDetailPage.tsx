import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import { useResearchPermissions } from "@/features/research/useResearch";
import { nodeUrl, text } from "@/features/research/model";
import type { ResearchNode } from "@/features/research/model";
import { nodeKinds } from "@domain/research/node-fields";
import { NodeDeleteDialog } from "./NodeDeleteDialog";
import { NodeCoreEditor } from "./NodeCoreEditor";
import { ExperimentRunsPanel } from "@/features/experiments/ExperimentRunsPanel";
import { ObjectContentWorkspace } from "./ObjectContentWorkspace";
import type { ContentBlock } from "./ContentBlockRenderer";
import { ObjectRelations } from "./ObjectRelations";
import { PendingObjectChanges } from "@/features/research/PendingObjectChanges";
import { PaperBibliography, PaperCitation } from "./PaperBibliography";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { NoteBodyWorkspace } from "./NoteBodyWorkspace";

type Detail = { node: ResearchNode; core: Record<string, any>; bodyBlockId?: string | null; pendingCandidates?: Record<string, unknown>[]; contentBlocks: ContentBlock[]; relations: unknown[]; groupCount?: number; nodeRevision: number; coreRevision: number; blockCollectionRevision: number };

export function NodeDetailPage() { const { id } = useParams(), [params] = useSearchParams(); return <NodeDetail key={id || "new:" + (params.get("kind") || "")} />; }

function NodeDetail() {
  const { id } = useParams(), [params, setParams] = useSearchParams(), en = useUiStore(state => state.locale) === "en", permissions = useResearchPermissions(), client = useQueryClient(), navigate = useNavigate();
  const [editingCore, setEditingCore] = useState(false), [deleting, setDeleting] = useState(false);
  const tab = ["content", "runs", "relations"].includes(params.get("tab") ?? "") ? params.get("tab")! : "content", setTab = (value: string) => setParams(current => { const next = new URLSearchParams(current); next.set("tab", value); return next; }, { replace: true });
  const query = useQuery({ queryKey: ["research-node", projectId(), id], enabled: Boolean(id), queryFn: () => api<Detail>("/api/research-nodes/" + encodeURIComponent(id!)) });
  const kind = query.data?.node.kind ?? params.get("kind") ?? "note";
  const refresh = () => { void client.invalidateQueries({ queryKey: ["research-node", projectId(), id] }); void client.invalidateQueries({ queryKey: ["topology", projectId()] }); void client.invalidateQueries({ queryKey: ["experiment-runs", projectId(), id] }); void client.invalidateQueries({ queryKey: ["research-experiments", projectId()] }); void client.invalidateQueries({ queryKey: ["experiment-record-plot", projectId(), id] }); void client.invalidateQueries({ queryKey: ["temporary-experiment-compare", projectId()] }); };
  if (id && query.isPending) return <section className="research-workspace research-detail"><Link className="research-back" to="/topology">← {en ? "Research topology" : "科研拓扑"}</Link><LoadingSkeleton layout="detail" heading label={en ? "Loading research node…" : "载入科研节点…"} /></section>;
  if (id && !query.data) return <section className="research-workspace research-detail"><p role="alert">{query.error?.message ?? (en ? "Research node not found." : "科研节点不存在。")}</p><button className="button" onClick={() => void query.refetch()}>{en ? "Retry" : "重试"}</button><Link to="/topology">{en ? "Back to topology" : "返回拓扑"}</Link></section>;
  if (!id) return <NewNodePage kind={kind} en={en} onSaved={nextId => navigate(nodeUrl(nextId))} onCancel={() => navigate("/topology")} />;
  const data = query.data!, owner = { kind: "node" as const, id }, paper = kind === "paper";
  const bodyBlock = kind === "note" ? data.contentBlocks.find(block => block.id === data.bodyBlockId) : undefined;
  const title = (paper && typeof data.core.paperTitle === "string" ? data.core.paperTitle.trim() : "") || data.core.nodeName || text(data.node.label, en);
  const summary = String(data.core.summary ?? "").trim() || text(data.node.summary, en);
  const saveCore = async (core: Record<string, any>) => { await api("/api/research-nodes/" + encodeURIComponent(id) + "/core", { method: "PATCH", body: JSON.stringify({ patch: core, expectedCoreRevision: data.coreRevision }) }); setEditingCore(false); refresh(); };
  if (editingCore) return <section translate="no" className="research-workspace research-detail"><button className="research-back button" onClick={() => setEditingCore(false)}>← {en ? "Research node" : "科研节点"}</button><header className="research-page-heading"><h1>{en ? "Edit core information" : "编辑核心信息"}</h1></header><NodeCoreEditor kind={kind} initial={data.core} en={en} onSave={saveCore} onCancel={() => setEditingCore(false)} /></section>;
  return <section translate="no" className="research-workspace research-detail"><Link className="research-back" to="/topology">← {en ? "Research topology" : "科研拓扑"}</Link>
    {query.error && <p role="alert">{query.error.message}<button className="button" onClick={() => void query.refetch()}>{en ? "Retry" : "重试"}</button></p>}
    <header className="research-page-heading"><div className="research-detail-title"><h1>{title}</h1>
      {paper && <PaperCitation core={data.core} en={en} />}
    </div><div className="research-actions"><span className="research-badge">{en ? nodeKinds[kind]?.en ?? kind : nodeKinds[kind]?.label ?? kind}</span>{permissions.nodes && <button className="button" onClick={() => setEditingCore(true)}><Pencil size={15} />{en ? "Edit core" : "编辑核心信息"}</button>}</div></header>
    {paper
      ? <PaperBibliography core={data.core} en={en} initialExpanded={!data.contentBlocks.length && !data.pendingCandidates?.length} />
      : summary && <section className="research-card research-core-summary"><p>{summary}</p></section>}
    <nav className="research-tabs" aria-label={en ? "Node workspace" : "节点工作区"}>{[{ value: "content", label: en ? "Research material" : "研究材料" }, ...(kind === "experiment" ? [{ value: "runs", label: en ? "Runs and materials" : "运行与关联" }] : []), { value: "relations", label: en ? "Relations" : "关系与来源" }].map(item => <button key={item.value} className={tab === item.value ? "is-active" : ""} onClick={() => setTab(item.value)}>{item.label}</button>)}</nav>
    <PendingObjectChanges candidates={data.pendingCandidates ?? []} owner={owner} en={en} empty={!data.contentBlocks.length} />
    {Array.isArray(data.core.tags) && data.core.tags.length > 0 && <div className="research-inline-facts">{data.core.tags.map((tag: string) => <span className="research-badge" key={tag}>{tag}</span>)}</div>}
    {tab === "content" && <>{kind === "note" && <NoteBodyWorkspace owner={owner} block={bodyBlock} collectionRevision={data.blockCollectionRevision} en={en} canEdit={permissions.nodes} onChanged={refresh} />}<ObjectContentWorkspace owner={owner} en={en} canEdit={permissions.nodes} collectionRevision={data.blockCollectionRevision} initialBlocks={data.contentBlocks as never[]} hiddenBlockIds={bodyBlock ? [bodyBlock.id] : []} nodeKind={kind} onChanged={refresh} /></>}
    {tab === "runs" && kind === "experiment" && <ExperimentRunsPanel nodeId={id} blocks={data.contentBlocks} en={en} canEdit={permissions.nodes} onChanged={refresh} />}
    {tab === "relations" && <ObjectRelations owner={owner} label={title} en={en} canEdit={permissions.nodes} onChanged={refresh} />}
    {permissions.deleteNodes && <div className="research-delete-section"><button className="button" onClick={() => setDeleting(true)}>{en ? "Delete node" : "删除节点"}</button></div>}
    {deleting && <NodeDeleteDialog id={id} title={title} nodeRevision={data.nodeRevision} relationCount={data.relations.length} groupCount={data.groupCount ?? 0} en={en} onClose={() => setDeleting(false)} onReload={async () => { const result = await query.refetch(); if (result.error) throw result.error; }} onDeleted={historyId => { void client.invalidateQueries({ queryKey: ["topology"] }); void client.invalidateQueries({ queryKey: ["research-node", projectId(), id] }); navigate(historyId ? "/records/history/" + historyId : "/records"); }} />}
  </section>;
}
function NewNodePage({ kind, en, onSaved, onCancel }: { kind: string; en: boolean; onSaved: (id: string) => void; onCancel: () => void }) {
  return <section translate="no" className="research-workspace research-detail"><Link className="research-back" to="/topology">← {en ? "Research topology" : "科研拓扑"}</Link><header className="research-page-heading"><h1>{en ? "New research node" : "新建科研节点"}</h1></header><NodeCoreEditor kind={kind} initial={{ nodeName: "" }} en={en} composeBody={kind === "note"} onSave={async (core, body) => {
    const result = await api<{ node: { id: string } }>("/api/research-nodes", { method: "POST", body: JSON.stringify({ kind, core, body }) });
    onSaved(result.node.id);
  }} onCancel={onCancel} /></section>;
}
