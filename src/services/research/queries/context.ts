import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import * as z from "zod/v4";
import { versionHash } from "../../../lib/hash.js";
import { extractContentBlockText } from "../../../domain/research/content-blocks.js";
import { schemaRegistry } from "../../../domain/research/interfaces/schema-registry.js";
import { candidateReceipt, readCandidates } from "./proposal-queries.js";
import { scientificFactKeys, sourceCapabilities } from "./source-capabilities.js";
import { fail, principal } from "../../../domain/research/access.js";
import { nodeRef, groupRef, objectKey, sameObject } from "../../../domain/research/object-ref.js";
import { readGroups, groupSummary } from "./group-queries.js";
import { objectRefSchema } from "../../../domain/research/object-schemas.js";
import { compactSchemaOutput } from "../../../domain/research/interfaces/schema-output.js";
import type { ResearchCommandService } from "../research-command-service.js";
import type { ContentPayload, IndexedTable, TableHeaderContext, ReadDelivery, ReadReceipt, ResearchActor, ResearchCore, ResearchView, StoredBlock, StoredCandidate, StoredGroup, StoredNode, StoredResearchObject } from "../../../domain/research/types.js";
import type { ResearchObjectRef } from "../../../domain/research/object-ref.js";
export type QuerySelection = {offset?:number;length?:number;sheet?:string;rowOffset?:number;rowLimit?:number;columnKeys?:string[];itemOffset?:number;itemLimit?:number;names?:string[]};
export type QueryInput = {
  actor:ResearchActor; maxChars?:number; limit?:number; cursor?:string; locale?:string;
  candidateId?:string; patchId?:string; nodeId?:string; nodeIds?:string[]; groupId?:string; blockId?:string; assetId?:string;
  owner?:ResearchObjectRef; object?:ResearchObjectRef; mode?:string; view?:string; section?:string; scope?:string;
  query?:string; target?:string; kinds?:string[]; status?:string; idempotencyKey?:string; direction?:string; relationTypes?:string[];
  expectedRevision?:number; revision?:number; expectedVersion?:string; expectedContentVersion?:string; expectedChecksum?:string;
  ref?:string; offset?:number; factPaths?:string[]; name?:string; topic?:string;
  titleQuery?:string; types?:string[]; review?:string; representationId?:string; selection?:QuerySelection;
  decision?:string; reason?:string; [field:string]:unknown;
};
export type QueryEnvelope<T> = {
  schemaVersion:string;kind:string;projectId:string;scope:{state:string;candidateId?:string;candidateRevision?:number};stateVersion:string;
  data:T;coverage:{complete:boolean;omissions:string[]};budget:{maxChars:number;returnedChars:number};readReceipts?:ReadReceipt[];
};
type ReadDetails = {owner?:ResearchObjectRef;field?:string;source?:{ref:string;version:string|number|null|undefined};contentVersion?:string;blockId?:string;assetId?:string;checksum?:string;representationId?:string;sourceRefs?:StoredBlock["sourceRefs"];completeSourceAvailable?:boolean};
const clip=(v:unknown,n:number)=>String(v??"").slice(0,n),size=(v:unknown)=>JSON.stringify(v).length;
export class AgentResearchQueries {
  store;
  constructor(public c:ResearchCommandService){this.store=c.store;}
  envelope<T,E extends object = object>(kind:string,data:T,input:Partial<QueryInput>={},extra:E={} as E):QueryEnvelope<T> & E {
    const maxChars=input.maxChars??(kind==="schema"?8000:kind==="context"?3000:kind==="search"?4000:6000);
    if(!Number.isInteger(maxChars)||maxChars<2000||maxChars>16000)fail("CONTEXT_BUDGET_INVALID","maxChars must be 2000–16000.");
    const candidate=input.candidateId?this.c.changes.candidate(input.candidateId,input.actor??fail("AUTH_REQUIRED","A candidate read requires its actor.",401)):null;
    return {schemaVersion:"research-agent-result.v1",kind,projectId:this.c.projectId,scope:{state:candidate?"candidate":"formal",...(candidate?{candidateId:candidate.id,candidateRevision:candidate.revision}:{})},stateVersion:this.c.formalTopology().stateVersion,data,coverage:{complete:true,omissions:[]},...extra,budget:{maxChars,returnedChars:0}};
  }
  finish<T,R extends QueryEnvelope<T>>(r:R,receipts:ReadReceipt[]=[]):R {
    if(receipts.length)r.readReceipts=receipts;
    for(let i=0;i<6;i++)r.budget.returnedChars=size(r);
    if(size(r)>r.budget.maxChars)fail("CONTEXT_ITEM_TOO_LARGE","Requested item exceeds budget; narrow the selection or increase maxChars.");
    for(const receipt of receipts)this.store.put("receipts",receipt.id,receipt);
    return r;
  }
  receipt(actor:ResearchActor,kind:string,id:string,version:ReadReceipt["version"],disclosure:string,delivered:ReadDelivery,input:Partial<QueryInput>={},details:Partial<ReadReceipt>={}):ReadReceipt {return{id:"read:"+randomUUID(),projectId:this.c.projectId,principalId:principal(actor),researchSessionId:actor.sessionId??null,object:{kind,id},version,disclosure,delivered,scope:input.candidateId?"candidate":"formal",...(input.candidateId?{candidateId:input.candidateId,candidateRevision:this.c.changes.candidate(input.candidateId,actor).revision}:{}),...((details.owner??input.owner??input.object)?{owner:details.owner??input.owner??input.object}:{}),...details,at:new Date().toISOString()};}
  page<T,D extends object = object>(kind:string,entries:T[],input:QueryInput,binding:unknown,receiptFactory:((items:T[])=>ReadReceipt[])|null=null,data:D={} as D){
    if(input.limit!==undefined&&(!Number.isInteger(input.limit)||input.limit<1||input.limit>100))fail("INPUT_INVALID","limit must be 1–100.");
    const signature=(v:string)=>createHmac("sha256",this.store.get("settings","cursor").secret).update(v).digest("base64url");
    const fingerprint=versionHash({project:this.c.projectId,principal:principal(input.actor),binding});let offset=0;
    if(input.cursor){const[body,mac]=input.cursor.split(".");if(!body||!mac||mac.length!==signature(body).length||!timingSafeEqual(Buffer.from(mac),Buffer.from(signature(body))))fail("CURSOR_INVALID","Invalid cursor.");let decoded;try{decoded=JSON.parse(Buffer.from(body,"base64url").toString());}catch{fail("CURSOR_INVALID","Invalid cursor.");}if(decoded.binding!==fingerprint)fail("CURSOR_STALE","Query or collection changed.",409);offset=decoded.offset;if(!Number.isSafeInteger(offset)||offset<0||offset>entries.length)fail("CURSOR_INVALID","Invalid cursor offset.");}
    const r=this.envelope(kind,{...data,items:[] as T[]},input,{page:{nextCursor:null as string|null,total:entries.length}}),limit=input.limit??10;
    const update=()=>{const next=offset+r.data.items.length;if(next<entries.length){const b=Buffer.from(JSON.stringify({binding:fingerprint,offset:next})).toString("base64url");r.page.nextCursor=b+"."+signature(b);r.coverage={complete:false,omissions:["moreItems"]};}else{r.page.nextCursor=null;r.coverage={complete:true,omissions:[]};}};
    const receipts=()=>receiptFactory?receiptFactory(r.data.items):[];
    for(const item of entries.slice(offset,offset+limit)){r.data.items.push(item);update();r.readReceipts=receipts();if(size(r)+100>r.budget.maxChars){r.data.items.pop();break;}}
    if(!r.data.items.length&&entries.length>offset)fail("CONTEXT_ITEM_TOO_LARGE","A directory item exceeds the budget.");update();return this.finish(r,receipts());
  }
  coreRef(n:StoredResearchObject,field:string,owner:ResearchObjectRef=nodeRef(n.id)){return"core:"+Buffer.from(JSON.stringify({owner,field,version:n.coreRevision})).toString("base64url");}
  groupSummary(group:StoredGroup,view:ResearchView){return groupSummary(this,group,view);}
  readGroups(input:QueryInput){return readGroups(this,input);}
  blockSummary(b:StoredBlock){return{id:b.id,owner:b.owner,title:b.title,type:b.type,revision:b.revision,review:b.review,excerpt:clip(extractContentBlockText(b.type,b.payload),100),representations:(b.representations??[]).map(r=>({id:r.id,kind:r.kind,role:r.role})),readHint:{mode:"read",owner:b.owner,blockId:b.id,expectedRevision:b.revision,view:["metric","table","spreadsheet"].includes(b.type)?"values":["image","document","file","chart","experimentRecord"].includes(b.type)?"manifest":"text"}};}
  nodeSummary(n:StoredNode,view:ResearchView){const blocks=view.blocks.filter(b=>sameObject(b.owner,nodeRef(n.id))&&b.lifecycle!=="archived").sort((a,b)=>a.order-b.order);const core:ResearchCore & {authorCount?:number;[field:string]:unknown}={...n.core};if(core.authors){core.authorCount=core.authors.length;core.authors=core.authors.slice(0,3);}if(core.tags)core.tags=core.tags.slice(0,5);for(const[k,v]of Object.entries(core))if(typeof v==="string")core[k]=clip(v,k==="abstract"?240:500);return{id:n.id,kind:n.kind,label:n.core.nodeName,status:n.status,nodeRevision:n.revision,coreRevision:n.coreRevision,blockCollectionRevision:n.blockCollectionRevision,...(n.kind==="experiment"?{recordCollections:blocks.filter(b=>b.type==="experimentRecord").slice(0,6).map(b=>({blockId:b.id,title:b.title,revision:b.recordCollection?.revision??1,runCount:this.c.records.collectionRunCount(b)})),experimentReadHint:{tool:"read_experiment",mode:"runs",nodeId:n.id}}:{}),coreSummary:core,coreRefs:Object.fromEntries(Object.keys(n.core).map(k=>[k,{ref:this.coreRef(n,k),expectedVersion:String(n.coreRevision)}])),blockCount:blocks.length,blocks:blocks.slice(0,6).map(b=>this.blockSummary(b)),omittedBlocks:Math.max(0,blocks.length-6),groups:(view.groups??[]).filter(g=>g.members.some(m=>m.nodeId===n.id)).slice(0,5).map(g=>({id:g.id,label:clip(g.core.nodeName,80),readHint:{mode:"show",groupId:g.id}})),readHint:{mode:"list",owner:nodeRef(n.id)}};}
  brief(input:QueryInput){this.c.check(input.actor,"research.view");const graph=this.c.formalTopology(),nodes=this.c.nodes.nodes(),counts:Record<string,number>={};for(const n of nodes)counts[n.kind]=(counts[n.kind]??0)+1;return this.finish(this.envelope("context",{project:{id:this.c.projectId,name:this.c.projectName},counts:{nodes:nodes.length,groups:this.c.groups.list().length,relations:graph.edges.length,byKind:counts,pendingCandidates:this.store.all("candidates").filter(c=>c.status==="pending").length},retrieval:{method:"lexical",fullGraphIncluded:false,flow:"search → node overview → exact block/source range"}},input));}
  search(input:QueryInput){
    this.c.check(input.actor,"research.view");const q=String(input.query??"").normalize("NFKC").toLowerCase(),terms=[...new Set(q.match(/[\p{L}\p{N}_.:-]+/gu)??[])],entries=[],target=input.target??"all";
    const rank=(fields:string[])=>{const body=fields.join(" ").normalize("NFKC").toLowerCase();return terms.reduce((s,t)=>s+(body.includes(t)?1:0),0)+(body.includes(q)?3:0);};
    const view=this.c.snapshot(null,input.actor,{includeBlocks:target==="all"||target==="blocks",owners:input.owner?[input.owner]:undefined}),objectMap=new Map<string,StoredResearchObject>([...view.nodes.map(n=>[objectKey(nodeRef(n.id)),n] as const),...view.groups.map(g=>[objectKey(groupRef(g.id)),g] as const)]);
    if(target==="all"||target==="nodes")for(const n of view.nodes){if(input.kinds?.length&&!input.kinds.includes(n.kind)||input.status&&n.status!==input.status)continue;const score=rank([n.id,JSON.stringify(n.core)]);if(score)entries.push({objectType:"node",id:n.id,nodeId:n.id,kind:n.kind,label:clip(n.core.nodeName,160),version:n.coreRevision,score,readHint:{nodeIds:[n.id]}});}
    if(target==="all"||target==="groups")for(const g of view.groups){const score=rank([g.id,JSON.stringify(g.core)]);if(score)entries.push({objectType:"group",id:g.id,object:groupRef(g.id),label:clip(g.core.nodeName,160),version:g.revision,score,readHint:{mode:"show",groupId:g.id}});}
    if(target==="all"||target==="blocks")for(const b of view.blocks){const n=objectMap.get(objectKey(b.owner));if(!n||b.lifecycle==="archived"||input.owner&&!sameObject(b.owner,input.owner)||input.kinds?.length&&!input.kinds.includes(b.type)||input.status&&b.review!==input.status)continue;const content=extractContentBlockText(b.type,b.payload),score=rank([b.title,content]);if(score){const at=Math.max(0,content.toLowerCase().indexOf(terms[0]??q));entries.push({objectType:"block",id:b.id,owner:b.owner,label:clip(b.title,160),version:b.revision,snippet:content.slice(Math.max(0,at-60),at+180),score,readHint:this.blockSummary(b).readHint});}}
    if(target==="all"||target==="sources")for(const s of this.c.sources()){const indexed=this.c.sourceText?.(s),body=indexed??s.excerpt??"",score=rank([s.ref,s.label??"",body]);if(score){const at=Math.max(0,body.toLowerCase().indexOf(terms[0]??q));entries.push({objectType:"source",ref:s.ref,label:clip(s.label??s.ref,160),version:s.version??(s.hash?"sha256:"+s.hash:null),snippet:body.slice(Math.max(0,at-60),at+180),score,...sourceCapabilities(s,indexed)});}}
    if(target==="all"||target==="assets")for(const asset of this.store.all("assets")){
      const score=rank([asset.originalName]);if(!score)continue;
      try{this.c.assets.assert(asset.id,input.actor);}catch{continue;}
      entries.push({objectType:"asset",id:asset.id,label:clip(asset.originalName,160),version:asset.checksum,score,
        readHint:{assetId:asset.id,view:"metadata"},capabilities:{textAvailable:/\.(md|txt|tex|csv|json|jsonl|yaml|yml|toml|ini|cfg|py|sh|ps1|log|out)$/i.test(asset.originalName),valuesAvailable:Boolean(asset.previewKey)||/\.xlsx$/i.test(asset.originalName),originalAvailable:true},
        downloadHint:{direction:"download",target:{kind:"asset",assetId:asset.id,expectedChecksum:asset.checksum},variant:"original"}});
    }
    entries.sort((a,b)=>b.score-a.score||String(a.id??a.ref).localeCompare(String(b.id??b.ref)));return this.page("search",entries,{...input,maxChars:input.maxChars??4000,limit:input.limit??5},{query:q,target,nodeId:input.nodeId,kinds:input.kinds,status:input.status,versions:entries.map(e=>[e.id??e.ref,e.version])});
  }
  readNodes(input:QueryInput){this.c.check(input.actor,"research.view");const view=this.c.snapshot(input.candidateId,input.actor,{owners:input.nodeIds!.map(nodeRef)}),entries=input.nodeIds!.map(id=>{const n=view.nodes.find(n=>n.id===id);if(!n)fail("RESEARCH_NODE_NOT_FOUND","Node unavailable.",404);return this.nodeSummary(n,view);});return this.page("nodes",entries,{...input,limit:8},{ids:input.nodeIds,versions:entries.map(n=>n.nodeRevision),candidate:input.candidateId},items=>items.flatMap(n=>[this.receipt(input.actor,"core",n.id,n.coreRevision,"summary",{fields:Object.keys(n.coreSummary)},input,{owner:nodeRef(n.id)}),this.receipt(input.actor,"object",n.id,n.nodeRevision,"summary",{},input,{owner:nodeRef(n.id)})]));}
  neighbors(input:QueryInput){
    this.c.check(input.actor,"research.view");const view=this.c.snapshot(input.candidateId,input.actor,{includeBlocks:false}),direction=input.direction??"both",owner=input.object??fail("INPUT_INVALID","Supply an object reference.");
    const edges=this.c.objects.relations(owner,input.scope??"direct",view);
    const range=owner.kind==="group"&&input.scope==="groupBoundary"?this.c.groups.range(owner.id,view):null;
    const inside=(r:ResearchObjectRef)=>range?range.nodeIds.includes(r.id)&&r.kind==="node"||range.groupIds.includes(r.id)&&r.kind==="group":sameObject(r,owner);
    const entries=edges.filter(e=>(direction!=="in"&&inside(e.from)||direction!=="out"&&inside(e.to))&&(!input.relationTypes?.length||input.relationTypes.includes(e.type))).map(e=>({relation:e,neighbor:inside(e.from)?e.to:e.from}));
    const object=this.c.objects.from(view,owner);
    return this.page("neighbors",entries,input,{owner,direction,scope:input.scope,relations:input.relationTypes,version:versionHash(entries),candidate:input.candidateId},items=>[this.receipt(input.actor,"relation",owner.id,object.relationRevision,"directory",{relationIds:items.map(item=>item.relation.id)},input,{owner})]);
  }
  checkVersion(expected:unknown,actual:unknown){if(expected!==undefined&&expected!==actual)fail("OBJECT_VERSION_CONFLICT","Content version changed.",409,{expected,current:actual});}
  textResult(kind:string,body:string,input:QueryInput,object:{kind:string;id:string},version:ReadReceipt["version"],details:ReadDetails={}){
    const selection=input.selection??{offset:input.offset??0},start=selection.offset??0;
    if(!Number.isSafeInteger(start)||start<0||start>body.length||start>0&&/[\uDC00-\uDFFF]/.test(body[start]??""))fail("RANGE_INVALID","Invalid UTF-16 text boundary.");
    let end=Math.min(body.length,start+(selection.length??Math.max(1,(input.maxChars??6000)-1800)));const r=this.envelope(kind,{...details,text:"",range:{start,end,availableChars:body.length,nextOffset:null as number|null}},input);let receipt;
    for(;;){if(end>start&&/[\uD800-\uDBFF]/.test(body[end-1]??""))end--;r.data.text=body.slice(start,end);r.data.range={start,end,availableChars:body.length,nextOffset:end<body.length?end:null};receipt=this.receipt(input.actor,object.kind,object.id,version,"content",{textRanges:[{start,end}],...(details.field?{fields:[details.field]}:{})},input,details.contentVersion?{contentVersion:details.contentVersion}:{});r.readReceipts=[receipt];if(size(r)+40<=r.budget.maxChars)break;if(end<=start+1)fail("CONTEXT_ITEM_TOO_LARGE","Text metadata exceeds budget.");end=start+Math.floor((end-start)*.75);}
    r.coverage={complete:end>=Math.min(body.length,start+(selection.length??body.length)),omissions:end<body.length?["remainingText"]:[]};return this.finish(r,[receipt]);
  }
  async readSource(input:QueryInput){
    this.c.check(input.actor,"research.view");
    if(input.ref!.startsWith("core:")){
      let decoded:unknown;try{decoded=JSON.parse(Buffer.from(input.ref!.slice(5),"base64url").toString());}catch{fail("SOURCE_REF_INVALID","Invalid core ref.");}
      const parsed=z.strictObject({owner:objectRefSchema,field:z.string(),version:z.number()}).safeParse(decoded);if(!parsed.success)fail("SOURCE_REF_INVALID","Invalid core ref.");const ref=parsed.data;
      const n=this.c.objects.from(this.c.snapshot(input.candidateId,input.actor),ref.owner);this.checkVersion(input.expectedVersion,String(n.coreRevision));if(ref.version!==n.coreRevision)fail("OBJECT_VERSION_CONFLICT","Core changed.",409);if(!Object.hasOwn(n.core,ref.field))fail("SOURCE_REF_NOT_FOUND","Core field unavailable.",404);const value=n.core[ref.field as keyof typeof n.core];return this.textResult("source",typeof value==="string"?value:JSON.stringify(value),{...input,owner:ref.owner},{kind:"core",id:n.id},n.coreRevision,{owner:ref.owner,field:ref.field,source:{ref:input.ref!,version:String(n.coreRevision)}});
    }
    if(input.candidateId)fail("INPUT_INVALID","candidateId is only valid for candidate core refs; project sources are formal.");
    const s=this.c.sources().find(s=>s.ref===input.ref);if(!s)fail("SOURCE_REF_NOT_FOUND","Source unavailable.",404);const version=s.version??(s.hash?"sha256:"+s.hash:null);this.checkVersion(input.expectedVersion,version);
    const before=this.c.state.snapshot?.stateVersion;
    const source=s.ref.startsWith("file:")&&this.c.sourceReader?await this.c.sourceReader(s):{text:s.excerpt??null,complete:false};
    if(before!==this.c.state.snapshot?.stateVersion)fail("OBJECT_VERSION_CONFLICT","Source index changed during reading.",409);
    if(typeof source.text==="string")return this.textResult("source",source.text,input,{kind:"source",id:s.ref},version,{source:{ref:s.ref,version},completeSourceAvailable:Boolean(source.complete)});
    const roots=scientificFactKeys,facts:Record<string,unknown>={};for(const pointer of input.factPaths??[]){const keys=pointer.slice(1).split("/").map(k=>k.replace(/~1/g,"/").replace(/~0/g,"~"));if(!pointer.startsWith("/")||!roots.includes(keys[0])||keys.some(k=>/secret|token|credential|password|apikey/i.test(k)))fail("FACT_PATH_FORBIDDEN","Only scientific facts can be read.");let v:unknown=s;for(const k of keys){if(v===null||typeof v!=="object"||!Object.hasOwn(v,k))fail("FACT_PATH_NOT_FOUND","Unknown fact path.");v=(v as Record<string,unknown>)[k];}facts[pointer]=v;}
    if(!Object.keys(facts).length){const availability=sourceCapabilities(s);fail("NOT_INDEXED",availability.capabilities.valuesAvailable?"No text index; use the returned scientific fact paths.":availability.capabilities.originalAvailable?"No text index; read the original using native tools.":"No readable content is available for this source.",422,availability);}
    const receipt=this.receipt(input.actor,"source",s.ref,version,"structuredValues",{fields:Object.keys(facts)},input);return this.finish(this.envelope("source",{source:{ref:s.ref,version},facts},input),[receipt]);
  }
  async readBlocks(input:QueryInput){
    this.c.check(input.actor,"research.view");const view=this.c.snapshot(input.candidateId,input.actor,{owners:[input.owner!]}),node=this.c.objects.from(view,input.owner!);
    const siblings=view.blocks.filter(b=>sameObject(b.owner,input.owner)&&b.lifecycle!=="archived").sort((a,b)=>a.order-b.order);
    if(input.mode==="list"){const items=siblings.filter(b=>(!input.titleQuery||b.title.toLowerCase().includes(input.titleQuery.toLowerCase()))&&(!input.types?.length||input.types.includes(b.type))&&(!input.review||b.review===input.review)).map(b=>this.blockSummary(b));return this.page("blocks",items,{...input,maxChars:input.maxChars??4000},{owner:input.owner!,query:input.titleQuery,types:input.types,review:input.review,version:node.blockCollectionRevision,blockVersions:items.map(b=>b.revision),candidate:input.candidateId},()=>[this.receipt(input.actor,"collection",input.owner!.id,node.blockCollectionRevision,"directory",{},input,{owner:input.owner})]);}
    const current=siblings.find(b=>b.id===input.blockId),b=input.revision!==undefined&&current?.revision!==input.revision?this.c.objects.blockVersion(input.owner!,input.blockId!,input.revision):current;if(!b)fail("CONTENT_BLOCK_NOT_FOUND","Block unavailable.",404);this.checkVersion(input.expectedRevision,b.revision);
    if(input.view==="manifest"){const receipt=this.receipt(input.actor,"block",b.id,b.revision,"summary",{fields:["title","type","representations","sourceRefs"]},input);return this.finish(this.envelope("blocks",{block:this.blockSummary(b),representations:b.representations,sourceRefs:b.sourceRefs,...(b.type==="experimentRecord"?{provider:b.payload?.provider,recordCollectionId:b.id,runCount:this.c.records.collectionRunCount(b),readHint:{tool:"read_experiment",mode:"runs",nodeId:input.owner!.id,blockId:b.id}}:{})},input),[receipt]);}
    const rep=input.representationId==="inline"?null:input.representationId?b.representations.find(r=>r.id===input.representationId):b.primaryRepresentationId?b.representations.find(r=>r.id===b.primaryRepresentationId):b.payload&&(["richText","metric","link","quote","code","chart"].includes(b.type)||b.type==="table"&&b.payload.columns)?null:b.representations[0];
    if(input.representationId&&input.representationId!=="inline"&&!rep)fail("VIEW_UNAVAILABLE","Representation unavailable.");
    if(rep){if(rep.kind!=="asset")fail("VIEW_UNAVAILABLE","Link representation is not indexed content.");return this.readAssets({...input,assetId:rep.assetId,view:input.view}, {kind:"block",id:b.id,version:b.revision,representationId:rep.id});}
    if(input.view==="text"){if(!["richText","quote","code","link"].includes(b.type))fail("VIEW_UNAVAILABLE","Use values or manifest for this block.");return this.textResult("blocks",extractContentBlockText(b.type,b.payload),input,{kind:"block",id:b.id},b.revision,{blockId:b.id,sourceRefs:b.sourceRefs});}
    return this.valuesResult("blocks",b.payload,b.type,input,{kind:"block",id:b.id},b.revision,{sourceRefs:b.sourceRefs});
  }
  valuesResult(kind:string,table:(ContentPayload & Partial<Pick<IndexedTable,"grid"|"availableRows"|"rangeOffset"|"headerContext"|"sheetName">>)|null|undefined,type:string,input:QueryInput,object:{kind:string;id:string},version:ReadReceipt["version"],details:ReadDetails={}){
    type Cell=string|number|boolean|null;
    type MetricItem=NonNullable<ContentPayload["items"]>[number]&{index:number};
    type TableItem={index:number;values:Record<string,Cell>};
    const selection=input.selection??{};
    let items:(MetricItem|TableItem)[],range:{start:number;end:number};
    let fields:{itemOffset?:number;itemLimit?:number;totalItems?:number;columns?:{key:string;label:string}[];rowOffset?:number;rowLimit?:number;availableRows?:number;sheetName?:string;headers?:string[]|TableHeaderContext};
    if(type==="metric"){
      if(selection.sheet!==undefined||selection.rowOffset!==undefined||selection.rowLimit!==undefined||selection.columnKeys!==undefined)fail("RANGE_INVALID","Use metric selectors.");
      const all=(table?.items??[]).map((value,index)=>({index,...value})).filter(value=>!selection.names||selection.names.includes(value.name)),offset=selection.itemOffset??0;
      items=all.slice(offset,offset+(selection.itemLimit??20));fields={itemOffset:offset,itemLimit:selection.itemLimit??20,totalItems:all.length};range={start:offset,end:offset+items.length};
    }else{
      if(!table||!table.columns&&!table.grid)fail("VIEW_UNAVAILABLE","No structured values.");
      if(selection.itemOffset!==undefined||selection.itemLimit!==undefined||selection.names!==undefined)fail("RANGE_INVALID","Use table selectors.");
      const inlineColumns=table.columns??[],all=table.grid?table.grid.cells.map(row=>row.map(cell=>cell.covered?null:cell.value)):[inlineColumns.map(column=>column.label),...(table.rows??[]).map(row=>inlineColumns.map(column=>row[column.key]))];
      const columns=table.columns?.map((column,index)=>({key:column.key,label:column.label,index}))??(all[0]??[]).map((value,index)=>({key:"c"+(index+1),label:String(value??""),index}));
      const selected=selection.columnKeys?columns.filter(column=>selection.columnKeys!.includes(column.key)):columns.slice(0,12);
      if(selection.columnKeys?.some(key=>!selected.some(column=>column.key===key)))fail("RANGE_INVALID","Unknown column key.");
      const offset=selection.rowOffset??0,base=table.rangeOffset??0,total=table.availableRows??all.length;
      if(offset>=total&&total>0)fail("RANGE_INVALID","Row offset exceeds data.");
      items=all.slice(Math.max(0,offset-base),Math.max(0,offset-base)+(selection.rowLimit??20)).map((row,index)=>({index:offset+index,values:Object.fromEntries(selected.map(column=>[column.key,row[column.index]??null]))}));
      fields={columns:selected.map(column=>({key:column.key,label:column.label})),rowOffset:offset,rowLimit:selection.rowLimit??20,availableRows:total,sheetName:table.sheetName,headers:table.headerContext??columns.map(column=>column.label)};range={start:offset,end:offset+items.length};
    }
    if(items.length*(fields.columns?.length??1)>2000)fail("RANGE_INVALID","Select at most 2000 cells.");
    const requestedCount=items.length,result=this.envelope(kind,{...details,...fields,items,range,nextSelection:null as QuerySelection|null},input);let receipt:ReadReceipt;
    for(;;){range.end=range.start+result.data.items.length;receipt=this.receipt(input.actor,object.kind,object.id,version,"structuredValues",type==="metric"?{itemRanges:[{...range}]}:{tableRanges:[{...range,sheet:table?.sheetName,columns:fields.columns?.map(column=>column.key)??[]}]},input,details.contentVersion?{contentVersion:details.contentVersion}:{});result.readReceipts=[receipt];if(size(result)+50<=result.budget.maxChars)break;if(result.data.items.length<=1)fail("CONTEXT_ITEM_TOO_LARGE","One row exceeds budget; narrow columns.");result.data.items.pop();}
    const available=fields.totalItems??fields.availableRows??0;result.data.nextSelection=range.end<available?{...(type==="metric"?{itemOffset:range.end}:{rowOffset:range.end})}:null;result.coverage={complete:result.data.items.length===requestedCount,omissions:result.data.items.length<requestedCount?["remainingRows"]:[]};return this.finish(result,[receipt]);
  }
  async readAssets(input:QueryInput,block:{kind:string;id:string;version:ReadReceipt["version"];representationId?:string}|null=null){
    const a=this.c.assets.assert(input.assetId!,input.actor);this.checkVersion(input.expectedChecksum,a.checksum);this.checkVersion(input.expectedContentVersion,a.contentVersion);const view=input.view??"metadata",object=block??{kind:"asset",id:a.id,version:a.checksum};
    const recordProvider=/\.wandb$/i.test(a.originalName)?"wandb":/tfevents/i.test(a.originalName)?"tensorboard":null;
    if(view==="metadata")return this.finish(this.envelope("asset",{asset:this.c.assets.public(a),availability:a.processing,...(recordProvider?{recordReadHint:{tool:"read_experiment",mode:"inspect",provider:recordProvider,assetIds:[a.id]}}:{}),capabilities:{text:/\.(md|txt|tex|csv|json|jsonl|yaml|yml|toml|ini|cfg|py|sh|ps1|log|out)$/i.test(a.originalName),values:Boolean(a.previewKey)||/\.xlsx$/i.test(a.originalName)},jobs:this.store.all("jobs").filter(j=>j.assetId===a.id).slice(0,5).map(j=>({id:j.id,status:j.status})),readHint:{assetId:a.id,expectedChecksum:a.checksum,expectedContentVersion:a.contentVersion}},input));
    const details={assetId:a.id,checksum:a.checksum,contentVersion:a.contentVersion??a.checksum,...(block?{blockId:block.id,representationId:block.representationId}:{})};
    if(view==="text"){if(!/\.(md|txt|tex|csv|json|jsonl|yaml|yml|toml|ini|cfg|py|sh|ps1|log|out)$/i.test(a.originalName))fail("NOT_INDEXED","No text index. Download for native reading.");return this.textResult(block?"blocks":"asset",this.c.assets.textSync(a.id,input.actor),input,object,object.version,details);}
    const table=await this.c.assets.values(a.id,input.actor,input.selection);return this.valuesResult(block?"blocks":"asset",table,"table",input,object,object.version,details);
  }
  candidateReceipt(candidate:StoredCandidate & {idempotent?:boolean}, actor:ResearchActor) { return candidateReceipt(this, candidate, actor); }
  candidates(input:QueryInput) { return readCandidates(this, input); }
  schema(input:QueryInput) {
    this.c.check(input.actor, "research.view");
    const registry = schemaRegistry[input.topic as keyof typeof schemaRegistry], names = Object.keys(registry);
    if (!input.name) return this.finish(this.envelope("schema", { topic: input.topic, availableNames: names }, input));
    const entry = Object.hasOwn(registry, input.name) ? registry[input.name] : null;
    if (!entry) fail("SCHEMA_NOT_FOUND", "Unknown schema name. Use one of availableNames exactly.", 404, {
      field: "name", actual: input.name, topic: input.topic, availableNames: names,
      recovery: { tool: "get_schema", input: { topic: input.topic, name: names[0] } },
    });
    const json = compactSchemaOutput(z.toJSONSchema(entry.schema, { reused: "ref" })); delete json.$schema;
    return this.finish(this.envelope("schema", {
      schemaId: input.topic + ":" + input.name, schemaVersion: "2", schemaHash: versionHash(json),
      schema: json, example: entry.example,
    }, { ...input, maxChars: 16000 }));
  }
}
