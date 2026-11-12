import { useState } from "react";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { objectUrl, text } from "@/features/research/model";
import type { ResearchObjectRef, ResearchNode, Group } from "@/features/research/model";
import { ConfirmDialog } from "@/features/research/components/ConfirmDialog";
import { sameObject } from "@domain/research/object-ref";
import { RelationEditor } from "./RelationEditor";
import type { ResearchRelation } from "./RelationEditor";
import { relationTypeLabel } from "./relationTypes";
import { kindColor, kindIcon } from "../model/nodeVisuals";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";

type RelationsPage = { data: { items: { relation: ResearchRelation }[] }; page: { nextCursor: string | null; total: number } };

/** Every relation reads from this object's side: direction, what the relation says, and the other object. */
export function ObjectRelations({ owner, label, en, canEdit, onChanged, primary, relationRevision }: { owner: ResearchObjectRef; label: string; en: boolean; canEdit: boolean; onChanged: () => void; primary?: Group["primaryRelations"]; relationRevision?: number }) {
  const [scope, setScope] = useState("direct"), [editor, setEditor] = useState<ResearchRelation | true | null>(null), [removing, setRemoving] = useState<ResearchRelation | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), client = useQueryClient();
  const topology = useQuery({ queryKey: ["topology", projectId()], queryFn: () => api<{ nodes: ResearchNode[]; groups: Group[] }>("/api/topology") });
  const query = useInfiniteQuery({ queryKey: ["object-relations", projectId(), owner, scope], initialPageParam: "", queryFn: ({ pageParam }) => api<RelationsPage>("/api/research-relations?" + new URLSearchParams({ object: JSON.stringify(owner), scope, ...(pageParam ? { cursor: pageParam } : {}) })), getNextPageParam: page => page.page.nextCursor ?? undefined });
  const objectInfo = (ref: ResearchObjectRef) => {
    if (ref.kind === "group") { const group = topology.data?.groups.find(item => item.id === ref.id); return { label: group?.core.nodeName ?? ref.id, revision: group?.revision, kind: "group" }; }
    const node = topology.data?.nodes.find(item => item.id === ref.id);
    return { label: text(node?.label, en) || ref.id, revision: Number(node?.data?.researchRevision ?? 1), kind: node?.kind ?? "note" };
  };
  const changed = () => { void client.invalidateQueries({ queryKey: ["object-relations", projectId()] }); void client.invalidateQueries({ queryKey: ["topology", projectId()] }); onChanged(); };
  const run = async (action: () => Promise<unknown>) => { setBusy(true); setError(""); try { await action(); changed(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  const relations = query.data?.pages.flatMap(page => page.data.items.map(item => item.relation)) ?? [];
  const total = query.data?.pages[0]?.page.total ?? relations.length;
  const ObjectLink = ({ object }: { object: ResearchObjectRef }) => { const info = objectInfo(object), Icon = kindIcon(info.kind); return <Link className="object-link" to={objectUrl(object)} style={{ "--kind": kindColor(info.kind) } as CSSProperties}><Icon size={13} aria-hidden="true" /><span>{info.label}</span></Link>; };
  return (
    <section className="object-relations group-relations" translate="no">
      <header className="detail-rail-heading"><h2>{en ? "Research relations" : "科研关系"}{!query.isPending && <span className="count">{total}</span>}</h2>{canEdit && <button className="button" onClick={() => setEditor(true)}><Plus size={14} />{en ? "Add relation" : "添加关系"}</button>}</header>
      {owner.kind === "group" && <nav className="segmented" aria-label={en ? "Relation scope" : "关系范围"}><button className={scope === "direct" ? "is-active" : ""} aria-pressed={scope === "direct"} onClick={() => setScope("direct")}>{en ? "Group relations" : "组的直接关系"}</button><button className={scope === "groupBoundary" ? "is-active" : ""} aria-pressed={scope === "groupBoundary"} onClick={() => setScope("groupBoundary")}>{en ? "Members to outside" : "成员对外关系"}</button></nav>}
      {(error || query.error) && <p role="alert">{error || query.error?.message}<button className="button" onClick={() => { setError(""); changed(); }}>{en ? "Reload" : "载入最新关系"}</button></p>}
      {query.isPending && <LoadingSkeleton layout="rows" label={en ? "Loading relations…" : "载入关系…"} />}
      <ul className="relation-list">{relations.map(edge => {
        // A member's relation is read as written; the owner's own relations are read from its side.
        const own = sameObject(edge.from, owner) || sameObject(edge.to, owner), incoming = sameObject(edge.to, owner);
        const field = incoming ? "incomingRelationId" : "outgoingRelationId", selected = primary?.[field] === edge.id;
        const name = text(edge.label, en) || relationTypeLabel(edge.type, en);
        return <li className="relation-row group-relation-row" key={edge.id}>
          <div className="relation-row-path group-relation-path">
            {own
              ? <>{incoming ? <ArrowLeft size={14} className="relation-direction" aria-label={en ? "from" : "来自"} /> : <ArrowRight size={14} className="relation-direction" aria-label={en ? "to" : "指向"} />}<span className="relation-type">{name}</span><ObjectLink object={incoming ? edge.from : edge.to} /></>
              : <><ObjectLink object={edge.from} /><span className="relation-type">{name}</span><ArrowRight size={14} className="relation-direction" aria-hidden="true" /><ObjectLink object={edge.to} /></>}
            {selected && <span className="group-primary-label"><Star size={12} />{incoming ? en ? "Primary incoming" : "主入边" : en ? "Primary outgoing" : "主出边"}</span>}
          </div>
          {canEdit && <div className="relation-row-actions">
            {owner.kind === "group" && scope === "direct" && <button className="button" disabled={busy} onClick={() => void run(() => api("/api/research-groups/" + encodeURIComponent(owner.id) + "/primary-relations", { method: "PATCH", body: JSON.stringify({ expectedRelationRevision: relationRevision, patch: { [field]: selected ? null : edge.id } }) }))}>{selected ? en ? "Clear primary" : "取消主边" : incoming ? en ? "Make primary incoming" : "设为主入边" : en ? "Make primary outgoing" : "设为主出边"}</button>}
            <button className="research-icon-button" disabled={busy} aria-label={en ? "Edit relation" : "编辑关系"} title={en ? "Edit relation" : "编辑关系"} onClick={() => setEditor(edge)}><Pencil size={14} /></button>
            <button className="research-icon-button is-danger" disabled={busy} aria-label={en ? "Delete relation" : "删除关系"} title={en ? "Delete relation" : "删除关系"} onClick={() => setRemoving(edge)}><Trash2 size={14} /></button>
          </div>}
        </li>;
      })}</ul>
      {!query.isPending && !query.error && !relations.length && <p className="research-hint">{owner.kind === "group" && scope !== "direct" ? (en ? "No member relations cross the group boundary." : "没有成员与组外对象的关系。") : (en ? "Not connected to other objects yet." : "尚未与其他对象建立关系。")}</p>}
      {query.hasNextPage && <button className="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{en ? "Load more relations" : "加载更多关系"}</button>}
      {editor && <RelationEditor owner={owner} label={label} en={en} initial={editor === true ? undefined : editor} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); changed(); }} />}
      {removing && <ConfirmDialog en={en} title={en ? "Delete relation" : "删除关系"} confirmLabel={en ? "Delete relation" : "删除关系"} onClose={() => setRemoving(null)}
        onConfirm={async () => { await api("/api/research-relations/" + encodeURIComponent(removing.id), { method: "DELETE", body: JSON.stringify({ expectedRevision: removing.revision, expectedEndpointRevisions: [removing.from, removing.to].map(object => ({ object, revision: objectInfo(object).revision })) }) }); setRemoving(null); changed(); }}>
        <p className="relation-row-path"><span>{objectInfo(removing.from).label}</span><span className="relation-type">{text(removing.label, en) || relationTypeLabel(removing.type, en)}</span><ArrowRight size={14} aria-hidden="true" /><span>{objectInfo(removing.to).label}</span></p>
        <p className="research-hint">{en ? "Both objects are kept." : "两端的对象都会保留。"}</p>
      </ConfirmDialog>}
    </section>
  );
}
