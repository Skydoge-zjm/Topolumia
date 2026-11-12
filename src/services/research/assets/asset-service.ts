import { omitFields } from "../../../domain/research/object-values.js";
import { sameObject } from "../../../domain/research/object-ref.js";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fail, principal } from "../../../domain/research/access.js";
import { versionHash } from "../../../lib/hash.js";
import { importTablePreview, exportXlsxTable, exportTexTable } from "../../topology/table-importers.js";
import { compileTexTable } from "../../topology/tex-preview.js";
import type { ResearchCommandService } from "../research-command-service.js";
import type { ExportTarget, IndexedTable, ResearchActor, StoredAsset, StoredAssetJob } from "../../../domain/research/types.js";
import type { QuerySelection } from "../queries/context.js";
export type UploadMetadata={originalName?:string;mediaType?:string;idempotencyKey?:string;sizeBytes?:string|number;checksum?:string};
export type AssetExportInput={target:ExportTarget;variant:string;destinationDigest?:string;idempotencyKey:string};
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const MAX_BYTES = 20 * 1024 * 1024;
const hash = (b:string|NodeJS.ArrayBufferView) => "sha256:" + createHash("sha256").update(b).digest("hex");
export class ResearchAssetService {
  store;
  pending=new Set<Promise<void>>();
  queue:{job:StoredAssetJob;resolve:()=>void}[]=[];
  active=0;
  closed=false;
  constructor(public commands:ResearchCommandService, public root:string) { this.store=commands.store; }
  async initialize() {
    await mkdir(this.root,{recursive:true});
    for (const job of this.store.all("jobs")) if (["queued","running"].includes(job.status)) this.enqueue({...job,status:"queued"});
    await this.collect();
  }
  public(asset:StoredAsset) { const {compiled,recordManifests,tableSheetFacts}=asset,publicData=omitFields(asset,["storageKey","previewKey","compiled","owner","sessionId","recordManifests","tableSheetFacts"]); return {...publicData,...(tableSheetFacts?{indexedSheetCount:Object.keys(tableSheetFacts).length}:{}),...(recordManifests ? {recordSummary:Object.fromEntries(Object.entries(recordManifests).map(([provider,manifest])=>[provider,{runCount:manifest.sourceIds.length}]))} : {}),compiled:compiled ? {state:compiled.state,pdf:compiled.pdf ? true : null,image:compiled.image ? true : null,error:compiled.error} : null}; }
  assert(id:string,actor:ResearchActor) {
    this.commands.check(actor,"research.view"); const a=this.store.get("assets",id);
    if (!a) fail("ASSET_NOT_FOUND","Asset unavailable.",404);
    if (a.bindingState!=="attached" && a.bindingState!=="retained" && a.owner!==principal(actor)) {
      const canReview=!actor.isAgent && actor.permissions?.some(p=>["*","research.applyChange","research.review"].includes(p));
      const shared=this.store.all("candidates").some(c=>c.assetIds?.includes(id) && this.commands.visibleCandidate(c,actor));
      if (!canReview && !actor.isServerAdmin && !shared) fail("ASSET_NOT_FOUND","Asset unavailable.",404);
    }
    return a;
  }
  file(a:Pick<StoredAsset,"storageKey">) { const file=path.resolve(this.root,a.storageKey);if(!file.startsWith(path.resolve(this.root)+path.sep))fail("ASSET_UNAVAILABLE","Invalid asset storage key.",404);return file; }
  textSync(id:string,actor:ResearchActor) { const a=this.assert(id,actor), bytes=readFileSync(this.file(a)); if (bytes.length>MAX_BYTES) fail("ASSET_SIZE_INVALID","File too large.",413); try { return new TextDecoder("utf-8",{fatal:true}).decode(bytes).replace(/^\uFEFF/,""); } catch { fail("ASSET_ENCODING_INVALID","A valid UTF-8 text file is required."); } }
  async upload(stream:AsyncIterable<string|Uint8Array>,meta:UploadMetadata,actor:ResearchActor) {
    this.commands.check(actor,actor.isAgent?"research.proposeChange":"research.applyChange");
    const name=String(meta.originalName??"file").replace(/./gs,char=>char.charCodeAt(0)<32||char==="/"||char==="\\"?"_":char).slice(0,240);
    const mediaType=String(meta.mediaType??"application/octet-stream");
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mediaType)) fail("ASSET_MEDIA_UNSUPPORTED","Invalid media type.");
    if (!meta.idempotencyKey || String(meta.idempotencyKey).length>240) fail("IDEMPOTENCY_KEY_REQUIRED","A stable upload key is required.");
    const temp="incoming/"+randomUUID()+".part"; await mkdir(path.join(this.root,"incoming"),{recursive:true});
    const file=await open(path.join(this.root,temp),"wx"); const digest=createHash("sha256"); let size=0;
    try { for await (const raw of stream) { const chunk=Buffer.from(raw); size+=chunk.length; if(size>MAX_BYTES) fail("ASSET_SIZE_INVALID","File exceeds 20 MiB.",413); digest.update(chunk); await file.writeFile(chunk); } }
    catch(error) { await file.close();await rm(path.join(this.root,temp),{force:true});throw error; }
    await file.close(); const checksum="sha256:"+digest.digest("hex");
    try {
      if (!size || meta.sizeBytes!==undefined && Number(meta.sizeBytes)!==size) fail("ASSET_SIZE_INVALID","Empty or incomplete upload.",413);
      if(meta.checksum && meta.checksum!==checksum) fail("CHECKSUM_MISMATCH","File checksum changed.",409);
      const key=versionHash({owner:principal(actor),key:meta.idempotencyKey}), fingerprint=versionHash({checksum,name,mediaType});
      const previous=this.store.get("uploads",key);
      if(previous) { if(previous.fingerprint!==fingerprint) fail("IDEMPOTENCY_CONFLICT","Upload key was reused for different bytes.",409); return this.public(this.assert(previous.assetId,actor)); }
      const id="asset:"+randomUUID(), storageKey="objects/"+id.slice(6)+"/original";
      await mkdir(path.dirname(path.join(this.root,storageKey)),{recursive:true}); await rename(path.join(this.root,temp),path.join(this.root,storageKey));
      const asset:StoredAsset={id,projectId:this.commands.projectId,originalName:name,mediaType,sizeBytes:size,checksum,storageKey,owner:principal(actor),sessionId:actor.sessionId??null,bindingState:"staged",processing:"queued",createdAt:new Date().toISOString(),createdBy:actor.user?.id??principal(actor)};
      this.store.transaction(()=>{ const again=this.store.get("uploads",key);if(again) fail("IDEMPOTENCY_CONFLICT","Concurrent upload; retry the original key.",409); this.store.put("assets",id,asset);this.store.put("uploads",key,{assetId:id,fingerprint});this.store.put("jobs",id,{id,assetId:id,type:"index",status:"queued"}); });
      this.enqueue(this.store.get("jobs",id)); return this.public(asset);
    } finally { await rm(path.join(this.root,temp),{force:true}); }
  }
  enqueue(job:StoredAssetJob|null) {
    if(this.closed||!job)return;
    let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;}).finally(()=>{this.pending.delete(promise);});this.pending.add(promise);this.queue.push({job,resolve});this.drain();
  }
  drain(){
    if(this.closed){for(const item of this.queue.splice(0))item.resolve();return;}
    while(this.active<2&&this.queue.length){const {job,resolve}=this.queue.shift()!;this.active++;Promise.resolve().then(()=>this.process(job)).catch(()=>{}).finally(()=>{this.active--;resolve();this.drain();});}
  }
  async process(job:StoredAssetJob) {
    if(this.closed) return; this.store.put("jobs",job.id,{...job,status:"running"});
    try {
      if(job.type==="export") { await this.processExport(job);return; }
      const a=job.assetId?this.store.get("assets",job.assetId):null; if(!a)return;
      const supported=/\.(xlsx|csv|tex)$/i.test(a.originalName)||/spreadsheetml|x-tex|latex/i.test(a.mediaType);
      const bytes=/\.tex$/i.test(a.originalName)?await readFile(this.file(a)):Buffer.alloc(0), preview:IndexedTable|null=supported?await this.commands.records.task({action:"table",asset:{...a,file:this.file(a)}}):null;
      let previewKey:string|undefined,compiled:StoredAsset["compiled"]=null;
      if(preview) { previewKey="derived/"+a.id.slice(6)+"/table-v2/preview.json";await mkdir(path.dirname(path.join(this.root,previewKey)),{recursive:true});await writeFile(path.join(this.root,previewKey),JSON.stringify(preview)); }
      if(/\.tex$/i.test(a.originalName)) compiled=await compileTexTable(bytes,path.join(this.root,"derived",a.id.slice(6),"tex-v1"));
      const current=this.store.get("assets",a.id); if(!current)return;this.store.put("assets",a.id,{...current,previewKey,compiled,processing:preview||compiled?"ready":"notSupported",sheetNames:preview?.sheetNames??(preview?.sheetName?[preview.sheetName]:[]),defaultSheet:preview?.sheetName,availableRows:preview&&preview.totalRows!==undefined?preview.totalRows+1:undefined,contentVersion:versionHash({checksum:a.checksum,processor:"table-v2"})});
      this.store.put("jobs",job.id,{...job,status:"ready"});
    } catch(error) { const a=job.assetId?this.store.get("assets",job.assetId):null; if(a)this.store.put("assets",a.id,{...a,processing:"failed",diagnostic:message(error).slice(0,240)});this.store.put("jobs",job.id,{...job,status:"failed",error:message(error).slice(0,240)}); }
  }
  async preview(id:string,actor:ResearchActor) { const a=this.assert(id,actor); return {asset:this.public(a),preview:a.previewKey?JSON.parse(await readFile(path.join(this.root,a.previewKey),"utf8")) as IndexedTable:null,error:a.diagnostic??null}; }
  async values(id:string,actor:ResearchActor,selection:QuerySelection={}) {
    const a=this.assert(id,actor);
    let table:IndexedTable|null|undefined;
    if(/\.xlsx$/i.test(a.originalName)) table=await this.commands.records.task({action:"table",asset:{...a,file:this.file(a)},selection});
    else if(/\.csv$/i.test(a.originalName)) {
      if(selection.sheet)fail("RANGE_INVALID","CSV files have no named worksheets.",422);
      table=await this.commands.records.task({action:"table",asset:{...a,file:this.file(a)},selection});
    }
    else { let preview;try {preview=(await this.preview(id,actor)).preview;} catch(error){if(!(error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT"))throw error;}table=preview??await importTablePreview(await readFile(this.file(a)),a.originalName,a.mediaType); }
    if(!table)fail("NOT_INDEXED","No table index is available.");
    const sheet=table.sheetName??"",rowCount=table.availableRows??(table.totalRows!==undefined?table.totalRows+1:table.grid?.cells?.length??(table.rows?.length??0)+1),current=this.store.get("assets",id);
    if(current&&(current.tableSheetFacts?.[sheet]?.checksum!==a.checksum||current.tableSheetFacts?.[sheet]?.rowCount!==rowCount||selection.sheet===undefined&&table.sheetName&&!current.defaultSheet))this.store.put("assets",id,{...current,...(selection.sheet===undefined&&table.sheetName&&!current.defaultSheet?{defaultSheet:table.sheetName}:{}),tableSheetFacts:{...current.tableSheetFacts,[sheet]:{checksum:a.checksum,rowCount}}});
    return table;
  }
  pin(ids:Iterable<string>,state:string) { for(const id of ids) {const a=this.store.get("assets",id);if(a && !(state==="pinned" && ["attached","retained"].includes(a.bindingState)))this.store.put("assets",id,{...a,bindingState:state});} }
  async content(id:string,variant:string,actor:ResearchActor) {
    const a=this.assert(id,actor);let file=this.file(a),mediaType=a.mediaType;
    if(variant!=="original") {if(a.compiled?.state!=="ready")fail("VARIANT_UNAVAILABLE","Compiled variant is unavailable.");const name=variant==="compiledPdf"?"preview.pdf":variant==="previewImage"?"preview.png":null;if(!name)fail("VARIANT_UNAVAILABLE","Unknown file variant.");file=path.join(this.root,"derived",a.id.slice(6),"tex-v1",name);mediaType=name.endsWith("pdf")?"application/pdf":"image/png";}
    const info=await stat(file).catch(()=>null);if(!info)fail("ASSET_UNAVAILABLE","Asset bytes are unavailable.",404);
    return {file,mediaType,sizeBytes:info.size,name:a.originalName,checksum:variant==="original"?a.checksum:hash(await readFile(file))};
  }
  async export(input:AssetExportInput,actor:ResearchActor) {
    this.commands.check(actor,"research.view"); const fingerprint=versionHash({target:input.target,variant:input.variant,destinationDigest:input.destinationDigest}), id=versionHash({owner:principal(actor),key:input.idempotencyKey});
    const previous=this.store.get("jobs",id);
    if(previous) {if(previous.fingerprint!==fingerprint)fail("IDEMPOTENCY_CONFLICT","Download key was reused.",409); if(previous.status==="failed")fail("COMPLETE_EXPORT_UNAVAILABLE",previous.error??"Export failed.");return this.exportResult(previous,actor);}
    if(input.target.kind==="recordAttachment") {
      if(input.variant!=="original")fail("VARIANT_UNAVAILABLE","Record attachments support original bytes only.");
      this.commands.ingestion.block(input.target.blockId,actor);
      const snapshot=input.target.snapshotId?this.commands.ingestion.getSnapshot(input.target.snapshotId,actor):null;
      if(snapshot&&snapshot.blockId!==input.target.blockId)fail("INGESTION_SCOPE_MISMATCH","Snapshot belongs to another block.",403);
      const blob=this.commands.projectRecords.attachment(snapshot?.block??this.commands.ingestion.block(input.target.blockId,actor),input.target.sha256,snapshot);
      const job:StoredAssetJob={id,type:"download",target:input.target,status:"ready",fingerprint,checksum:"sha256:"+input.target.sha256,sizeBytes:blob.size}; this.store.put("jobs",id,job);return this.exportResult(job,actor);
    }
    if(input.target.kind==="asset") {
      const a=this.assert(input.target.assetId,actor);if(input.target.expectedChecksum&&input.target.expectedChecksum!==a.checksum)fail("OBJECT_VERSION_CONFLICT","Asset version changed.",409);
      if(!["original","compiledPdf","previewImage"].includes(input.variant))fail("VARIANT_UNAVAILABLE","Asset variant unsupported.");
      if(input.variant!=="original"&&["queued","running"].includes(a.processing)) return {status:"pending",operationId:id,taskId:a.id};
      const info=await this.content(a.id,input.variant,actor),job:StoredAssetJob={id,type:"download",status:"ready",fingerprint,assetId:a.id,variant:input.variant,checksum:info.checksum,sizeBytes:info.sizeBytes}; this.store.put("jobs",id,job);return this.exportResult(job,actor);
    }
    const target=input.target,view=this.commands.snapshot(target.candidateId,actor), block=view.blocks.find(b=>b.id===target.blockId&&sameObject(b.owner,target.owner)&&b.lifecycle!=="archived");
    if(!block)fail("CONTENT_BLOCK_NOT_FOUND","Block unavailable.",404);if(block.revision!==input.target.expectedRevision)fail("OBJECT_VERSION_CONFLICT","Block changed.",409);
    if(!["xlsx","tex"].includes(input.variant))fail("VARIANT_UNAVAILABLE","Block export format unsupported.");
    const job:StoredAssetJob={id,type:"export",status:"queued",fingerprint,target:input.target,variant:input.variant,block,owner:principal(actor),actor};this.store.put("jobs",id,job);this.enqueue(job);return {status:"pending",operationId:id,taskId:id};
  }
  exportResult(job:StoredAssetJob,actor:ResearchActor) {
    if(job.status!=="ready")return{status:"pending",operationId:job.id,taskId:job.id};
    if(job.target?.kind==="recordAttachment"){this.commands.ingestion.block(job.target.blockId,actor);const snapshot=job.target.snapshotId?this.commands.ingestion.getSnapshot(job.target.snapshotId,actor):null;this.commands.projectRecords.attachment(snapshot?.block??this.commands.ingestion.block(job.target.blockId,actor),job.target.sha256,snapshot);return{status:"ready",operationId:job.id,checksum:job.checksum,sizeBytes:job.sizeBytes,contentPath:"/api/research/record-blocks/"+encodeURIComponent(job.target.blockId)+"/attachments/"+job.target.sha256+(snapshot?"?snapshotId="+encodeURIComponent(snapshot.id):"")};}
    if(!job.assetId)fail("ASSET_NOT_FOUND","Export asset unavailable.",404);this.assert(job.assetId,actor);return{status:"ready",operationId:job.id,assetId:job.assetId,checksum:job.checksum,sizeBytes:job.sizeBytes,contentPath:"/api/research/assets/"+encodeURIComponent(job.assetId)+"/content?variant="+(job.variant??"original")};
  }
  async processExport(job:StoredAssetJob) {
    try {
      const b=job.block,target=job.target,actor=job.actor;if(!b||!target||target.kind!=="block"||!actor)fail("COMPLETE_EXPORT_UNAVAILABLE","Export job is incomplete.");let table=b.payload as IndexedTable|undefined;
      if(!table?.columns) {const rep=b.representations?.find(r=>r.id===(target.representationId??b.primaryRepresentationId))??b.representations?.find(r=>r.kind==="asset");if(!rep||rep.kind!=="asset")fail("COMPLETE_EXPORT_UNAVAILABLE","No structured table representation.");table=(await this.preview(rep.assetId,actor)).preview??undefined;}
      if(!table||table.truncated)fail("COMPLETE_EXPORT_UNAVAILABLE","Complete table data is unavailable; download the original.");
      const bytes=job.variant==="xlsx"?Buffer.from(exportXlsxTable(table,b.title)):Buffer.from(exportTexTable(table));const id="asset:"+randomUUID(), storageKey="objects/"+id.slice(6)+"/original";await mkdir(path.dirname(path.join(this.root,storageKey)),{recursive:true});await writeFile(path.join(this.root,storageKey),bytes);
      const asset:StoredAsset={id,projectId:this.commands.projectId,storageKey,originalName:b.title+"."+job.variant,mediaType:job.variant==="xlsx"?"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"application/x-tex",sizeBytes:bytes.length,checksum:hash(bytes),owner:job.owner??principal(actor),bindingState:"staged",processing:"notSupported",createdAt:new Date().toISOString(),role:"export"};this.store.put("assets",id,asset);this.store.put("jobs",job.id,{...job,actor:undefined,block:undefined,status:"ready",assetId:id,variant:"original",checksum:asset.checksum,sizeBytes:asset.sizeBytes});
    }catch(e){this.store.put("jobs",job.id,{...job,actor:undefined,block:undefined,status:"failed",error:message(e).slice(0,240)});}
  }
  async collect() {
    const pinned=new Set(this.store.all("candidates").flatMap(c=>c.assetIds??[]));
    for(const a of this.store.all("assets")) if(a.bindingState==="staged"&&!pinned.has(a.id)&&Date.now()-Date.parse(a.createdAt)>86400000) {await rm(path.dirname(this.file(a)),{recursive:true,force:true});this.store.remove("assets",a.id);}
  }
  async close() { this.closed=true;this.drain();await Promise.allSettled([...this.pending]); }
}
