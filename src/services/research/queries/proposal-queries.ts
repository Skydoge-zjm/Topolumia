import { summarizeCandidate, candidateObjectRefs } from "../changes/candidate-summary.js";
import { sameObject } from "../../../domain/research/object-ref.js";
import { extractContentBlockText } from "../../../domain/research/content-blocks.js";
const clip=(value,length)=>String(value??"").slice(0,length);

export function candidateObjects(queries,candidate,actor){
  const view=queries.c.snapshot(candidate.id,actor),refs=candidateObjectRefs(candidate);
  return [...view.nodes.map(object=>({object,owner:{kind:"node",id:object.id}})),...view.groups.map(object=>({object,owner:{kind:"group",id:object.id}}))].filter(entry=>refs.some(ref=>sameObject(ref,entry.owner))||(view.touched??[]).some(ref=>sameObject(ref,entry.owner))).map(entry=>({...entry,blocks:view.blocks.filter(block=>sameObject(block.owner,entry.owner)&&block.lifecycle!=="archived").sort((a,b)=>a.order-b.order)}));
}
export function candidateReceipt(queries,candidate,actor){
  const objects=candidateObjects(queries,candidate,actor),summary=summarizeCandidate(queries.c,candidate);
  const directory=kind=>objects.filter(entry=>entry.owner.kind===kind).slice(0,3).map(({object,blocks})=>({[kind==="group"?"groupId":"nodeId"]:object.id,label:clip(object.core.nodeName,80),kind:kind==="group"?"group":object.kind,scope:"candidate",...(kind==="group"?{memberCount:object.members.length}:{}),blockCount:blocks.length,blocks:blocks.slice(0,4).map(block=>({blockId:block.id,title:clip(block.title,80),type:block.type,textChars:extractContentBlockText(block.type,block.payload).length})),omittedBlocks:Math.max(0,blocks.length-4)}));
  const data={candidateId:candidate.id,revision:candidate.revision,status:candidate.status,idempotencyKey:candidate.requestKey,idempotent:candidate.idempotent??false,nodes:directory("node"),groups:directory("group"),omittedNodes:Math.max(0,objects.filter(entry=>entry.owner.kind==="node").length-3),omittedGroups:Math.max(0,objects.filter(entry=>entry.owner.kind==="group").length-3),formalChangesApplied:candidate.status==="applied",researchContent:{addedBlocks:summary.addedBlocks,updatedBlocks:summary.updatedBlocks,assetCount:summary.assetCount,identityOnlyPapers:summary.identityOnlyPapers,blockTypes:summary.blockTypes,imageAssets:summary.imageAssets},...(summary.identityOnlyPapers?{notice:"Paper identity has no reading blocks. Append actual reading results if requested."}:{}),reviewPath:"/#/agents?candidate="+encodeURIComponent(candidate.id),readHint:{mode:"show",candidateId:candidate.id,section:dataSection(objects)}};
  const result=queries.envelope("candidateReceipt",data,{actor,maxChars:4000,candidateId:candidate.id});
  while(JSON.stringify(result).length+100>4000){const list=data.groups.length?data.groups:data.nodes,last=list.at(-1);if(!last)break;if(last.blocks.length){last.blocks.pop();last.omittedBlocks++;}else{list.pop();list===data.groups?data.omittedGroups++:data.omittedNodes++;}}
  if(data.omittedNodes||data.omittedGroups||[...data.nodes,...data.groups].some(entry=>entry.omittedBlocks))result.coverage={complete:false,omissions:["candidateDirectory"]};
  return queries.finish(result);
}
const dataSection=objects=>objects.some(entry=>entry.owner.kind==="group")?"groups":"nodes";
export function readCandidates(queries,input){
  const c=queries.c;c.check(input.actor,"research.view");
  if(input.mode==="list"){const entries=queries.store.all("candidates").filter(p=>c.visibleCandidate(p,input.actor)&&(!input.status||p.status===input.status)&&(!input.idempotencyKey||p.requestKey===input.idempotencyKey)).map(p=>({id:p.id,revision:p.revision,status:p.status,reason:clip(p.reason,240),operationCount:p.operations.length,readHint:{mode:"show",candidateId:p.id}}));return queries.page("candidates",entries,input,{status:input.status,key:input.idempotencyKey,versions:entries.map(p=>[p.id,p.revision,p.status])});}
  const p=c.changes.candidate(input.candidateId,input.actor),meta={id:p.id,revision:p.revision,status:p.status,reason:p.reason,idempotencyKey:p.requestKey};
  if(input.section==="evidence")return queries.page("candidates",p.evidenceReads,input,{candidate:p.id,revision:p.revision,section:"evidence"});
  if(["nodes","groups"].includes(input.section)){const view=c.snapshot(p.id,input.actor);const entries=candidateObjects(queries,p,input.actor).filter(entry=>entry.owner.kind===(input.section==="groups"?"group":"node")).map(({object})=>input.section==="groups"?queries.groupSummary(object,view):queries.nodeSummary(object,view));return queries.page("candidates",entries,input,{candidate:p.id,revision:p.revision,section:input.section});}
  return queries.finish(queries.envelope("candidates",{...meta,operationCount:p.operations.length,readHints:[{mode:"show",candidateId:p.id,section:"nodes"},{mode:"show",candidateId:p.id,section:"groups"}],contentHint:"Read exact nodes/groups/blocks with candidateId. Candidate IDs are pending until a human accepts."},input));
}
