import { sameObject } from "../../../domain/research/object-ref.js";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fail, principal } from "../../../domain/research/access.js";
import { versionHash } from "../../../lib/hash.js";
import { importTablePreview, parseXlsxTable, exportXlsxTable, exportTexTable } from "../../topology/table-importers.js";
import { compileTexTable } from "../../topology/tex-preview.js";
const MAX_BYTES = 20 * 1024 * 1024;
const hash = b => "sha256:" + createHash("sha256").update(b).digest("hex");
export class ResearchAssetService {
  constructor(commands, root) { this.commands=commands; this.store=commands.store; this.root=root; this.pending=new Set(); this.queue=[]; this.active=0; this.closed=false; }
  async initialize() {
    await mkdir(this.root,{recursive:true});
    for (const job of this.store.all("jobs")) if (["queued","running"].includes(job.status)) this.enqueue({...job,status:"queued"});
    await this.collect();
  }
  public(asset) { const {storageKey,previewKey,compiled,owner,sessionId,recordManifests,tableSheetFacts,...publicData}=asset; return {...publicData,...(tableSheetFacts?{indexedSheetCount:Object.keys(tableSheetFacts).length}:{}),...(recordManifests ? {recordSummary:Object.fromEntries(Object.entries(recordManifests).map(([provider,manifest]:[string,any])=>[provider,{runCount:manifest.sourceIds.length}]))} : {}),compiled:compiled ? {state:compiled.state,pdf:compiled.pdf ? true : null,image:compiled.image ? true : null,error:compiled.error} : null}; }
  assert(id,actor) {
    this.commands.check(actor,"research.view"); const a=this.store.get("assets",id);
    if (!a) fail("ASSET_NOT_FOUND","Asset unavailable.",404);
    if (a.bindingState!=="attached" && a.bindingState!=="retained" && a.owner!==principal(actor)) {
      const canReview=!actor.isAgent && actor.permissions?.some(p=>["*","research.applyChange","research.review"].includes(p));
      const shared=this.store.all("candidates").some(c=>c.assetIds?.includes(id) && this.commands.visibleCandidate(c,actor));
      if (!canReview && !actor.isServerAdmin && !shared) fail("ASSET_NOT_FOUND","Asset unavailable.",404);
    }
    return a;
  }
  file(a) { const file=path.resolve(this.root,a.storageKey);if(!file.startsWith(path.resolve(this.root)+path.sep))fail("ASSET_UNAVAILABLE","Invalid asset storage key.",404);return file; }
  textSync(id,actor) { const a=this.assert(id,actor), bytes=readFileSync(this.file(a)); if (bytes.length>MAX_BYTES) fail("ASSET_SIZE_INVALID","File too large.",413); try { return new TextDecoder("utf-8",{fatal:true}).decode(bytes).replace(/^\uFEFF/,""); } catch { fail("ASSET_ENCODING_INVALID","A valid UTF-8 text file is required."); } }
  async upload(stream,meta,actor) {
    this.commands.check(actor,actor.isAgent?"research.proposeChange":"research.applyChange");
    const name=String(meta.originalName??"file").replace(/[\u0000-\u001f\\/]/g,"_").slice(0,240);
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
      const asset={id,projectId:this.commands.projectId,originalName:name,mediaType,sizeBytes:size,checksum,storageKey,owner:principal(actor),sessionId:actor.sessionId??null,bindingState:"staged",processing:"queued",createdAt:new Date().toISOString(),createdBy:actor.user?.id??principal(actor)};
      this.store.transaction(()=>{ const again=this.store.get("uploads",key);if(again) fail("IDEMPOTENCY_CONFLICT","Concurrent upload; retry the original key.",409); this.store.put("assets",id,asset);this.store.put("uploads",key,{assetId:id,fingerprint});this.store.put("jobs",id,{id,assetId:id,type:"index",status:"queued"}); });
      this.enqueue(this.store.get("jobs",id)); return this.public(asset);
    } finally { await rm(path.join(this.root,temp),{force:true}); }
  }
  enqueue(job) {
    if(this.closed)return;
    let resolve;const promise=new Promise(r=>{resolve=r;}).finally(()=>this.pending.delete(promise));this.pending.add(promise);this.queue.push({job,resolve});this.drain();
  }
  drain(){
    if(this.closed){for(const item of this.queue.splice(0))item.resolve();return;}
    while(this.active<2&&this.queue.length){const {job,resolve}=this.queue.shift();this.active++;Promise.resolve().then(()=>this.process(job)).catch(()=>{}).finally(()=>{this.active--;resolve();this.drain();});}
  }
  async process(job) {
    if(this.closed) return; this.store.put("jobs",job.id,{...job,status:"running"});
    try {
      if(job.type==="export") { await this.processExport(job);return; }
      const a=this.store.get("assets",job.assetId); if(!a)return;
      const bytes=await readFile(this.file(a)), preview=await importTablePreview(bytes,a.originalName,a.mediaType);
      let previewKey,compiled=null;
      if(preview) { previewKey="derived/"+a.id.slice(6)+"/table-v2/preview.json";await mkdir(path.dirname(path.join(this.root,previewKey)),{recursive:true});await writeFile(path.join(this.root,previewKey),JSON.stringify(preview)); }
      if(/\.tex$/i.test(a.originalName)) compiled=await compileTexTable(bytes,path.join(this.root,"derived",a.id.slice(6),"tex-v1"));
      const current=this.store.get("assets",a.id); this.store.put("assets",a.id,{...current,previewKey,compiled,processing:preview||compiled?"ready":"notSupported",sheetNames:preview?.sheetNames??(preview?.sheetName?[preview.sheetName]:[]),defaultSheet:preview?.sheetName,availableRows:preview?preview.totalRows+1:undefined,contentVersion:versionHash({checksum:a.checksum,processor:"table-v2"})});
      this.store.put("jobs",job.id,{...job,status:"ready"});
    } catch(error) { const a=this.store.get("assets",job.assetId); if(a)this.store.put("assets",a.id,{...a,processing:"failed",diagnostic:String(error.message).slice(0,240)});this.store.put("jobs",job.id,{...job,status:"failed",error:String(error.message).slice(0,240)}); }
  }
  async preview(id,actor) { const a=this.assert(id,actor); return {asset:this.public(a),preview:a.previewKey?JSON.parse(await readFile(path.join(this.root,a.previewKey),"utf8")):null,error:a.diagnostic??null}; }
  async values(id,actor,selection={}) {
    const a=this.assert(id,actor);
    let table;
    if(/\.xlsx$/i.test(a.originalName)) table=await parseXlsxTable(await readFile(this.file(a)),{sheetName:selection.sheet,range:{offset:selection.rowOffset??0,limit:selection.rowLimit??20,columnKeys:selection.columnKeys}});
    else if(/\.csv$/i.test(a.originalName)) {
      if(selection.sheet)fail("RANGE_INVALID","CSV files have no named worksheets.",422);
      table=await importTablePreview(await readFile(this.file(a)),a.originalName,a.mediaType,{range:{offset:selection.rowOffset??0,limit:selection.rowLimit??20,columnKeys:selection.columnKeys}});
    }
    else { let preview;try {preview=(await this.preview(id,actor)).preview;} catch(error){if(error.code!=="ENOENT")throw error;}table=preview??await importTablePreview(await readFile(this.file(a)),a.originalName,a.mediaType); }
    if(!table)fail("NOT_INDEXED","No table index is available.");
    const sheet=table.sheetName??"",rowCount=table.availableRows??(table.totalRows!==undefined?table.totalRows+1:table.grid?.cells?.length??(table.rows?.length??0)+1),current=this.store.get("assets",id);
    if(current&&(current.tableSheetFacts?.[sheet]?.checksum!==a.checksum||current.tableSheetFacts?.[sheet]?.rowCount!==rowCount||selection.sheet===undefined&&table.sheetName&&!current.defaultSheet))this.store.put("assets",id,{...current,...(selection.sheet===undefined&&table.sheetName&&!current.defaultSheet?{defaultSheet:table.sheetName}:{}),tableSheetFacts:{...current.tableSheetFacts,[sheet]:{checksum:a.checksum,rowCount}}});
    return table;
  }
  pin(ids,state) { for(const id of ids) {const a=this.store.get("assets",id);if(a && !(state==="pinned" && ["attached","retained"].includes(a.bindingState)))this.store.put("assets",id,{...a,bindingState:state});} }
  async content(id,variant,actor) {
    const a=this.assert(id,actor);let file=this.file(a),mediaType=a.mediaType;
    if(variant!=="original") {if(a.compiled?.state!=="ready")fail("VARIANT_UNAVAILABLE","Compiled variant is unavailable.");const name=variant==="compiledPdf"?"preview.pdf":variant==="previewImage"?"preview.png":null;if(!name)fail("VARIANT_UNAVAILABLE","Unknown file variant.");file=path.join(this.root,"derived",a.id.slice(6),"tex-v1",name);mediaType=name.endsWith("pdf")?"application/pdf":"image/png";}
    const info=await stat(file).catch(()=>null);if(!info)fail("ASSET_UNAVAILABLE","Asset bytes are unavailable.",404);
    return {file,mediaType,sizeBytes:info.size,name:a.originalName,checksum:variant==="original"?a.checksum:hash(await readFile(file))};
  }
  async export(input,actor) {
    this.commands.check(actor,"research.view"); const fingerprint=versionHash({target:input.target,variant:input.variant,destinationDigest:input.destinationDigest}), id=versionHash({owner:principal(actor),key:input.idempotencyKey});
    const previous=this.store.get("jobs",id);
    if(previous) {if(previous.fingerprint!==fingerprint)fail("IDEMPOTENCY_CONFLICT","Download key was reused.",409); if(previous.status==="failed")fail("COMPLETE_EXPORT_UNAVAILABLE",previous.error);return this.exportResult(previous,actor);}
    if(input.target.kind==="asset") {
      const a=this.assert(input.target.assetId,actor);if(input.target.expectedChecksum&&input.target.expectedChecksum!==a.checksum)fail("OBJECT_VERSION_CONFLICT","Asset version changed.",409);
      if(!["original","compiledPdf","previewImage"].includes(input.variant))fail("VARIANT_UNAVAILABLE","Asset variant unsupported.");
      if(input.variant!=="original"&&["queued","running"].includes(a.processing)) return {status:"pending",operationId:id,taskId:a.id};
      const info=await this.content(a.id,input.variant,actor),job={id,type:"download",status:"ready",fingerprint,assetId:a.id,variant:input.variant,checksum:info.checksum,sizeBytes:info.sizeBytes}; this.store.put("jobs",id,job);return this.exportResult(job,actor);
    }
    const view=this.commands.snapshot(input.target.candidateId,actor), block=view.blocks.find(b=>b.id===input.target.blockId&&sameObject(b.owner,input.target.owner)&&b.lifecycle!=="archived");
    if(!block)fail("CONTENT_BLOCK_NOT_FOUND","Block unavailable.",404);if(block.revision!==input.target.expectedRevision)fail("OBJECT_VERSION_CONFLICT","Block changed.",409);
    if(!["xlsx","tex"].includes(input.variant))fail("VARIANT_UNAVAILABLE","Block export format unsupported.");
    const job={id,type:"export",status:"queued",fingerprint,target:input.target,variant:input.variant,block,owner:principal(actor),actor};this.store.put("jobs",id,job);this.enqueue(job);return {status:"pending",operationId:id,taskId:id};
  }
  exportResult(job,actor) {
    if(job.status!=="ready")return{status:"pending",operationId:job.id,taskId:job.id};
    this.assert(job.assetId,actor);return{status:"ready",operationId:job.id,assetId:job.assetId,checksum:job.checksum,sizeBytes:job.sizeBytes,contentPath:"/api/research/assets/"+encodeURIComponent(job.assetId)+"/content?variant="+(job.variant??"original")};
  }
  async processExport(job) {
    try {
      const b=job.block;let table=b.payload;
      if(!table?.columns) {const rep=b.representations?.find(r=>r.id===(job.target.representationId??b.primaryRepresentationId))??b.representations?.find(r=>r.kind==="asset");if(!rep?.assetId)fail("COMPLETE_EXPORT_UNAVAILABLE","No structured table representation.");table=(await this.preview(rep.assetId,job.actor)).preview;}
      if(!table||table.truncated)fail("COMPLETE_EXPORT_UNAVAILABLE","Complete table data is unavailable; download the original.");
      const bytes=job.variant==="xlsx"?Buffer.from(exportXlsxTable(table,b.title)):Buffer.from(exportTexTable(table));const id="asset:"+randomUUID(), storageKey="objects/"+id.slice(6)+"/original";await mkdir(path.dirname(path.join(this.root,storageKey)),{recursive:true});await writeFile(path.join(this.root,storageKey),bytes);
      const asset={id,projectId:this.commands.projectId,storageKey,originalName:b.title+"."+job.variant,mediaType:job.variant==="xlsx"?"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"application/x-tex",sizeBytes:bytes.length,checksum:hash(bytes),owner:job.owner,bindingState:"staged",processing:"notSupported",createdAt:new Date().toISOString(),role:"export"};this.store.put("assets",id,asset);this.store.put("jobs",job.id,{...job,actor:undefined,block:undefined,status:"ready",assetId:id,variant:"original",checksum:asset.checksum,sizeBytes:asset.sizeBytes});
    }catch(e){this.store.put("jobs",job.id,{...job,actor:undefined,block:undefined,status:"failed",error:String(e.message).slice(0,240)});}
  }
  async collect() {
    const pinned=new Set(this.store.all("candidates").flatMap(c=>c.assetIds??[]));
    for(const a of this.store.all("assets")) if(a.bindingState==="staged"&&!pinned.has(a.id)&&Date.now()-Date.parse(a.createdAt)>86400000) {await rm(path.dirname(this.file(a)),{recursive:true,force:true});this.store.remove("assets",a.id);}
  }
  async close() { this.closed=true;this.drain();await Promise.allSettled([...this.pending]); }
}
