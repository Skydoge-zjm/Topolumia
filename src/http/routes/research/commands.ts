import { sameObject, nodeRef, groupRef } from "../../../domain/research/object-ref.js";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { readJson, sendJson } from "../../../lib/http.js";
import { fail } from "../../../domain/research/access.js";
import { executeResearchTool } from "../../../services/research/tool-executor.js";
import { summarizeCandidate, candidateChangedBlockIds } from "../../../services/research/changes/candidate-summary.js";
const parseQuery=url=>Object.fromEntries([...url.searchParams.entries()].filter(([k])=>!["viewMode","view","projectId"].includes(k)).map(([k,v])=>[k,["limit","maxChars","offset","length","expectedRevision","revision"].includes(k)?Number(v):["nodeIds","owner","object","kinds","relationTypes","factPaths","types","selection"].includes(k)?JSON.parse(v):v]));
async function bytes(request,response,runtime,actor,id,variant){
  const file=await runtime.researchCommands.assets.content(id,variant??"original",actor);
  response.writeHead(200,{"content-type":file.mediaType,"content-length":file.sizeBytes,"content-disposition":(["application/pdf","image/png","image/jpeg","image/webp"].includes(file.mediaType)?"inline":"attachment")+"; filename*=UTF-8''"+encodeURIComponent(file.name),"x-content-sha256":file.checksum,"x-content-type-options":"nosniff","cache-control":"no-store"});
  await pipeline(createReadStream(file.file),response);
}
export async function handleResearchCommandsRoutes(ctx){
  const {request,response,url,pathname,requestRuntime:runtime,requestActor:actor}=ctx,c=runtime.researchCommands,q=c.queries;
  if(pathname==="/api/research/experiments/read"&&request.method==="POST"){sendJson(response,200,await executeResearchTool(runtime,"read_experiment",await readJson(request,262144),actor,ctx.sshEnvironments));return true;}
  if(pathname==="/api/state"&&request.method==="GET"){sendJson(response,200,{...runtime.state.view(),projectId:ctx.requestedProjectId,collaboration:{actor:actor?.user,permissions:actor?.permissions??[]}});return true;}
  if(pathname.startsWith("/api/research/access")){
    if(pathname==="/api/research/access"&&request.method==="GET"){sendJson(response,200,runtime.researchAccess.access(actor));return true;}
    if(pathname==="/api/research/access/authorize"&&request.method==="POST"){sendJson(response,200,runtime.researchAccess.authorize(actor,await readJson(request)));return true;}
    if(pathname==="/api/research/access/complete"&&request.method==="POST"){sendJson(response,200,runtime.researchAccess.complete(actor,await readJson(request)));return true;}
  }
  if(["/api/research/assets","/api/research-assets"].includes(pathname)&&request.method==="POST"){
    let name;try{name=decodeURIComponent(String(request.headers["x-asset-name"]??"file"));}catch{fail("INPUT_INVALID","Invalid file name.");}
    const a=await c.assets.upload(request,{originalName:name,mediaType:request.headers["x-asset-media-type"]??"application/octet-stream",idempotencyKey:request.headers["idempotency-key"],checksum:request.headers["x-content-sha256"],sizeBytes:request.headers["content-length"]},actor);
    if(pathname==="/api/research-assets")sendJson(response,201,{asset:a});else sendJson(response,201,q.finish(q.envelope("transfer",{status:"ready",assetId:a.id,checksum:a.checksum,sizeBytes:a.sizeBytes,processing:a.processing},{actor,maxChars:2000})));return true;
  }
  const asset=pathname.match(/^\/api\/(?:research\/assets|research-assets)\/([^/]+)(?:\/(content|preview|read))?$/);
  if(asset){const id=decodeURIComponent(asset[1]);if(asset[2]==="content"&&request.method==="GET"){await bytes(request,response,runtime,actor,id,url.searchParams.get("variant")??"original");return true;}
    if(asset[2]==="preview"&&request.method==="GET"){sendJson(response,200,await c.assets.preview(id,actor));return true;}
    if(pathname.startsWith("/api/research-assets/")&&request.method==="GET"){sendJson(response,200,{asset:c.assets.public(c.assets.assert(id,actor))});return true;}
    if(request.method==="GET"&&!asset[2]||request.method==="POST"&&asset[2]==="read"){const input=request.method==="GET"?parseQuery(url):await readJson(request,262144);sendJson(response,200,await executeResearchTool(runtime,"read_assets",{...input,assetId:id},actor,ctx.sshEnvironments));return true;}
  }
  if(pathname==="/api/research/exports"&&request.method==="POST"){const body=await readJson(request,262144);sendJson(response,200,q.finish(q.envelope("transfer",await c.assets.export(body,actor),{actor,maxChars:2000})));return true;}
  const preview=pathname.match(/^\/api\/research\/candidates\/([^/]+)\/preview$/);
  if(preview&&request.method==="GET"){
    if(actor.isAgent)fail("FORBIDDEN","Human preview endpoint.",403);
    const id=decodeURIComponent(preview[1]),p=c.changes.candidate(id,actor),snapshot=c.snapshot(id,actor),changed=candidateChangedBlockIds(p),refs=snapshot.touched??[];
    const before=refs.map(owner=>{try{return{owner,object:c.objects.get(owner)}}catch{return null;}}).filter(Boolean);
    const beforeEdges=c.formalTopology().edges;
    const experimentMaterials = [...before.map(entry => entry.object), ...snapshot.nodes.filter(object => refs.some(ref => ref.kind === "node" && ref.id === object.id))].filter(object => object.kind === "experiment").flatMap(object => (object.materialLinks ?? []).map(link => c.records.material(object, link, snapshot.blocks)));
    sendJson(response,200,{candidate:{id:p.id,revision:p.revision,status:p.status,reason:p.reason,summary:summarizeCandidate(c,p)},operations:p.operations,nodes:snapshot.nodes.filter(n=>refs.some(ref=>sameObject(ref,nodeRef(n.id)))),groups:snapshot.groups.filter(g=>refs.some(ref=>sameObject(ref,groupRef(g.id)))),beforeNodes:before.filter(entry=>entry.owner.kind==="node").map(entry=>entry.object),beforeGroups:before.filter(entry=>entry.owner.kind==="group").map(entry=>entry.object),deletedObjects:before.filter(entry=>!snapshot[entry.owner.kind==="group"?"groups":"nodes"].some(object=>object.id===entry.owner.id)),beforeBlocks:before.flatMap(entry=>c.objects.blocks(entry.owner).filter(block=>changed.has(block.id))),blocks:snapshot.blocks.filter(block=>refs.some(ref=>sameObject(ref,block.owner))&&changed.has(block.id)),experimentMaterials,relations:snapshot.topology.edges.filter(edge=>JSON.stringify(beforeEdges.find(before=>before.id===edge.id))!==JSON.stringify(edge)),removedRelations:beforeEdges.filter(edge=>!snapshot.topology.edges.some(after=>after.id===edge.id)),evidence:p.evidenceReads});return true;
  }
  const review=pathname.match(/^\/api\/research\/candidates\/([^/]+)\/review$/);
  if(review&&request.method==="POST"){const body=await readJson(request,262144),p=c.reviewCandidate({...body,patchId:decodeURIComponent(review[1]),actor});sendJson(response,200,p);return true;}
  if(pathname==="/api/research/context"&&request.method==="GET"&&url.searchParams.get("viewMode")!=="agent"&&!actor.isAgent){sendJson(response,200,c.context({actor}));return true;}
  const candidate=pathname.match(/^\/api\/research\/candidates(?:\/([^/]+))?$/);
  const routes={"/api/research/context":"get_context","/api/research/environment":"get_environment","/api/research/search":"search","/api/research/nodes":"read_nodes","/api/research/groups":"read_groups","/api/research/neighbors":"neighbors","/api/research/sources":"read_source","/api/research/blocks":"read_blocks","/api/research/blocks/read":"read_blocks","/api/research/schemas":"get_schema"};
  let name=routes[pathname];if(candidate)name=request.method==="POST"?"create_candidate":request.method==="PATCH"?"edit_candidate":"read_candidates";if(!name)return false;
  let input=request.method==="GET"?parseQuery(url):await readJson(request,262144);
  if(candidate){if(candidate[1])input.candidateId=decodeURIComponent(candidate[1]);if(name==="read_candidates")input.mode=candidate[1]?"show":"list";}
  if(name==="read_blocks")input.mode=pathname.endsWith("/read")?"read":"list";
  sendJson(response,200,await executeResearchTool(runtime,name,input,actor,ctx.sshEnvironments));return true;
}
