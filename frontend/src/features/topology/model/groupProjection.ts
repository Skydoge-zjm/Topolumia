import type { Group, ResearchNode, ResearchObjectRef } from "@/features/research/model";
import { objectKey, nodeRef, groupRef } from "@domain/research/object-ref";
import type { ResearchRelation } from "../details/RelationEditor";
export type GraphEdge = { id:string;from:string;to:string;type:string;label?:ResearchRelation["label"];edgeIds:string[];projected:boolean;primary:boolean;origins:(ResearchRelation & {fromLabel:string;toLabel:string})[] };
export type PreviewNode = {id:string;label:string;kind:string;shared:boolean};
export type DisplayNode = ResearchNode & {layoutParentId?:string;previewNodes?:PreviewNode[];object:ResearchObjectRef;groupId?:string;memberCount?:number;hiddenCount?:number;sharedCount?:number;collapsed?:boolean;internalRelationCount?:number;sharedGroupIds?:string[]};
export type GroupProjection = {nodes:DisplayNode[];edges:GraphEdge[]};
export function groupDescendants(groupId:string,groups:Group[]):string[]{const seen=new Set<string>();const visit=(id:string)=>{if(seen.has(id))return;seen.add(id);groups.filter(group=>group.parentId===id).forEach(group=>visit(group.id));};visit(groupId);return [...seen];}
export function groupMembers(groupId:string,groups:Group[]):string[]{const ids=new Set(groupDescendants(groupId,groups));return [...new Set(groups.filter(group=>ids.has(group.id)).flatMap(group=>group.members.map(member=>member.nodeId)))];}
export function projectGroups(nodes:ResearchNode[],edges:ResearchRelation[],groups:Group[],collapsed:string[]):GroupProjection {
  const known=new Set(nodes.map(node=>node.id)),byId=new Map(groups.map(group=>[group.id,group])),collapsedSet=new Set(collapsed),ranges=new Map(groups.map(group=>[group.id,new Set(groupMembers(group.id,groups).filter(id=>known.has(id)))]));
  const ancestor=(id:string,target:string)=>{let current:string|null=id;const seen=new Set<string>();while(current&&!seen.has(current)){if(current===target)return true;seen.add(current);current=byId.get(current)?.parentId??null;}return false;};
  const roots=groups.filter(group=>collapsedSet.has(group.id)&&!groups.some(parent=>parent.id!==group.id&&collapsedSet.has(parent.id)&&ancestor(group.id,parent.id)));
  const owners=new Map<string,string>(),shared=new Map<string,string[]>();
  for(const node of nodes){const covers=roots.filter(group=>ranges.get(group.id)!.has(node.id));const memberships=groups.filter(group=>group.members.some(member=>member.nodeId===node.id));if(covers.length===1&&memberships.every(group=>ancestor(group.id,covers[0].id)))owners.set(objectKey(nodeRef(node.id)),objectKey(groupRef(covers[0].id)));else if(covers.length)shared.set(node.id,memberships.map(group=>group.id));}
  for(const group of groups){const root=roots.find(root=>root.id!==group.id&&ancestor(group.id,root.id));if(root)owners.set(objectKey(groupRef(group.id)),objectKey(groupRef(root.id)));}
  const displayNodes:DisplayNode[]=[...nodes.filter(node=>!owners.has(objectKey(nodeRef(node.id)))).map(node=>({...node,id:objectKey(nodeRef(node.id)),object:nodeRef(node.id),sharedGroupIds:shared.get(node.id)})),...groups.filter(group=>!owners.has(objectKey(groupRef(group.id)))).map(group=>{const range=ranges.get(group.id)!;return{id:objectKey(groupRef(group.id)),object:groupRef(group.id),kind:"group",label:group.core.nodeName,summary:group.core.summary??"",status:"group",groupId:group.id,memberCount:range.size,hiddenCount:[...range].filter(id=>owners.get(objectKey(nodeRef(id)))===objectKey(groupRef(group.id))).length,sharedCount:[...range].filter(id=>shared.has(id)).length,collapsed:collapsedSet.has(group.id),internalRelationCount:0};})];
  const displayById=new Map(displayNodes.map(node=>[node.id,node]));
  const chain=(id:string)=>{const result:string[]=[];let current:string|null=id;while(current&&!result.includes(current)){result.push(current);current=byId.get(current)?.parentId??null;}return result;};
  for(const item of displayNodes){
    if(item.groupId){
      const group=byId.get(item.groupId)!;
      if(group.parentId&&displayById.has(objectKey(groupRef(group.parentId))))item.layoutParentId=objectKey(groupRef(group.parentId));
      item.previewNodes=[...ranges.get(item.groupId)!].map(id=>{const node=nodes.find(node=>node.id===id)!;const value=node.label;return{id:objectKey(nodeRef(id)),label:typeof value==="string"?value:value.zh??value.en??id,kind:node.kind,shared:groups.filter(group=>group.members.some(member=>member.nodeId===id)).length>1};});
      item.sharedCount=item.previewNodes.filter(node=>node.shared).length;
    }else{
      const memberships=groups.filter(group=>group.members.some(member=>member.nodeId===item.object.id));
      const common=memberships.length?chain(memberships[0].id).filter(id=>memberships.every(group=>chain(group.id).includes(id))):[];
      const parent=common.find(id=>displayById.has(objectKey(groupRef(id)))&&!collapsedSet.has(id));
      if(parent)item.layoutParentId=objectKey(groupRef(parent));
      if(memberships.length>1)item.sharedGroupIds=memberships.map(group=>group.id);
    }
  }
  const visible=displayById,projected=new Map<string,GraphEdge>();
  const label=(ref:ResearchObjectRef)=>ref.kind==="group"?byId.get(ref.id)?.core.nodeName??ref.id:nodes.find(node=>node.id===ref.id)?.label??ref.id;
  const labelText=(ref:ResearchObjectRef)=>{const value=label(ref);return typeof value==="string"?value:value.zh??value.en??ref.id;};
  for(const edge of edges){const originalFrom=objectKey(edge.from),originalTo=objectKey(edge.to),from=owners.get(originalFrom)??originalFrom,to=owners.get(originalTo)??originalTo;if(!visible.has(from)||!visible.has(to))continue;if(from===to){const node=visible.get(from)!;node.internalRelationCount=(node.internalRelationCount??0)+1;continue;}const isProjected=from!==originalFrom||to!==originalTo;const aggregateKey=isProjected?JSON.stringify([from,to,edge.type,"projection"]):"direct:"+edge.id;const primary=groups.some(group=>Object.values(group.primaryRelations).includes(edge.id));const origin={...edge,fromLabel:labelText(edge.from),toLabel:labelText(edge.to)};const previous=projected.get(aggregateKey);if(previous){previous.edgeIds.push(edge.id);previous.origins.push(origin);}else projected.set(aggregateKey,{id:isProjected?"projection:"+edge.id:edge.id,from,to,type:edge.type,label:edge.label,edgeIds:[edge.id],projected:isProjected,primary:!isProjected&&primary,origins:[origin]});}
  return {nodes:displayNodes,edges:[...projected.values()]};
}

export type Frame = { x: number; y: number; width: number; height: number; parentId?: string };
export type ContainerLayout = { frames: Record<string, Frame>; roots: string[] };
export type Camera = { x: number; y: number; scale: number };
export type LayoutItem = { id: string; width: number; height: number };
export type Arrange = (items: LayoutItem[], edges: { id: string; from: string; to: string }[], scope: string) => Promise<{ positions: Record<string, { x: number; y: number }>; width: number; height: number }>;
export const NODE_WIDTH = 224, NODE_HEIGHT = 92, COMPACT_GROUP_WIDTH = 252, COMPACT_GROUP_HEIGHT = 176;
export const GROUP_PADDING = { left: 26, right: 26, top: 86, bottom: 30 };

function grid(items: LayoutItem[]) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(items.length * 1.25))), gap = 28, positions: Record<string, { x: number; y: number }> = {};
  let x = 0, y = 0, rowHeight = 0, width = 0;
  items.forEach((item, index) => {
    if (index && index % columns === 0) { x = 0; y += rowHeight + gap; rowHeight = 0; }
    positions[item.id] = { x, y }; x += item.width + gap; rowHeight = Math.max(rowHeight, item.height); width = Math.max(width, x - gap);
  });
  return { positions, width, height: y + rowHeight };
}

/** Expanded groups are real layout containers; only top-level boxes enter the outer graph. */
export async function layoutGroupContainers(graph: GroupProjection, arrange: Arrange): Promise<ContainerLayout> {
  const byId = new Map(graph.nodes.map(node => [node.id, node])), parents = new Map<string, string | undefined>(), children = new Map<string, DisplayNode[]>();
  for (const node of graph.nodes) {
    const parent = node.layoutParentId ? byId.get(node.layoutParentId) : undefined;
    const parentId = parent?.groupId && !parent.collapsed ? parent.id : undefined;
    parents.set(node.id, parentId); const key = parentId ?? "root";
    if (!children.has(key)) children.set(key, []); children.get(key)!.push(node);
  }
  const frames: Record<string, Frame> = {}, local = new Map<string, Record<string, { x: number; y: number }>>();
  const directChild = (id: string, scope: string): string | undefined => {
    let current: string | undefined = id;
    while (current) { const parent = parents.get(current) ?? "root"; if (parent === scope) return current; current = parents.get(current); }
    return undefined;
  };
  const measure = async (scope: string) => {
    const members = children.get(scope) ?? [];
    await Promise.all(members.map(async node => {
      if (node.groupId && !node.collapsed) {
        const size = await measure(node.id);
        frames[node.id] = { x: 0, y: 0, width: Math.max(380, size.width + GROUP_PADDING.left + GROUP_PADDING.right), height: Math.max(240, size.height + GROUP_PADDING.top + GROUP_PADDING.bottom), parentId: parents.get(node.id) };
      } else frames[node.id] = { x: 0, y: 0, width: node.groupId ? COMPACT_GROUP_WIDTH : NODE_WIDTH, height: node.groupId ? COMPACT_GROUP_HEIGHT : NODE_HEIGHT, parentId: parents.get(node.id) };
    }));
    const items = members.map(node => ({ id: node.id, width: frames[node.id].width, height: frames[node.id].height }));
    const mappedEdges = new Map<string, { id: string; from: string; to: string }>();
    for (const edge of graph.edges) { const from = directChild(edge.from, scope), to = directChild(edge.to, scope); if (from && to && from !== to) { const key = JSON.stringify([from, to]); if (!mappedEdges.has(key)) mappedEdges.set(key, { id: edge.id, from, to }); } }
    const result = !items.length ? { positions: {}, width: 0, height: 0 } : scope !== "root" && !mappedEdges.size ? grid(items) : await arrange(items, [...mappedEdges.values()], scope);
    local.set(scope, result.positions); return result;
  };
  await measure("root");
  const place = (scope: string, offset: { x: number; y: number }) => {
    for (const node of children.get(scope) ?? []) {
      const point = local.get(scope)?.[node.id] ?? { x: 0, y: 0 }, frame = frames[node.id]; frame.x = offset.x + point.x; frame.y = offset.y + point.y;
      if (node.groupId && !node.collapsed) place(node.id, { x: frame.x + GROUP_PADDING.left, y: frame.y + GROUP_PADDING.top });
    }
  };
  place("root", { x: 0, y: 0 });
  return { frames, roots: (children.get("root") ?? []).map(node => node.id) };
}

export function layoutBounds(frames: Record<string, Frame>, ids = Object.keys(frames)): Frame {
  const items = ids.map(id => frames[id]).filter(Boolean);
  if (!items.length) return { x: 0, y: 0, width: 300, height: 200 };
  const x = Math.min(...items.map(frame => frame.x)), y = Math.min(...items.map(frame => frame.y));
  return { x, y, width: Math.max(...items.map(frame => frame.x + frame.width)) - x, height: Math.max(...items.map(frame => frame.y + frame.height)) - y };
}

/** Leave visible room on every side for relations to objects outside the group. */
export function cameraForFrame(frame: Frame, viewport: { width: number; height: number }, coverage = 0.8, maxScale = 1.8): Camera {
  const width = Math.max(1, viewport.width), height = Math.max(1, viewport.height);
  const scale = Math.max(0.001, Math.min(maxScale, width * coverage / Math.max(frame.width, 1), height * coverage / Math.max(frame.height, 1)));
  return { x: width / 2 - (frame.x + frame.width / 2) * scale, y: height / 2 - (frame.y + frame.height / 2) * scale, scale };
}
