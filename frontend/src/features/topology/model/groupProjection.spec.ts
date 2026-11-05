import { expect, it } from "vitest";
import { cameraForFrame, GROUP_PADDING, groupMembers, layoutGroupContainers, projectGroups } from "./groupProjection";
import { objectKey, nodeRef, groupRef } from "@domain/research/object-ref";
import type { Group, ResearchNode } from "@/features/research/model";
import type { ResearchRelation } from "../details/RelationEditor";
const nodes:ResearchNode[]=["p1","p2","e1","q"].map(id=>({id,kind:id.startsWith("p")?"paper":"experiment",label:id,summary:"",status:"active"}));
const makeGroup=(id:string,nodeIds:string[],parentId:string|null=null):Group=>({id,core:{nodeName:id},members:nodeIds.map(nodeId=>({nodeId})),parentId,primaryRelations:{},revision:1,membershipRevision:1,relationRevision:1});
const groups=[makeGroup("a",["p1"]),makeGroup("b",["p2"],"a"),makeGroup("c",["p1","e1"])];
const relation=(id:string,from:ResearchRelation["from"],to:ResearchRelation["to"]):ResearchRelation=>({id,from,to,type:"supports",revision:1});
const edges=[relation("1",nodeRef("p1"),nodeRef("q")),relation("2",nodeRef("p2"),nodeRef("q")),relation("3",nodeRef("p1"),nodeRef("p2"))];
it("nested collapse preserves facts, aggregates member edges and keeps a stable group anchor",()=>{
 const inputGroups=groups.slice(0,2),before=JSON.stringify({nodes,edges,inputGroups}),result=projectGroups(nodes,edges,inputGroups,["a","b"]);
 expect(result.nodes.map(node=>node.object.id).sort()).toEqual(["a","e1","q"]);
 expect(result.edges).toHaveLength(1);expect(result.edges[0].edgeIds).toEqual(["1","2"]);expect(result.edges[0].projected).toBe(true);
 expect(result.nodes.find(node=>node.groupId==="a")?.internalRelationCount).toBe(1);
 expect(groupMembers("a",inputGroups)).toEqual(["p1","p2"]);expect(JSON.stringify({nodes,edges,inputGroups})).toBe(before);
 const expanded=projectGroups(nodes,edges,inputGroups,[]);expect(expanded.nodes.some(node=>node.id===objectKey(groupRef("a")))).toBe(true);
});
it("overlapping collapsed groups keep shared nodes visible regardless of group order",()=>{
 const a=projectGroups(nodes,edges,groups,["a","c"]),b=projectGroups(nodes,edges,[...groups].reverse(),["c","a"]);
 expect(a.nodes.some(node=>node.object.id==="p1")).toBe(true);
 for(const id of ["a","c"]){const card=a.nodes.find(node=>node.groupId===id)!;expect(card.memberCount).toBe(2);expect(card.sharedCount).toBe(1);expect(card.hiddenCount).toBe(1);}
 expect(new Set(a.nodes.map(node=>node.id))).toEqual(new Set(b.nodes.map(node=>node.id)));
 expect(a.nodes.find(node=>node.object.id==="p1")?.sharedGroupIds?.sort()).toEqual(["a","c"]);
});
it("collapsing a group does not hide a direct member of another expanded group",()=>{
 const result=projectGroups(nodes,edges,groups,["a"]);
 expect(result.nodes.some(node=>node.object.id==="p1")).toBe(true);expect(result.nodes.some(node=>node.object.id==="p2")).toBe(false);
 expect(result.nodes.find(node=>node.groupId==="c")?.collapsed).toBe(false);
});
it("direct group relations remain distinct from member projections in both views",()=>{
 const scope=groups.slice(0,2),raw=[...edges,relation("direct",groupRef("a"),nodeRef("q"))];
 for(const folded of [[],["a"]]){const result=projectGroups(nodes,raw,scope,folded);const direct=result.edges.find(edge=>edge.id==="direct")!;expect(direct.from).toBe(objectKey(groupRef("a")));expect(direct.projected).toBe(false);}
 const collapsed=projectGroups(nodes,raw,scope,["a"]);expect(collapsed.edges.filter(edge=>edge.to===objectKey(nodeRef("q")))).toHaveLength(2);
 const restored=projectGroups(nodes,raw,scope,[]);expect(restored.edges.flatMap(edge=>edge.edgeIds).sort()).toEqual(raw.map(edge=>edge.id).sort());
});
it("empty groups are visible and retain their incoming relation",()=>{
 const empty=makeGroup("empty",[]),raw=[relation("design",nodeRef("q"),groupRef("empty"))];
 const result=projectGroups(nodes,raw,[empty],["empty"]);expect(result.nodes.find(node=>node.groupId==="empty")?.memberCount).toBe(0);expect(result.edges[0].to).toBe(objectKey(groupRef("empty")));
});

it("expanded containers contain normal members and nested containers with real padding",async()=>{
 const projection=projectGroups(nodes,edges,groups.slice(0,2),[]);
 const layout=await layoutGroupContainers(projection,async items=>({positions:Object.fromEntries(items.map((item,index)=>[item.id,{x:index*700,y:0}])),width:Math.max(0,...items.map((item,index)=>index*700+item.width)),height:Math.max(0,...items.map(item=>item.height))}));
 const a=layout.frames[objectKey(groupRef("a"))],b=layout.frames[objectKey(groupRef("b"))],paper=layout.frames[objectKey(nodeRef("p2"))];
 expect(b.parentId).toBe(objectKey(groupRef("a")));expect(paper.parentId).toBe(objectKey(groupRef("b")));
 for(const[child,parent]of [[b,a],[paper,b]]){expect(child.x).toBeGreaterThanOrEqual(parent.x+GROUP_PADDING.left);expect(child.y).toBeGreaterThanOrEqual(parent.y+GROUP_PADDING.top);expect(child.x+child.width).toBeLessThanOrEqual(parent.x+parent.width-GROUP_PADDING.right);expect(child.y+child.height).toBeLessThanOrEqual(parent.y+parent.height-GROUP_PADDING.bottom);}
 expect(paper.width).toBe(224);expect(paper.height).toBe(92);
});
it("a compact group keeps bounded dimensions and previews every member",async()=>{
 const many:ResearchNode[]=Array.from({length:300},(_,index)=>({id:"n"+index,kind:"experiment",label:"Run "+index,summary:"",status:"active"}));
 const projection=projectGroups(many,[],[makeGroup("compact",many.map(node=>node.id))],["compact"]);
 const layout=await layoutGroupContainers(projection,async items=>({positions:Object.fromEntries(items.map(item=>[item.id,{x:0,y:0}])),width:252,height:176}));
 expect(projection.nodes).toHaveLength(1);expect(projection.nodes[0].previewNodes).toHaveLength(300);
 expect(layout.frames[objectKey(groupRef("compact"))].width).toBe(252);expect(layout.frames[objectKey(groupRef("compact"))].height).toBe(176);
});
it("camera fitting uses the actual viewport and leaves peripheral context on every side",()=>{
 for(const frame of [{x:-500,y:200,width:700,height:400},{x:100,y:-900,width:420,height:1500},{x:0,y:0,width:40000,height:20000}]){
  const viewport={width:960,height:600},camera=cameraForFrame(frame,viewport);
  expect(camera.x+frame.x*camera.scale).toBeGreaterThanOrEqual(viewport.width*.1-1);
  expect(camera.y+frame.y*camera.scale).toBeGreaterThanOrEqual(viewport.height*.1-1);
  expect(camera.x+(frame.x+frame.width)*camera.scale).toBeLessThanOrEqual(viewport.width*.9+1);
  expect(camera.y+(frame.y+frame.height)*camera.scale).toBeLessThanOrEqual(viewport.height*.9+1);
  expect(Math.max(frame.width*camera.scale/viewport.width,frame.height*camera.scale/viewport.height)).toBeCloseTo(.8);
 }
});
