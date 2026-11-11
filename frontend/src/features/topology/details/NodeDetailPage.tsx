import { useState } from "react";
import type { CSSProperties } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronRight, Ellipsis, Layers, Pencil, Trash2 } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import { useResearchPermissions, confirmUnsavedChanges } from "@/features/research/useResearch";
import { nodeUrl, objectUrl, text } from "@/features/research/model";
import type { Group, ResearchNode } from "@/features/research/model";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { RunStatusCounts, RunStrip } from "@/features/experiments/RunStrip";
import { NodeDeleteDialog } from "./NodeDeleteDialog";
import { NodeCoreEditor } from "./NodeCoreEditor";
import { ObjectContentWorkspace } from "./ObjectContentWorkspace";
import type { ContentBlock } from "./ContentBlockRenderer";
import { ObjectRelations } from "./ObjectRelations";
import { PendingObjectChanges } from "@/features/research/PendingObjectChanges";
import { PaperBibliography, PaperCitation } from "./PaperBibliography";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { NoteBodyWorkspace } from "./NoteBodyWorkspace";
import { InlineField, TagEditor } from "./InlineField";
import { kindColor, kindIcon, kindLabel } from "../model/nodeVisuals";
import "./details.css";

type Detail = { node: ResearchNode; core: Record<string, any>; bodyBlockId?: string | null; pendingCandidates?: Record<string, unknown>[]; contentBlocks: ContentBlock[]; relations: unknown[]; groupCount?: number; nodeRevision: number; coreRevision: number; blockCollectionRevision: number };

export function NodeDetailPage() { const { id } = useParams(), [params] = useSearchParams(); return <NodeDetail key={id || "new:" + (params.get("kind") || "")} />; }

function Breadcrumb({ en, groups = [], current }: { en: boolean; groups?: Group[]; current?: string }) {
  return (
    <nav className="detail-breadcrumb" aria-label={en ? "Location" : "位置"}>
      <Link to="/topology">{en ? "Research topology" : "科研拓扑"}</Link>
      {groups.slice(0, 1).map(group => <span key={group.id}><ChevronRight size={13} aria-hidden="true" /><Link to={objectUrl({ kind: "group", id: group.id })}>{group.core.nodeName}</Link></span>)}
      {current && <span><ChevronRight size={13} aria-hidden="true" /><span aria-current="page">{current}</span></span>}
    </nav>
  );
}

function NodeDetail() {
  const { id } = useParams(), [params] = useSearchParams(), en = useUiStore(state => state.locale) === "en", permissions = useResearchPermissions(), client = useQueryClient(), navigate = useNavigate();
  const [editingCore, setEditingCore] = useState(false), [deleting, setDeleting] = useState(false);
  const query = useQuery({ queryKey: ["research-node", projectId(), id], enabled: Boolean(id), queryFn: () => api<Detail>("/api/research-nodes/" + encodeURIComponent(id!)) });
  const topology = useQuery({ queryKey: ["topology", projectId()], enabled: Boolean(id), queryFn: () => api<{ nodes: ResearchNode[]; groups: Group[] }>("/api/topology") });
  const kind = query.data?.node.kind ?? params.get("kind") ?? "note";
  const hasRecords = kind === "experiment" && Boolean(query.data?.contentBlocks.some(block => block.type === "experimentRecord"));
  const experiment = useQuery({ queryKey: ["experiment-runs", projectId(), id], enabled: Boolean(id) && hasRecords, queryFn: () => api<{ runs: { id: string; status: string }[]; collections: unknown[] }>("/api/research-nodes/" + encodeURIComponent(id!) + "/experiment") });
  const refresh = () => { void client.invalidateQueries({ queryKey: ["research-node", projectId(), id] }); void client.invalidateQueries({ queryKey: ["topology", projectId()] }); for (const key of ["experiment-runs", "experiment-data-overview", "experiment-data-metrics", "experiment-data-table"]) void client.invalidateQueries({ queryKey: [key, projectId(), id] }); void client.invalidateQueries({ queryKey: ["research-experiments", projectId()] }); void client.invalidateQueries({ queryKey: ["experiment-record-plot", projectId(), id] }); void client.invalidateQueries({ queryKey: ["temporary-experiment-compare", projectId()] }); };
  if (id && query.isPending) return <section className="research-workspace research-detail detail-sheet"><Breadcrumb en={en} /><LoadingSkeleton layout="detail" heading label={en ? "Loading research node…" : "载入科研节点…"} /></section>;
  if (id && !query.data) return <section className="research-workspace research-detail detail-sheet"><Breadcrumb en={en} /><p role="alert">{query.error?.message ?? (en ? "Research node not found." : "科研节点不存在。")}<button className="button" onClick={() => void query.refetch()}>{en ? "Retry" : "重试"}</button></p></section>;
  if (!id) return <NewNodePage kind={kind} en={en} onSaved={nextId => navigate(nodeUrl(nextId))} onCancel={() => navigate("/topology")} />;
  const data = query.data!, owner = { kind: "node" as const, id }, paper = kind === "paper", canEdit = permissions.nodes;
  const bodyBlock = kind === "note" ? data.contentBlocks.find(block => block.id === data.bodyBlockId) : undefined;
  const name = String(data.core.nodeName ?? "") || text(data.node.label, en);
  const title = (paper && typeof data.core.paperTitle === "string" ? data.core.paperTitle.trim() : "") || name;
  const summary = String(data.core.summary ?? "").trim() || (paper ? "" : text(data.node.summary, en));
  const tags: string[] = Array.isArray(data.core.tags) ? data.core.tags : [];
  const groups = (topology.data?.groups ?? []).filter(group => group.members.some(member => member.nodeId === id));
  const patchCore = async (patch: Record<string, unknown>) => { await api("/api/research-nodes/" + encodeURIComponent(id) + "/core", { method: "PATCH", body: JSON.stringify({ patch, expectedCoreRevision: data.coreRevision }) }); refresh(); };
  const Icon = kindIcon(kind), runs = experiment.data?.runs ?? [];
  return (
    <section translate="no" className={"research-workspace research-detail detail-sheet is-" + kind} style={{ "--kind": kindColor(kind) } as CSSProperties}>
      <Breadcrumb en={en} groups={groups} current={name} />
      {query.error && <p role="alert">{query.error.message}<button className="button" onClick={() => void query.refetch()}>{en ? "Retry" : "重试"}</button></p>}
      <header className="detail-header">
        <div className="detail-header-main">
          <span className="kind-mark"><Icon size={14} aria-hidden="true" />{kindLabel(kind, en)}</span>
          {paper
            ? <h1 className="detail-title" title={title}>{title}</h1>
            : <InlineField as="h1" className="detail-title" value={name} label={en ? "Node name" : "节点名称"} required maxLength={240} canEdit={canEdit} en={en} onSave={value => patchCore({ nodeName: value })} />}
          {paper && title !== name && <p className="detail-alias">{name}</p>}
          {paper && <PaperCitation core={data.core} en={en} />}
          {!paper && <InlineField className="detail-summary" value={summary} label={en ? "Summary" : "摘要"} placeholder={en ? "Add a summary" : "添加摘要"} multiline maxLength={2000} canEdit={canEdit} en={en} onSave={value => patchCore({ summary: value })} />}
          <TagEditor tags={tags} canEdit={canEdit} en={en} onSave={next => patchCore({ tags: next })} />
        </div>
        {(canEdit || permissions.deleteNodes) && <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><button className="button detail-more" aria-label={en ? "More actions" : "更多操作"}><Ellipsis size={16} /></button></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content className="research-menu" align="end" sideOffset={6}>
            {canEdit && <DropdownMenu.Item className="research-menu-item" onSelect={() => { if (confirmUnsavedChanges()) setEditingCore(true); }}><Pencil size={15} />{en ? "Edit core" : "编辑核心信息"}</DropdownMenu.Item>}
            {permissions.deleteNodes && <DropdownMenu.Item className="research-menu-item is-danger" onSelect={() => setDeleting(true)}><Trash2 size={15} />{en ? "Delete node" : "删除节点"}</DropdownMenu.Item>}
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>}
      </header>
      {paper && <PaperBibliography core={data.core} en={en} initialExpanded={!data.contentBlocks.length && !data.pendingCandidates?.length} />}
      {hasRecords && runs.length > 0 && <dl className="experiment-overview">
        <div><dt>{en ? "Runs" : "运行"}</dt><dd><strong>{runs.length}</strong><RunStrip runs={runs} en={en} max={24} /></dd></div>
        <div><dt>{en ? "Status" : "状态"}</dt><dd><RunStatusCounts runs={runs} en={en} /></dd></div>
        <div><dt>{en ? "Record blocks" : "记录块"}</dt><dd><strong>{experiment.data?.collections.length ?? 0}</strong></dd></div>
      </dl>}
      <PendingObjectChanges candidates={data.pendingCandidates ?? []} owner={owner} en={en} empty={!data.contentBlocks.length} />
      <ObjectContentWorkspace owner={owner} en={en} canEdit={canEdit} collectionRevision={data.blockCollectionRevision} initialBlocks={data.contentBlocks as never[]} hiddenBlockIds={bodyBlock ? [bodyBlock.id] : []} nodeKind={kind} onChanged={refresh}
        lead={kind === "note" ? <NoteBodyWorkspace owner={owner} block={bodyBlock} collectionRevision={data.blockCollectionRevision} en={en} canEdit={canEdit} onChanged={refresh} /> : undefined}
        rail={<>
          <div className="detail-rail-section"><ObjectRelations owner={owner} label={title} en={en} canEdit={canEdit} onChanged={refresh} /></div>
          {groups.length > 0 && <div className="detail-rail-section">
            <h2>{en ? "In groups" : "所属节点组"}<span className="count">{groups.length}</span></h2>
            <ul className="detail-group-list">{groups.map(group => <li key={group.id}><Link className="object-link" to={objectUrl({ kind: "group", id: group.id })} style={{ "--kind": kindColor("group") } as CSSProperties}><Layers size={13} aria-hidden="true" /><span>{group.core.nodeName}</span></Link></li>)}</ul>
          </div>}
        </>} />
      {editingCore && <ResearchDialog title={en ? "Edit core information" : "编辑核心信息"} onClose={() => { if (confirmUnsavedChanges()) setEditingCore(false); }}>
        <NodeCoreEditor kind={kind} initial={data.core} en={en} onSave={async core => { await patchCore(core); setEditingCore(false); }} onCancel={() => setEditingCore(false)} />
      </ResearchDialog>}
      {deleting && <NodeDeleteDialog id={id} title={title} nodeRevision={data.nodeRevision} relationCount={data.relations.length} groupCount={data.groupCount ?? 0} en={en} onClose={() => setDeleting(false)} onReload={async () => { const result = await query.refetch(); if (result.error) throw result.error; }} onDeleted={historyId => { void client.invalidateQueries({ queryKey: ["topology"] }); void client.invalidateQueries({ queryKey: ["research-node", projectId(), id] }); navigate(historyId ? "/records/history/" + historyId : "/records"); }} />}
    </section>
  );
}

function NewNodePage({ kind, en, onSaved, onCancel }: { kind: string; en: boolean; onSaved: (id: string) => void; onCancel: () => void }) {
  const Icon = kindIcon(kind);
  return (
    <section translate="no" className="research-workspace research-detail detail-sheet is-new" style={{ "--kind": kindColor(kind) } as CSSProperties}>
      <Breadcrumb en={en} />
      <header className="detail-header"><div className="detail-header-main"><span className="kind-mark"><Icon size={14} aria-hidden="true" />{kindLabel(kind, en)}</span><h1 className="detail-title">{en ? "New research node" : "新建科研节点"}</h1></div></header>
      <NodeCoreEditor kind={kind} initial={{ nodeName: "" }} en={en} composeBody={kind === "note"} onSave={async (core, body) => {
        const result = await api<{ node: { id: string } }>("/api/research-nodes", { method: "POST", body: JSON.stringify({ kind, core, body }) });
        onSaved(result.node.id);
      }} onCancel={onCancel} />
    </section>
  );
}
