import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderClosed, FolderOpen, Plus, CheckSquare } from "lucide-react";
import { nodeKinds } from "@domain/research/node-fields";
import { nodeRef, groupRef, objectKey } from "@domain/research/object-ref";
import { api, projectId } from "@/shared/lib/api";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { useUiStore } from "@/shared/state/ui";
import { useResearchPermissions } from "@/features/research/useResearch";
import { objectUrl, text } from "@/features/research/model";
import type { Group, ResearchNode } from "@/features/research/model";
import type { ResearchRelation } from "./details/RelationEditor";
import { GroupEditor } from "./groups/GroupEditor";
import { groupMembers, projectGroups } from "./model/groupProjection";
import { TopologyCanvas } from "./TopologyCanvas";
const EMPTY_TOPOLOGY: { nodes: ResearchNode[]; edges: ResearchRelation[]; groups: Group[] } = { nodes: [], edges: [], groups: [] };
export function TopologyPage(){return <TopologyWorkspace key={projectId()}/>;}
function TopologyWorkspace(){
  const en=useUiStore(state=>state.locale)==="en",permissions=useResearchPermissions(),navigate=useNavigate(),client=useQueryClient(),[params,setParams]=useSearchParams();
  const query=useQuery({queryKey:["topology",projectId()],queryFn:()=>api<{nodes:ResearchNode[];edges:ResearchRelation[];groups:Group[]}>("/api/topology")});
  const storageScope=permissions.actorId+":"+projectId(),key="topolumia-group-expanded:"+storageScope;
  const[expanded,setExpanded]=useState<string[]>([]),[search,setSearch]=useState(""),[querySearch,setQuerySearch]=useState(""),[editor,setEditor]=useState(false),[newKind,setNewKind]=useState("question"),[selecting,setSelecting]=useState(false),[selected,setSelected]=useState<string[]>([]);
  useEffect(()=>{try{const saved=JSON.parse(localStorage.getItem(key)??"[]");setExpanded(Array.isArray(saved)?saved:[]);}catch{setExpanded([]);}},[key]);
  useEffect(()=>{const timer=setTimeout(()=>setQuerySearch(search),250);return()=>clearTimeout(timer);},[search]);
  const focus=params.get("group")??"",{nodes,edges,groups}=query.data??EMPTY_TOPOLOGY;
  const [groupAction,setGroupAction]=useState<{id:string;kind:"expand"|"collapse"|"focus"|"overview";sequence:number;previousExpanded?:string[]}>(),actionSequence=useRef(0),handledFocusRequest=useRef<string | null>(null);
  const restoreExpanded=useCallback((ids:string[])=>{setExpanded(current=>JSON.stringify(current)===JSON.stringify(ids)?current:ids);localStorage.setItem(key,JSON.stringify(ids));},[key]);
  useEffect(()=>{if(params.get("expand")!=="1"){handledFocusRequest.current=null;return;}if(!groups.some(group=>group.id===focus)||handledFocusRequest.current===focus)return;handledFocusRequest.current=focus;const open=new Set([focus]);let parent=groups.find(group=>group.id===focus)?.parentId;while(parent){open.add(parent);parent=groups.find(group=>group.id===parent)?.parentId;}const previousExpanded=[...expanded],next=[...new Set([...expanded,...open])];setExpanded(next);localStorage.setItem(key,JSON.stringify(next));setGroupAction({id:focus,kind:"focus",sequence:++actionSequence.current,previousExpanded});setParams({group:focus},{replace:true});},[expanded,focus,groups,key,params,setParams]);
  const graph=useMemo(()=>{
    const folding=querySearch?[]:groups.filter(group=>!expanded.includes(group.id)).map(group=>group.id);
    const projection=projectGroups(nodes,edges,groups,folding);
    let allowed:Set<string>|null=null;
    if(querySearch){
      const needle=querySearch.toLowerCase(),matches=new Set(projection.nodes.filter(node=>(text(node.label,en)+" "+text(node.summary,en)+" "+node.kind).toLowerCase().includes(needle)).map(node=>node.id));
      for(const group of groups){if(matches.has(objectKey(groupRef(group.id))))for(const id of groupMembers(group.id,groups))matches.add(objectKey(nodeRef(id)));if(groupMembers(group.id,groups).some(id=>matches.has(objectKey(nodeRef(id)))))matches.add(objectKey(groupRef(group.id)));}
      allowed=allowed?new Set([...allowed].filter(id=>matches.has(id))):matches;
    }
    if(!allowed)return projection;
    const visible=new Set(projection.nodes.filter(node=>allowed!.has(node.id)).map(node=>node.id));
    return {nodes:projection.nodes.filter(node=>visible.has(node.id)),edges:projection.edges.filter(edge=>visible.has(edge.from)&&visible.has(edge.to))};
  },[nodes,edges,groups,expanded,querySearch,en]);
  const toggle=(id:string)=>{const closing=expanded.includes(id),next=closing?expanded.filter(item=>item!==id):[...expanded,id];if(!closing){let parent=groups.find(group=>group.id===id)?.parentId;while(parent){if(!next.includes(parent))next.push(parent);parent=groups.find(group=>group.id===parent)?.parentId;}}setExpanded(next);localStorage.setItem(key,JSON.stringify(next));setGroupAction({id,kind:closing?"collapse":"expand",sequence:++actionSequence.current,previousExpanded:[...expanded]});};
  const chooseScope=(id:string)=>{if(!id){setParams({});setGroupAction({id:"",kind:"overview",sequence:++actionSequence.current});return;}setParams({group:id,expand:"1"});};
  const depth=(group:Group)=>{let count=0,parent=group.parentId;while(parent&&count<8){count++;parent=groups.find(item=>item.id===parent)?.parentId??null;}return count;};
  return <section translate="no" className="research-workspace topology-workspace"><header className="research-page-heading"><div><h1>{en?"Research topology":"科研拓扑"}</h1></div><span className="research-badge">{nodes.length} {en?"nodes":"节点"} · {groups.length} {en?"groups":"节点组"} · {edges.length} {en?"relations":"关系"}</span></header>
    <div className="research-toolbar"><input aria-label={en?"Search research objects":"搜索科研对象"} placeholder={en?"Search names and summaries…":"搜索名称、概要…"} value={search} onChange={event=>setSearch(event.target.value)}/><SelectMenu ariaLabel={en?"Focus group":"聚焦节点组"} value={focus} onChange={chooseScope} options={[{value:"",label:en?"All research":"全部研究"},...groups.map(group=>({value:group.id,label:group.core.nodeName}))]}/>
      {permissions.nodes&&<><button className={"button "+(selecting?"is-active":"")} onClick={()=>{setSelecting(!selecting);setSelected([]);}}><CheckSquare size={15}/>{selecting?(en?"Finish selecting":"退出选择"):(en?"Select nodes":"选择节点")}</button><button className="button" onClick={()=>setEditor(true)}><Plus size={15}/>{selected.length?(en?`Group ${selected.length} selected`:`组成节点组（${selected.length}）`):(en?"New group":"新建节点组")}</button><SelectMenu ariaLabel={en?"New node type":"新节点类型"} value={newKind} onChange={setNewKind} options={Object.entries(nodeKinds).map(([value,spec])=>({value,label:en?spec.en:spec.label}))}/><button className="button primary" onClick={()=>navigate("/topology/new?kind="+newKind)}><Plus size={15}/>{en?"New node":"新建节点"}</button></>}
    </div>{query.error&&<p role="alert">{query.error.message}</p>}
    <div className="research-topology-layout"><aside className="research-group-rail"><h2>{en?"Node groups":"节点组"}</h2>{groups.map(group=><div className="research-group-row" key={group.id} style={{paddingLeft:depth(group)*12}}><button aria-label={(!expanded.includes(group.id)?(en?"Expand ":"展开 "):(en?"Collapse ":"收起 "))+group.core.nodeName} className="research-icon-button" onClick={()=>toggle(group.id)}>{!expanded.includes(group.id)?<FolderClosed size={17}/>:<FolderOpen size={17}/>}</button><Link to={objectUrl(groupRef(group.id))}>{group.core.nodeName}<small>{groupMembers(group.id,groups).length} {en?"nodes in scope":"个范围内节点"}</small></Link></div>)}{!groups.length&&<p className="research-empty">{en?"No node groups.":"暂无节点组。"}</p>}</aside><div className="research-graph-panel">{query.isPending?<p className="loading">{en?"Loading topology…":"载入拓扑…"}</p>:graph.nodes.length?<TopologyCanvas graph={graph} en={en} storageScope={storageScope} groupAction={groupAction} onRestoreExpanded={restoreExpanded} onOpen={node=>navigate(objectUrl(node.object))} onExpand={toggle} selection={selected} onSelect={selecting?id=>setSelected(selected.includes(id)?selected.filter(item=>item!==id):[...selected,id]):undefined}/>:<div className="research-empty research-graph-empty">{en?"No objects in this view.":"当前视角没有科研对象。"}</div>}</div></div>
    {editor&&<GroupEditor groups={groups} nodes={nodes} initialMembers={selected} en={en} onClose={()=>setEditor(false)} onSaved={group=>{setEditor(false);setSelecting(false);setSelected([]);void client.invalidateQueries({queryKey:["topology",projectId()]});navigate(objectUrl(groupRef(group.id)));}}/>}
  </section>;
}
