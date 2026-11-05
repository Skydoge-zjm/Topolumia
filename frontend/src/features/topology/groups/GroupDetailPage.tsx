import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Layers, Pencil } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import { useResearchPermissions } from "@/features/research/useResearch";
import { objectUrl } from "@/features/research/model";
import type { Group, ResearchNode, ResearchObjectRef } from "@/features/research/model";
import { PendingObjectChanges } from "@/features/research/PendingObjectChanges";
import { ObjectContentWorkspace } from "../details/ObjectContentWorkspace";
import { ObjectRelations } from "../details/ObjectRelations";
import { GroupEditor } from "./GroupEditor";
import { GroupMembers } from "./GroupMembers";
import { GroupDeleteDialog } from "./GroupDeleteDialog";
import { GroupParentDialog } from "./GroupParentDialog";
type Detail={group:Group;coreRevision:number;blockCollectionRevision:number;blockCount:number;counts:{directNodes:number;childGroups:number;recursiveUniqueNodes:number};pendingCandidates?:Record<string,unknown>[];relations:{id:string;other:{object:ResearchObjectRef;label:string}}[]};
export function GroupDetailPage(){const{id}=useParams();return <GroupDetail key={projectId()+":"+id}/>;}
function GroupDetail(){
  const{id}=useParams(),[params,setParams]=useSearchParams(),en=useUiStore(state=>state.locale)==="en",client=useQueryClient(),navigate=useNavigate(),permissions=useResearchPermissions();
  const[editing,setEditing]=useState(false),[parent,setParent]=useState(false),[deleting,setDeleting]=useState(false);
  const query=useQuery({queryKey:["research-group",projectId(),id],queryFn:()=>api<Detail>("/api/research-groups/"+encodeURIComponent(id!))});
  const topology=useQuery({queryKey:["topology",projectId()],queryFn:()=>api<{nodes:ResearchNode[];groups:Group[]}>("/api/topology")});
  const refresh=()=>{for(const key of ["research-group","topology","group-members","object-relations","research-blocks"])void client.invalidateQueries({queryKey:[key,projectId()]});};
  if(query.isPending)return <p className="loading" role="status">{en?"Loading group…":"载入节点组…"}</p>;
  if(query.error||!query.data)return <section className="research-workspace"><p role="alert">{query.error?.message??(en?"Group not found.":"节点组不存在。")}</p><Link to="/topology">{en?"Back to topology":"返回拓扑"}</Link></section>;
  const data=query.data,group=data.group,nodes=topology.data?.nodes??[],groups=topology.data?.groups??[],owner={kind:"group" as const,id:group.id},tab=params.get("tab")??"members";
  const primary=[["incomingRelationId",en?"Primary incoming":"主入边"],["outgoingRelationId",en?"Primary outgoing":"主出边"]] as const;
  return <section translate="no" className="research-workspace research-detail group-detail"><Link className="research-back" to="/topology">← {en?"Research topology":"科研拓扑"}</Link>
    <header className="research-page-heading"><div><h1>{group.core.nodeName}</h1></div><div className="research-actions"><Link className="button" to={"/topology?group="+encodeURIComponent(group.id)+"&expand=1"}><Layers size={15}/>{en?"Focus in topology":"在拓扑中聚焦"}</Link>{permissions.nodes&&<button className="button" onClick={()=>setEditing(true)}><Pencil size={15}/>{en?"Edit group":"编辑组信息"}</button>}</div></header>
    <dl className="research-field-details research-card"><div><dt>{en?"Category":"分类"}</dt><dd>{group.core.category||"—"}</dd></div><div><dt>{en?"Direct members":"直接成员"}</dt><dd>{data.counts.directNodes}</dd></div><div><dt>{en?"Subgroups":"子组"}</dt><dd>{data.counts.childGroups}</dd></div><div><dt>{en?"Unique nodes":"范围内节点（去重）"}</dt><dd>{data.counts.recursiveUniqueNodes}</dd></div>{group.core.summary&&<div className="research-wide"><dt>{en?"Summary":"摘要"}</dt><dd>{group.core.summary}</dd></div>}{Boolean(group.core.tags?.length)&&<div><dt>{en?"Tags":"标签"}</dt><dd>{group.core.tags?.join(" · ")}</dd></div>}</dl><div className="group-navigation"><span>{en?"Parent: ":"上级组："}</span>{group.parentId?<Link to={objectUrl({kind:"group",id:group.parentId})}>{groups.find(item=>item.id===group.parentId)?.core.nodeName??group.parentId}</Link>:<span>{en?"Root level":"根层级"}</span>}{permissions.nodes&&<button className="button" onClick={()=>setParent(true)}>{en?"Change parent":"调整上级组"}</button>}</div>
    {primary.some(([field])=>group.primaryRelations[field])&&<div className="group-primary-path">{primary.map(([field,label])=>{const relation=data.relations.find(edge=>edge.id===group.primaryRelations[field]);return relation&&<Link key={field} to={objectUrl(relation.other.object)}><small>{label}</small><span>{relation.other.label}</span><ChevronRight size={15}/></Link>;})}</div>}
    <nav className="research-tabs" aria-label={en?"Group workspace":"节点组工作区"}>{[{value:"members",label:en?"Members":"成员"},{value:"content",label:en?"Research material":"研究材料"},{value:"relations",label:en?"Relations":"关系"}].map(item=><button className={tab===item.value?"is-active":""} key={item.value} onClick={()=>setParams({tab:item.value})}>{item.label}</button>)}</nav>
    <PendingObjectChanges candidates={data.pendingCandidates??[]} owner={owner} en={en} empty={!data.blockCount&&!data.counts.directNodes}/>
    {tab==="members"&&<GroupMembers group={group} groups={groups} nodes={nodes} en={en} canEdit={permissions.nodes} onChanged={refresh}/>}
    {tab==="content"&&<ObjectContentWorkspace owner={owner} en={en} canEdit={permissions.nodes} collectionRevision={data.blockCollectionRevision} onChanged={refresh}/>}
    {tab==="relations"&&<ObjectRelations owner={owner} label={group.core.nodeName} en={en} canEdit={permissions.nodes} primary={group.primaryRelations} relationRevision={group.relationRevision} onChanged={refresh}/>}
    {permissions.nodes&&permissions.deleteNodes&&<div className="research-delete-section"><button className="button" onClick={()=>setDeleting(true)}>{en?"Delete group":"删除节点组"}</button></div>}
    {editing&&<GroupEditor group={{...group,coreRevision:data.coreRevision} as Group} groups={groups} nodes={nodes} en={en} onClose={()=>setEditing(false)} onSaved={()=>{setEditing(false);refresh();}}/>}
    {parent&&<GroupParentDialog group={group} groups={groups} en={en} onClose={()=>setParent(false)} onSaved={()=>{setParent(false);refresh();}}/>}
    {deleting&&<GroupDeleteDialog id={group.id} title={group.core.nodeName} en={en} onClose={()=>setDeleting(false)} onDeleted={()=>{refresh();navigate("/topology");}}/>}
  </section>;
}
