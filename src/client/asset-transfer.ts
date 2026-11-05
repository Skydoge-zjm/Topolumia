import { lstat, realpath, mkdir, open, rm, rename, link, readFile, mkdtemp } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { versionHash } from "../lib/hash.js";
const error=(code,message,detail=undefined)=>Object.assign(new Error(message),{code,exitCode:6,...(detail?{detail}:{})});
export async function transferPath(root,relativePath,direction){
  if(!root)throw error("TRANSFER_UNAVAILABLE","This session has no shared transfer directory.");
  relativePath=relativePath.replaceAll("\\","/");
  const parts=relativePath.split("/");
  const prefix=direction==="upload"?"out":"in";
  const invalidPart=p=>!p||p==="."||p===".."||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p);
  const invalidCharacters=/[:\u0000-\u001f]/.test(relativePath);
  if(parts[0]!==prefix||parts.length<2||invalidCharacters||parts.some(invalidPart)){
    const wrongRoot=parts.length>3&&parts[0]===".topolumia-transfer"&&parts[1]===path.basename(root)&&parts[2]===prefix&&!invalidCharacters&&!parts.slice(2).some(invalidPart);
    throw error("TRANSFER_PATH_FORBIDDEN",`relativePath is relative to the session transfer directory, not the project directory. Start with ${prefix}/; omit .topolumia-transfer/<session>/.`,{field:"relativePath",expectedPrefix:prefix+"/",...(wrongRoot?{suggestedRelativePath:parts.slice(2).join("/")}:{})});
  }
  const rootInfo=await lstat(root);if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())throw error("TRANSFER_PATH_FORBIDDEN","Invalid transfer root.");const realRoot=await realpath(root);let current=realRoot;
  for(const [index,part]of parts.entries()){current=path.join(current,part);const info=await lstat(current).catch(e=>e.code==="ENOENT"?null:Promise.reject(e));if(info?.isSymbolicLink())throw error("TRANSFER_PATH_FORBIDDEN","Links are not allowed in transfer paths.");if(!info&&direction==="download"&&index<parts.length-1)await mkdir(current);if(info&&index<parts.length-1&&!info.isDirectory())throw error("TRANSFER_PATH_FORBIDDEN","Parent is not a directory.");}
  if(!path.resolve(current).startsWith(realRoot+path.sep))throw error("TRANSFER_PATH_FORBIDDEN","Path escaped transfer root.");return current;
}
async function shaFile(file){const h=createHash("sha256");for await(const chunk of createReadStream(file))h.update(chunk);return "sha256:"+h.digest("hex");}
export async function transferAsset(client,input,root){
  input={...input,relativePath:input.relativePath.replaceAll("\\","/")};
  const destination=await transferPath(root,input.relativePath,input.direction);
  if(input.direction==="upload"){
    const info=await lstat(destination);if(!info.isFile()||info.size<=0||info.size>20*1024*1024)throw error("ASSET_SIZE_INVALID","Upload must be a nonempty regular file up to 20 MiB.");
    const source=await open(destination,constants.O_RDONLY|(constants.O_NOFOLLOW??0)),opened=await source.stat();if(opened.ino!==info.ino||opened.dev!==info.dev){await source.close();throw error("TRANSFER_PATH_FORBIDDEN","File changed before opening.");}
    const temporary=await mkdtemp(path.join(root,".upload-")),snapshot=path.join(temporary,"file");
    try{
      const out=await open(snapshot,"wx");let size=0;try{for await(const chunk of source.createReadStream()){size+=chunk.length;if(size>20*1024*1024)throw error("ASSET_SIZE_INVALID","Upload exceeds 20 MiB.");await out.writeFile(chunk);}}finally{await out.close();await source.close().catch(()=>{});}
      const checksum=await shaFile(snapshot),name=input.originalName??path.basename(destination),mediaType=input.mediaType??mime(name);
      return(await client.response("/api/research/assets",{method:"POST",body:createReadStream(snapshot),duplex:"half",headers:{"content-type":"application/octet-stream","content-length":String(size),"idempotency-key":input.idempotencyKey,"x-content-sha256":checksum,"x-asset-name":encodeURIComponent(name),"x-asset-media-type":mediaType}})).json();
    }finally{await source.close().catch(()=>{});await rm(temporary,{recursive:true,force:true});}
  }
  const result=await client.request("/api/research/exports",{method:"POST",body:JSON.stringify({target:input.target,variant:input.variant,idempotencyKey:input.idempotencyKey,destinationDigest:createHash("sha256").update(input.relativePath).digest("hex")})});
  if(result.data.status!=="ready")return result;
  const data=result.data,existing=await lstat(destination).catch(e=>e.code==="ENOENT"?null:Promise.reject(e));
  const receiptDir=path.join(root,".receipts");await mkdir(receiptDir,{recursive:true});const receiptFile=path.join(receiptDir,versionHash({key:input.idempotencyKey,path:input.relativePath}).replace(":","-")+".json");
  if(existing){const prior=await readFile(receiptFile,"utf8").then(JSON.parse).catch(()=>null);if(!prior||!existing.isFile()||await shaFile(destination)!==data.checksum||prior.operationId!==data.operationId)throw error("DESTINATION_EXISTS","Download target already exists.");return finalize(result,destination,prior);}
  const temp=destination+"."+randomUUID()+".part",out=await open(temp,"wx"),digest=createHash("sha256");let size=0;
  try{const response=await client.response(data.contentPath);for await(const raw of response.body){const chunk=Buffer.from(raw);size+=chunk.length;if(size>64*1024*1024)throw error("ASSET_SIZE_INVALID","Download exceeds 64 MiB.");digest.update(chunk);await out.writeFile(chunk);}await out.close();const checksum="sha256:"+digest.digest("hex");if(checksum!==data.checksum||size!==data.sizeBytes)throw error("CHECKSUM_MISMATCH","Downloaded bytes did not match the expected asset.");await transferPath(root,input.relativePath,"download");if(await lstat(destination).catch(()=>null))throw error("DESTINATION_EXISTS","Target appeared during download.");await link(temp,destination);await rm(temp,{force:true});const receipt={id:"delivery:"+randomUUID(),operationId:data.operationId,assetId:data.assetId,checksum,sizeBytes:size,deliveredAt:new Date().toISOString()};await readFile(receiptFile).then(()=>{throw error("DESTINATION_EXISTS","Receipt already exists.");}).catch(e=>{if(e.code!=="ENOENT")throw e;});const f=await open(receiptFile,"wx");await f.writeFile(JSON.stringify(receipt));await f.close();return finalize(result,destination,receipt);}finally{await out.close().catch(()=>{});await rm(temp,{force:true});}
}
function finalize(result,file,receipt){result.data={status:"ready",operationId:result.data.operationId,assetId:receipt.assetId,checksum:receipt.checksum,sizeBytes:receipt.sizeBytes,path:file};result.deliveryReceipt=receipt;for(let i=0;i<5;i++)result.budget.returnedChars=JSON.stringify(result).length;return result;}
function mime(name){return({xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",tex:"application/x-tex",csv:"text/csv",md:"text/markdown",txt:"text/plain",pdf:"application/pdf",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",json:"application/json"})[name.toLowerCase().split(".").pop()]??"application/octet-stream";}
