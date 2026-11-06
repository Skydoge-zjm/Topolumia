import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { objectUrl, text } from "@/features/research/model";
import type { ResearchObjectRef, ResearchNode, Group } from "@/features/research/model";
import { sameObject } from "@domain/research/object-ref";
import { RelationEditor } from "./RelationEditor";
import type { ResearchRelation } from "./RelationEditor";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";

type RelationsPage = { data: { items: { relation: ResearchRelation }[] }; page: { nextCursor: string | null; total: number } };
export function ObjectRelations({ owner, label, en, canEdit, onChanged, primary, relationRevision }: { owner: ResearchObjectRef; label: string; en: boolean; canEdit: boolean; onChanged: () => void; primary?: Group["primaryRelations"]; relationRevision?: number }) {
  const [scope, setScope] = useState("direct"), [editor, setEditor] = useState<ResearchRelation | true | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), client = useQueryClient();
  const topology = useQuery({ queryKey: ["topology", projectId()], queryFn: () => api<{ nodes: ResearchNode[]; groups: Group[] }>("/api/topology") });
  const query = useInfiniteQuery({ queryKey: ["object-relations", projectId(), owner, scope], initialPageParam: "", queryFn: ({ pageParam }) => api<RelationsPage>("/api/research-relations?" + new URLSearchParams({ object: JSON.stringify(owner), scope, ...(pageParam ? { cursor: pageParam } : {}) })), getNextPageParam: page => page.page.nextCursor ?? undefined });
  const objectInfo = (ref: ResearchObjectRef) => ref.kind === "group" ? { label: topology.data?.groups.find(group => group.id === ref.id)?.core.nodeName ?? ref.id, revision: topology.data?.groups.find(group => group.id === ref.id)?.revision } : { label: text(topology.data?.nodes.find(node => node.id === ref.id)?.label, en) || ref.id, revision: Number(topology.data?.nodes.find(node => node.id === ref.id)?.data?.researchRevision ?? 1) };
  const changed = () => { void client.invalidateQueries({ queryKey: ["object-relations", projectId()] }); void client.invalidateQueries({ queryKey: ["topology", projectId()] }); onChanged(); };
  const run = async (action: () => Promise<unknown>) => { setBusy(true); setError(""); try { await action(); changed(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  const relations = query.data?.pages.flatMap(page => page.data.items.map(item => item.relation)) ?? [];
  return <section className="research-card group-relations" translate="no"><header className="research-section-heading"><div><h2>{en ? "Research relations" : "科研关系"}</h2></div>{canEdit && <button className="button" onClick={() => setEditor(true)}><Plus size={15} />{en ? "Add relation" : "添加关系"}</button>}</header>
    {owner.kind === "group" && <nav className="research-tabs" aria-label={en ? "Relation scope" : "关系范围"}><button className={scope === "direct" ? "is-active" : ""} onClick={() => setScope("direct")}>{en ? "Group relations" : "组的直接关系"}</button><button className={scope === "groupBoundary" ? "is-active" : ""} onClick={() => setScope("groupBoundary")}>{en ? "Members to outside" : "成员对外关系"}</button></nav>}
    {(error || query.error) && <p role="alert">{error || query.error?.message}<button className="button" onClick={() => { setError(""); changed(); }}>{en ? "Reload" : "载入最新关系"}</button></p>}
    {query.isPending && <LoadingSkeleton layout="rows" label={en ? "Loading relations…" : "载入关系…"} />}
    {relations.map(edge => { const incoming = sameObject(edge.to, owner), field = incoming ? "incomingRelationId" : "outgoingRelationId", selected = primary?.[field] === edge.id; return <article className="group-relation-row" key={edge.id}>
      <div className="group-relation-path"><Link to={objectUrl(edge.from)}>{objectInfo(edge.from).label}</Link><span className="research-badge">{text(edge.label, en) || edge.type}</span><span aria-hidden="true">→</span><Link to={objectUrl(edge.to)}>{objectInfo(edge.to).label}</Link>{selected && <span className="group-primary-label"><Star size={13} />{incoming ? en ? "Primary incoming" : "主入边" : en ? "Primary outgoing" : "主出边"}</span>}</div>
      {canEdit && <div className="content-block-actions">{owner.kind === "group" && scope === "direct" && <button className="button" disabled={busy} onClick={() => void run(() => api("/api/research-groups/" + encodeURIComponent(owner.id) + "/primary-relations", { method: "PATCH", body: JSON.stringify({ expectedRelationRevision: relationRevision, patch: { [field]: selected ? null : edge.id } }) }))}>{incoming ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}{selected ? en ? "Clear primary" : "取消主边" : incoming ? en ? "Make primary incoming" : "设为主入边" : en ? "Make primary outgoing" : "设为主出边"}</button>}<button className="research-icon-button" disabled={busy} aria-label={en ? "Edit relation" : "编辑关系"} onClick={() => setEditor(edge)}><Pencil size={14} /></button><button className="research-icon-button" disabled={busy} aria-label={en ? "Delete relation" : "删除关系"} onClick={() => { if (!window.confirm(en ? "Delete this relation?" : "删除这条关系？")) return; void run(() => api("/api/research-relations/" + encodeURIComponent(edge.id), { method: "DELETE", body: JSON.stringify({ expectedRevision: edge.revision, expectedEndpointRevisions: [edge.from, edge.to].map(object => ({ object, revision: objectInfo(object).revision })) }) })); }}><Trash2 size={14} /></button></div>}
    </article>; })}
    {!query.isPending && !query.error && !relations.length && <p className="research-empty">{en ? "No relations in this scope." : "当前范围尚无关系。"}</p>}{query.hasNextPage && <button className="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{en ? "Load more relations" : "加载更多关系"}</button>}
    {editor && <RelationEditor owner={owner} label={label} en={en} initial={editor === true ? undefined : editor} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); changed(); }} />}
  </section>;
}
