import { useState } from "react";
import type { CSSProperties } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronRight, Ellipsis, FolderTree, Layers, Pencil, Trash2 } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import { useResearchPermissions, confirmUnsavedChanges } from "@/features/research/useResearch";
import { objectUrl } from "@/features/research/model";
import type { Group, ResearchNode, ResearchObjectRef } from "@/features/research/model";
import { PendingObjectChanges } from "@/features/research/PendingObjectChanges";
import { ObjectContentWorkspace } from "../details/ObjectContentWorkspace";
import { ObjectRelations } from "../details/ObjectRelations";
import { InlineField, TagEditor } from "../details/InlineField";
import { kindColor, kindLabel } from "../model/nodeVisuals";
import { GroupEditor } from "./GroupEditor";
import { GroupMembers } from "./GroupMembers";
import { GroupDeleteDialog } from "./GroupDeleteDialog";
import { GroupParentDialog } from "./GroupParentDialog";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import "../details/details.css";

type Detail = { group: Group; coreRevision: number; blockCollectionRevision: number; blockCount: number; counts: { directNodes: number; childGroups: number; recursiveUniqueNodes: number }; pendingCandidates?: Record<string, unknown>[]; relations: { id: string; other: { object: ResearchObjectRef; label: string } }[] };

export function GroupDetailPage() { const { id } = useParams(); return <GroupDetail key={projectId() + ":" + id} />; }

function GroupDetail() {
  const { id } = useParams(), en = useUiStore(state => state.locale) === "en", client = useQueryClient(), navigate = useNavigate(), permissions = useResearchPermissions();
  const [editing, setEditing] = useState(false), [parent, setParent] = useState(false), [deleting, setDeleting] = useState(false);
  const query = useQuery({ queryKey: ["research-group", projectId(), id], queryFn: () => api<Detail>("/api/research-groups/" + encodeURIComponent(id!)) });
  const topology = useQuery({ queryKey: ["topology", projectId()], queryFn: () => api<{ nodes: ResearchNode[]; groups: Group[] }>("/api/topology") });
  const refresh = () => { for (const key of ["research-group", "topology", "group-members", "object-relations", "research-blocks"]) void client.invalidateQueries({ queryKey: [key, projectId()] }); };
  const home = <nav className="detail-breadcrumb" aria-label={en ? "Location" : "位置"}><Link to="/topology">{en ? "Research topology" : "科研拓扑"}</Link></nav>;
  if (query.isPending) return <section className="research-workspace research-detail detail-sheet">{home}<LoadingSkeleton layout="detail" heading label={en ? "Loading group…" : "载入节点组…"} /></section>;
  if (!query.data) return <section className="research-workspace research-detail detail-sheet">{home}<p role="alert">{query.error?.message ?? (en ? "Group not found." : "节点组不存在。")}<button className="button" onClick={() => void query.refetch()}>{en ? "Retry" : "重试"}</button></p></section>;
  const data = query.data, group = data.group, nodes = topology.data?.nodes ?? [], groups = topology.data?.groups ?? [], owner = { kind: "group" as const, id: group.id }, canEdit = permissions.nodes;
  const parentGroup = group.parentId ? groups.find(item => item.id === group.parentId) : undefined;
  const primary = [["incomingRelationId", en ? "Primary incoming" : "主入边"], ["outgoingRelationId", en ? "Primary outgoing" : "主出边"]] as const;
  const patchCore = async (patch: Record<string, unknown>) => { await api("/api/research-groups/" + encodeURIComponent(group.id) + "/core", { method: "PATCH", body: JSON.stringify({ patch, expectedCoreRevision: data.coreRevision }) }); refresh(); };
  return (
    <section translate="no" className="research-workspace research-detail detail-sheet group-detail is-group" style={{ "--kind": kindColor("group") } as CSSProperties}>
      <nav className="detail-breadcrumb" aria-label={en ? "Location" : "位置"}>
        <Link to="/topology">{en ? "Research topology" : "科研拓扑"}</Link>
        {group.parentId && <span><ChevronRight size={13} aria-hidden="true" /><Link to={objectUrl({ kind: "group", id: group.parentId })}>{parentGroup?.core.nodeName ?? group.parentId}</Link></span>}
        <span><ChevronRight size={13} aria-hidden="true" /><span aria-current="page">{group.core.nodeName}</span></span>
      </nav>
      {query.error && <p role="alert">{query.error.message}<button className="button" onClick={() => void query.refetch()}>{en ? "Retry" : "重试"}</button></p>}
      <header className="detail-header">
        <div className="detail-header-main">
          <span className="kind-mark"><Layers size={14} aria-hidden="true" />{kindLabel("group", en)}{group.core.category && <span className="relation-type">{group.core.category}</span>}</span>
          <InlineField as="h1" className="detail-title" value={group.core.nodeName} label={en ? "Group name" : "组名称"} required maxLength={240} canEdit={canEdit} en={en} onSave={value => patchCore({ nodeName: value })} />
          <InlineField className="detail-summary" value={group.core.summary ?? ""} label={en ? "Description" : "组说明"} placeholder={en ? "Add a description" : "添加组说明"} multiline maxLength={4000} canEdit={canEdit} en={en} onSave={value => patchCore({ summary: value })} />
          <TagEditor tags={group.core.tags ?? []} canEdit={canEdit} en={en} onSave={next => patchCore({ tags: next })} />
        </div>
        <div className="detail-header-actions">
          <Link className="button" to={"/topology?group=" + encodeURIComponent(group.id) + "&expand=1"}><Layers size={15} />{en ? "Focus in topology" : "在拓扑中聚焦"}</Link>
          {canEdit && <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild><button className="button detail-more" aria-label={en ? "More actions" : "更多操作"}><Ellipsis size={16} /></button></DropdownMenu.Trigger>
            <DropdownMenu.Portal><DropdownMenu.Content className="research-menu" align="end" sideOffset={6}>
              <DropdownMenu.Item className="research-menu-item" onSelect={() => { if (confirmUnsavedChanges()) setEditing(true); }}><Pencil size={15} />{en ? "Edit group" : "编辑组信息"}</DropdownMenu.Item>
              <DropdownMenu.Item className="research-menu-item" onSelect={() => setParent(true)}><FolderTree size={15} />{en ? "Change parent" : "调整上级组"}</DropdownMenu.Item>
              {permissions.deleteNodes && <><DropdownMenu.Separator className="research-menu-separator" /><DropdownMenu.Item className="research-menu-item is-danger" onSelect={() => setDeleting(true)}><Trash2 size={15} />{en ? "Delete group" : "删除节点组"}</DropdownMenu.Item></>}
            </DropdownMenu.Content></DropdownMenu.Portal>
          </DropdownMenu.Root>}
        </div>
      </header>
      <dl className="detail-facts">
        <div><dt>{en ? "Direct members" : "直接成员"}</dt><dd><strong>{data.counts.directNodes}</strong></dd></div>
        <div><dt>{en ? "Subgroups" : "子组"}</dt><dd><strong>{data.counts.childGroups}</strong></dd></div>
        <div><dt>{en ? "Unique nodes" : "范围内节点（去重）"}</dt><dd><strong>{data.counts.recursiveUniqueNodes}</strong></dd></div>
        <div><dt>{en ? "Parent group" : "上级组"}</dt><dd>{group.parentId
          ? <Link className="object-link" to={objectUrl({ kind: "group", id: group.parentId })}><Layers size={13} aria-hidden="true" /><span>{parentGroup?.core.nodeName ?? group.parentId}</span></Link>
          : <span>{en ? "Root level" : "根层级"}</span>}</dd></div>
      </dl>
      {primary.some(([field]) => group.primaryRelations[field]) && <div className="group-primary-path">{primary.map(([field, label]) => { const relation = data.relations.find(edge => edge.id === group.primaryRelations[field]); return relation && <Link key={field} to={objectUrl(relation.other.object)}><small>{label}</small><span>{relation.other.label}</span><ChevronRight size={15} /></Link>; })}</div>}
      <PendingObjectChanges candidates={data.pendingCandidates ?? []} owner={owner} en={en} empty={!data.blockCount && !data.counts.directNodes} />
      <ObjectContentWorkspace owner={owner} en={en} canEdit={canEdit} collectionRevision={data.blockCollectionRevision} onChanged={refresh}
        lead={<>
          <GroupMembers group={group} groups={groups} nodes={nodes} en={en} canEdit={canEdit} onChanged={refresh} />
          <h2 className="detail-section-title">{en ? "Research material" : "研究材料"}<span className="count">{data.blockCount}</span></h2>
        </>}
        rail={<div className="detail-rail-section"><ObjectRelations owner={owner} label={group.core.nodeName} en={en} canEdit={canEdit} primary={group.primaryRelations} relationRevision={group.relationRevision} onChanged={refresh} /></div>} />
      {editing && <GroupEditor group={{ ...group, coreRevision: data.coreRevision } as Group} groups={groups} nodes={nodes} en={en} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}
      {parent && <GroupParentDialog group={group} groups={groups} en={en} onClose={() => setParent(false)} onSaved={() => { setParent(false); refresh(); }} />}
      {deleting && <GroupDeleteDialog id={group.id} title={group.core.nodeName} en={en} onClose={() => setDeleting(false)} onDeleted={() => { refresh(); navigate("/topology"); }} />}
    </section>
  );
}
