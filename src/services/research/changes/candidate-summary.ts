import { extractContentBlockText } from "../../../domain/research/content-blocks.js";
import { nodeRef, groupRef, objectKey, sameObject } from "../../../domain/research/object-ref.js";

export function candidateChangedBlockIds(candidate) {
  return new Set(candidate.operations.flatMap(op => op.op === "addBlock" ? [candidate.allocation["block:" + op.clientRef]] : op.blockId ? [op.blockId] : op.blockRef ? [op.blockRef.startsWith("@") ? candidate.allocation["block:" + op.blockRef.slice(1)] : op.blockRef] : []));
}
export function candidateObjectRefs(candidate) {
  const refs = new Map(), resolve = owner => { if(!owner)return;const ref={kind:owner.kind,id:owner.id?.startsWith("@")?candidate.allocation[owner.kind+":"+owner.id.slice(1)]:owner.id};if(ref.id)refs.set(objectKey(ref),ref); };
  for(const op of candidate.operations){
    if(op.op==="addNode")resolve(nodeRef(candidate.allocation["node:"+op.clientRef]));
    else if(op.op==="addGroup")resolve(groupRef(candidate.allocation["group:"+op.clientRef]));
    else if(op.owner)resolve(op.owner);
    else if(op.groupId)resolve(groupRef(op.groupId));
    else if(op.nodeId)resolve(nodeRef(op.nodeId));
    if(op.op==="addEdge"){resolve(op.edge.from);resolve(op.edge.to);}
  }
  return [...refs.values()];
}
export function summarizeCandidate(commands, candidate) {
  let snapshot, conflict;
  try { snapshot = candidate.finalSnapshot ?? commands.snapshot(candidate.id, candidate.actor); } catch(error) { conflict={code:error.code??"CANDIDATE_UNAVAILABLE",message:error.message}; }
  const refs=new Map(candidateObjectRefs(candidate).map(ref=>[objectKey(ref),ref]));
  for(const ref of snapshot?.touched??[])refs.set(objectKey(ref),ref);
  const changed=candidateChangedBlockIds(candidate),assets=new Set(candidate.assetIds??[]);
  const entries=[...refs.values()].map(owner=>{
    let object=snapshot?.[owner.kind==="group"?"groups":"nodes"]?.find(value=>value.id===owner.id);
    if(!object)try{object=commands.objects.get(owner);}catch{}
    const addition=candidate.operations.find(op=>op.op===(owner.kind==="group"?"addGroup":"addNode")&&candidate.allocation[owner.kind+":"+op.clientRef]===owner.id);
    const blocks=(snapshot?.blocks??[]).filter(block=>sameObject(block.owner,owner)&&block.lifecycle!=="archived");
    const relevant=candidate.operations.filter(op=>op.owner&&sameObject({kind:op.owner.kind,id:op.owner.id?.startsWith("@")?candidate.allocation[op.owner.kind+":"+op.owner.id.slice(1)]:op.owner.id},owner));
    const blockTypes=blocks.reduce((counts,block)=>{counts[block.type]=(counts[block.type]??0)+1;return counts;},{});
    return {object:owner,...(owner.kind==="node"?{nodeId:owner.id}:{groupId:owner.id}),label:object?.core.nodeName??addition?.core.nodeName??owner.id,kind:owner.kind==="group"?"group":object?.kind??addition?.kind,created:Boolean(addition),deleted:candidate.operations.some(op=>op.op===(owner.kind==="group"?"deleteGroup":"deleteNode")&&(op.groupId??op.nodeId)===owner.id),addedBlocks:relevant.filter(op=>op.op==="addBlock").length,updatedBlocks:relevant.filter(op=>op.op==="updateBlock").length,archivedBlocks:relevant.filter(op=>op.op==="archiveBlock").length,blockCount:blocks.length,textChars:blocks.reduce((sum,block)=>sum+extractContentBlockText(block.type,block.payload).trim().length,0),blockTypes,identityOnly:owner.kind==="node"&&(object?.kind??addition?.kind)==="paper"&&blocks.length===0,blockTitles:blocks.map(block=>block.title).slice(0,8),omittedBlockTitles:Math.max(0,blocks.length-8),...(owner.kind==="group"?{memberCount:object?.members?.length??addition?.members?.length??0}:{}),changedBlockIds:blocks.filter(block=>changed.has(block.id)).map(block=>block.id)};
  });
  return {nodes:entries.filter(entry=>entry.object.kind==="node"),groups:entries.filter(entry=>entry.object.kind==="group"),addedBlocks:entries.reduce((sum,entry)=>sum+entry.addedBlocks,0),updatedBlocks:entries.reduce((sum,entry)=>sum+entry.updatedBlocks,0),archivedBlocks:entries.reduce((sum,entry)=>sum+entry.archivedBlocks,0),assetCount:assets.size,identityOnlyPapers:entries.filter(entry=>entry.identityOnly&&!entry.deleted).length,blockTypes:entries.reduce((counts,entry)=>{for(const[type,count]of Object.entries(entry.blockTypes))counts[type]=(counts[type]??0)+count;return counts;},{}),imageAssets:[...assets].filter(id=>commands.store.get("assets",id)?.mediaType?.startsWith("image/")).length,...(conflict?{conflict}:{})};
}
export function pendingObjectCandidates(commands, owner, actor) {
  return commands.store.all("candidates").filter(candidate=>["pending","deferred"].includes(candidate.status)&&commands.visibleCandidate(candidate,actor)).map(candidate=>({id:candidate.id,revision:candidate.revision,status:candidate.status,reason:candidate.reason,summary:summarizeCandidate(commands,candidate)})).filter(candidate=>[...candidate.summary.nodes,...candidate.summary.groups].some(entry=>sameObject(entry.object,owner)));
}
export function pendingNodeCandidates(commands,nodeId,actor){return pendingObjectCandidates(commands,nodeRef(nodeId),actor);}
