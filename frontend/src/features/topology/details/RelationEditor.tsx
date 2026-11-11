import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { text } from "@/features/research/model";
import type { ResearchObjectRef, ResearchNode, Group } from "@/features/research/model";
import { objectKey, sameObject } from "@domain/research/object-ref";
import { relationTypes as types } from "./relationTypes";

export type ResearchRelation = { id: string; from: ResearchObjectRef; to: ResearchObjectRef; type: string; label?: string | { zh?: string; en?: string }; revision: number };
export function RelationEditor({ owner, label, en, initial, initialTarget, onClose, onSaved }: { owner: ResearchObjectRef; label: string; en: boolean; initial?: ResearchRelation; initialTarget?: ResearchObjectRef; onClose: () => void; onSaved: () => void }) {
  const query = useQuery({ queryKey: ["topology", projectId()], queryFn: () => api<{ nodes: ResearchNode[]; groups: Group[] }>("/api/topology") });
  const [target, setTarget] = useState(initialTarget ? objectKey(initialTarget) : ""), [search, setSearch] = useState(""), [type, setType] = useState(initial?.type ?? "supports"), [direction, setDirection] = useState("out"), [description, setDescription] = useState(text(initial?.label, en)), [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const objects = [...(query.data?.nodes ?? []).map(node => ({ object: { kind: "node", id: node.id } as ResearchObjectRef, label: text(node.label, en), revision: Number(node.data?.researchRevision ?? 1) })), ...(query.data?.groups ?? []).map(group => ({ object: { kind: "group", id: group.id } as ResearchObjectRef, label: group.core.nodeName, revision: group.revision }))];
  return <ResearchDialog title={(en ? initial ? "Edit relation: " : "Add research relation: " : initial ? "编辑关系：" : "添加科研关系：")+label}  onClose={onClose}><form className="research-form" onSubmit={async event => {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const other = objects.find(item => objectKey(item.object) === target)?.object;
      const from = initial?.from ?? (direction === "out" ? owner : other), to = initial?.to ?? (direction === "out" ? other : owner);
      if (!from || !to) throw new Error(en ? "Choose an object." : "请选择关联对象。");
      const expectedEndpointRevisions = [from, to].map(object => ({ object, revision: objects.find(item => sameObject(item.object, object))?.revision }));
      await api("/api/research-relations" + (initial ? "/" + encodeURIComponent(initial.id) : ""), { method: initial ? "PATCH" : "POST", body: JSON.stringify(initial ? { expectedRevision: initial.revision, expectedEndpointRevisions, patch: { type, label: description } } : { from, to, type, label: description, expectedEndpointRevisions }) }); onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setSaving(false); }
  }}>
    {!initial && <><label>{en ? "Find an object" : "查找关联对象"}<input value={search} onChange={event => setSearch(event.target.value)} /></label><label>{en ? "Related object" : "关联对象"}<SelectMenu ariaLabel={en ? "Related object" : "关联对象"} value={target} onChange={setTarget} options={[{value:"",label:en?"Choose a node or group":"选择节点或节点组"},...objects.filter(item=>!sameObject(item.object,owner)&&item.label.toLowerCase().includes(search.toLowerCase())).map(item=>({value:objectKey(item.object),label:item.label+(item.object.kind==="group"?(en?" · group":" · 节点组"):"")}))]} /></label><label>{en ? "Direction" : "关系方向"}<SelectMenu ariaLabel={en?"Relation direction":"关系方向"} value={direction} onChange={setDirection} options={[{value:"out",label:en?"Current → related":"当前对象 → 关联对象"},{value:"in",label:en?"Related → current":"关联对象 → 当前对象"}]} /></label></>}
    <label>{en?"Relation type":"关系类型"}<SelectMenu ariaLabel={en?"Relation type":"关系类型"} value={type} onChange={setType} options={Object.entries({...types,...(!types[type]?{[type]:[type,type] as [string,string]}:{})}).map(([value,labels])=>({value,label:labels[en?1:0]}))} /></label>
    <label>{en?"Description":"关系说明"}<input maxLength={240} value={description} onChange={event=>setDescription(event.target.value)} /></label>
    {(error || query.error) && <p role="alert">{error || query.error?.message}</p>}<footer><button type="button" className="button" onClick={onClose}>{en?"Cancel":"取消"}</button><button className="button primary" disabled={saving || query.isPending || (!initial&&!target)}>{en?"Save relation":"保存关系"}</button></footer>
  </form></ResearchDialog>;
}
