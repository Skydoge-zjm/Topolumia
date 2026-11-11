import { useState } from "react";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pencil, Plus, UserMinus } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { objectUrl, text } from "@/features/research/model";
import type { Group, ResearchNode, ResearchObjectRef } from "@/features/research/model";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { ConfirmDialog } from "@/features/research/components/ConfirmDialog";
import { kindColor, kindIcon } from "../model/nodeVisuals";
type Entry = { entryType: "node" | "group"; object: ResearchObjectRef; label: string; kind?: string; status?: string; memberships?: { groupId: string; role?: string; note?: string }[]; omittedMemberships?: number };
type MemberPage = { data: { membershipRevision: number; items: Entry[] }; page: { total: number; nextCursor: string | null } };
const KINDS: Record<string, [string, string]> = { paper: ["文献", "Paper"], experiment: ["实验", "Experiment"], note: ["笔记", "Note"] };

/** Who is in the group: its own members and subgroups, or every node reached through subgroups. */
export function GroupMembers({ group, nodes, groups, en, canEdit, onChanged }: { group: Group; nodes: ResearchNode[]; groups: Group[]; en: boolean; canEdit: boolean; onChanged: () => void }) {
  const [scope, setScope] = useState("direct"), [search, setSearch] = useState(""), [adding, setAdding] = useState(false), [editing, setEditing] = useState<Entry | null>(null), [removing, setRemoving] = useState<Entry | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const base = "/api/research-groups/" + encodeURIComponent(group.id);
  const query = useInfiniteQuery({ queryKey: ["group-members", projectId(), group.id, scope, search], initialPageParam: "", queryFn: ({ pageParam }) => api<MemberPage>(base + "/members?" + new URLSearchParams({ scope, q: search, ...(pageParam ? { cursor: pageParam } : {}) })), getNextPageParam: page => page.page.nextCursor ?? undefined });
  const entries = query.data?.pages.flatMap(page => page.data.items) ?? [], membershipRevision = query.data?.pages[0]?.data.membershipRevision ?? group.membershipRevision;
  const total = query.data?.pages[0]?.page.total;
  const save = async (patch: unknown) => {
    setError(""); setNotice(""); setBusy(true);
    try {
      const result = await api<{ remainingInScope?: string[] }>(base + "/members", { method: "PATCH", body: JSON.stringify({ expectedMembershipRevision: membershipRevision, patch }) });
      if (result.remainingInScope?.length) setNotice(en ? "Removed the direct membership; this node is still included through a subgroup." : "已移除直接成员；该节点仍通过子组属于本组。");
      setAdding(false); setEditing(null); onChanged(); await query.refetch();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); throw cause; } finally { setBusy(false); }
  };
  const canMove = scope === "direct" && !search && !query.hasNextPage, memberIds = entries.filter(entry => entry.entryType === "node").map(entry => entry.object.id);
  const move = (id: string, offset: number) => { const ids = [...memberIds], index = ids.indexOf(id); [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]]; void save({ order: ids }).catch(() => {}); };
  const hasNote = entries.some(entry => entry.memberships?.[0]?.note), editable = canEdit && scope === "direct";
  return (
    <section className="group-members" translate="no">
      <header>
        <h2>{en ? "Members" : "成员"}{total !== undefined && <span className="count">{total}</span>}</h2>
        <nav className="segmented" aria-label={en ? "Membership scope" : "成员范围"}>
          <button className={scope === "direct" ? "is-active" : ""} aria-pressed={scope === "direct"} onClick={() => setScope("direct")}>{en ? "Direct members" : "直接成员与子组"}</button>
          <button className={scope === "recursive" ? "is-active" : ""} aria-pressed={scope === "recursive"} onClick={() => setScope("recursive")}>{en ? "All nodes" : "全部后代节点"}</button>
        </nav>
        <input className="group-members-search" type="search" aria-label={en ? "Search members" : "搜索成员"} placeholder={en ? "Find a member or role" : "搜索成员或角色"} value={search} onChange={event => setSearch(event.target.value)} />
        {canEdit && <button className="button primary" onClick={() => setAdding(true)}><Plus size={15} />{en ? "Add members" : "添加成员"}</button>}
      </header>
      {(error || query.error) && <p role="alert">{error || query.error?.message}<button className="button" onClick={() => { setError(""); onChanged(); void query.refetch(); }}>{en ? "Reload latest members" : "载入最新成员"}</button></p>}
      {notice && <p role="status" className="research-save-notice">{notice}</p>}
      {query.isPending ? <LoadingSkeleton layout="rows" label={en ? "Loading members…" : "载入成员…"} /> : entries.length > 0 && <div className="research-table-wrap"><table className="research-table group-members-table">
        <thead><tr>
          <th>{en ? "Name" : "名称"}</th>
          <th>{scope === "recursive" ? (en ? "Role and group" : "角色与所属组") : (en ? "Role" : "角色")}</th>
          <th>{en ? "Status" : "状态"}</th>
          {hasNote && <th>{en ? "Note" : "说明"}</th>}
          {editable && <th><span className="visually-hidden">{en ? "Actions" : "操作"}</span></th>}
        </tr></thead>
        <tbody>{entries.map(entry => {
          const index = memberIds.indexOf(entry.object.id), kind = entry.entryType === "group" ? "group" : entry.kind ?? "note", Icon = kindIcon(kind);
          return <tr key={entry.object.kind + entry.object.id}>
            <td><Link className="object-link" to={objectUrl(entry.object)} style={{ "--kind": kindColor(kind) } as CSSProperties} title={entry.entryType === "group" ? (en ? "Subgroup" : "子组") : KINDS[kind]?.[en ? 1 : 0] ?? kind}><Icon size={14} aria-hidden="true" /><span>{entry.label}</span></Link></td>
            <td>{entry.memberships?.map((membership, i) => <div key={membership.groupId + ":" + i}>{membership.role || <span className="run-ledger-none">—</span>}{scope === "recursive" && <> <Link className="count" to={objectUrl({ kind: "group", id: membership.groupId })}>{groups.find(item => item.id === membership.groupId)?.core.nodeName ?? membership.groupId}</Link></>}</div>)}{entry.omittedMemberships ? <span className="count">+{entry.omittedMemberships}</span> : null}</td>
            <td>{entry.status || nodes.find(node => node.id === entry.object.id)?.status || ""}</td>
            {hasNote && <td className="group-member-note">{entry.memberships?.[0]?.note ?? ""}</td>}
            {editable && <td>{entry.entryType === "node" && <div className="content-block-actions">
              <button className="research-icon-button" disabled={busy || !canMove || index <= 0} aria-label={en ? "Move member up" : "上移成员"} title={en ? "Move up" : "上移"} onClick={() => move(entry.object.id, -1)}><ArrowUp size={14} /></button>
              <button className="research-icon-button" disabled={busy || !canMove || index >= memberIds.length - 1} aria-label={en ? "Move member down" : "下移成员"} title={en ? "Move down" : "下移"} onClick={() => move(entry.object.id, 1)}><ArrowDown size={14} /></button>
              <button className="research-icon-button" disabled={busy} aria-label={en ? "Edit member" : "编辑成员"} title={en ? "Edit role and note" : "编辑角色与说明"} onClick={() => setEditing(entry)}><Pencil size={14} /></button>
              <button className="research-icon-button is-danger" disabled={busy} aria-label={en ? "Remove member from group" : "从组中移除成员"} title={en ? "Remove from group" : "从组中移除"} onClick={() => setRemoving(entry)}><UserMinus size={14} /></button>
            </div>}</td>}
          </tr>;
        })}</tbody>
      </table></div>}
      {!query.isPending && !query.error && !entries.length && <p className="research-empty">{search ? (en ? "No matching members." : "没有匹配的成员。") : (en ? "This group has no members yet." : "这个节点组还没有成员。")}</p>}
      {query.hasNextPage && <button className="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{en ? "Load more members" : "加载更多成员"}</button>}
      {adding && <AddMembers nodes={nodes} existing={groups.find(item => item.id === group.id)?.members.map(member => member.nodeId) ?? []} en={en} saving={busy} onSave={ids => save({ add: ids.map(nodeId => ({ nodeId })) })} onClose={() => setAdding(false)} />}
      {editing && <EditMember entry={editing} en={en} saving={busy} onClose={() => setEditing(null)} onSave={(role, note) => save({ update: [{ nodeId: editing.object.id, role, note }] })} />}
      {removing && <ConfirmDialog en={en} title={(en ? "Remove from group: " : "从组中移除：") + removing.label} confirmLabel={en ? "Remove member" : "移除成员"} onClose={() => setRemoving(null)} onConfirm={async () => { await save({ remove: [removing.object.id] }); setRemoving(null); }}>
        <p>{en ? "The node itself, its material and its relations are kept." : "科研节点本身及其材料、关系都会保留。"}</p>
      </ConfirmDialog>}
    </section>
  );
}
function AddMembers({nodes,existing,en,saving,onSave,onClose}:{nodes:ResearchNode[];existing:string[];en:boolean;saving:boolean;onSave:(ids:string[])=>Promise<void>;onClose:()=>void}){
  const [search,setSearch]=useState(""),[page,setPage]=useState(0),[selected,setSelected]=useState<string[]>([]),[error,setError]=useState("");const filtered=nodes.filter(node=>!existing.includes(node.id)&&text(node.label,en).toLowerCase().includes(search.toLowerCase()));
  return <ResearchDialog title={en?"Add members":"添加成员"}  onClose={onClose}><form className="research-form" onSubmit={async event=>{event.preventDefault();try{await onSave(selected);}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}}}><label>{en?"Find nodes":"查找节点"}<input autoFocus value={search} onChange={event=>{setSearch(event.target.value);setPage(0);}}/></label><div className="research-member-list">{filtered.slice(page*20,page*20+20).map(node=><label key={node.id}><input type="checkbox" checked={selected.includes(node.id)} onChange={event=>setSelected(event.target.checked?[...selected,node.id]:selected.filter(id=>id!==node.id))}/><span>{text(node.label,en)}<small>{node.kind}</small></span></label>)}</div><div className="group-pagination"><button type="button" className="button" disabled={!page} onClick={()=>setPage(page-1)}>{en?"Previous":"上一页"}</button><span>{selected.length} {en?"selected":"个已选"}</span><button type="button" className="button" disabled={(page+1)*20>=filtered.length} onClick={()=>setPage(page+1)}>{en?"Next":"下一页"}</button></div>{error&&<p role="alert">{error}</p>}<footer><button type="button" className="button" onClick={onClose}>{en?"Cancel":"取消"}</button><button className="button primary" disabled={!selected.length||saving}>{en?"Add selected members":"加入所选成员"}</button></footer></form></ResearchDialog>;
}
function EditMember({entry,en,saving,onSave,onClose}:{entry:Entry;en:boolean;saving:boolean;onSave:(role:string,note:string)=>Promise<void>;onClose:()=>void}){
  const [role,setRole]=useState(entry.memberships?.[0]?.role??""),[note,setNote]=useState(entry.memberships?.[0]?.note??""),[error,setError]=useState("");
  return <ResearchDialog title={(en?"Edit member: ":"编辑成员：")+entry.label}  onClose={onClose}><form className="research-form" onSubmit={async event=>{event.preventDefault();try{await onSave(role,note);}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}}}><label>{en?"Role (optional)":"成员角色（可选）"}<input maxLength={120} value={role} placeholder={en?"baseline, control, variant…":"例如：基线、对照、变体"} onChange={event=>setRole(event.target.value)}/></label><label>{en?"Note (optional)":"成员说明（可选）"}<textarea maxLength={2000} rows={4} value={note} onChange={event=>setNote(event.target.value)}/></label>{error&&<p role="alert">{error}</p>}<footer><button type="button" className="button" onClick={onClose}>{en?"Cancel":"取消"}</button><button className="button primary" disabled={saving}>{en?"Save member":"保存成员"}</button></footer></form></ResearchDialog>;
}
