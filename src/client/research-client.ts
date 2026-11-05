import { toolRequest } from "../domain/research/interfaces/routes.js";
import { randomUUID } from "node:crypto";
export class ResearchClient {
  constructor({baseUrl,projectId=null,session=null,timeoutMs=15000}={}){this.baseUrl=String(baseUrl??"http://127.0.0.1:5510").replace(/\/$/,"");this.projectId=projectId;this.session=session;this.timeoutMs=timeoutMs;}
  headers(extra={}){return {...(this.projectId?{"x-rw-project-id":this.projectId}:{}),...(this.session?{"x-rw-session":this.session}:{}),"x-topolumia-client":"cli",...(process.env.TOPOLUMIA_REQUEST_ID?{"x-topolumia-request-id":process.env.TOPOLUMIA_REQUEST_ID}:{}),...extra};}
  async response(route,options={}){const target=new URL(route,this.baseUrl);if(target.origin!==new URL(this.baseUrl).origin||!target.pathname.startsWith("/api/research/"))throw Object.assign(new Error("Research URL is outside the trusted origin."),{code:"URL_FORBIDDEN"});const r=await fetch(target,{...options,redirect:"error",headers:this.headers(options.headers),signal:AbortSignal.timeout(this.timeoutMs)});if(!r.ok){const body=await r.json().catch(()=>({}));throw Object.assign(new Error(body.error?.message??`Request failed (${r.status})`),{code:body.error?.code??"REQUEST_FAILED",status:r.status,detail:body.error?.detail});}return r;}
  async request(route,options={}){return(await this.response(route,{...options,headers:{...(options.body?{"content-type":"application/json"}:{}),...(options.headers??{})}})).json();}
  async call(name,input){
    const value=name==="create_candidate"?{...input,idempotencyKey:input.idempotencyKey??randomUUID()}:input;
    const r=toolRequest(name,value);
    try{return await this.request(r.path,{method:r.method,...(r.body?{body:r.body}:{})});}
    catch(error){if(name==="create_candidate")error.detail={cause:error.detail,idempotencyKey:value.idempotencyKey,recovery:"Read candidates with this idempotencyKey or retry identical input and key."};throw error;}
  }
  context(input={}){return this.call("get_context",input);}
  environment(input={}){return this.call("get_environment",input);}
  search(input={}){return this.call("search",input);}
  readNode(input={}){const{nodeId,...rest}=input;return this.call("read_nodes",{...rest,nodeIds:input.nodeIds??[nodeId]});}
  readSource(input={}){return this.call("read_source",input);}
  candidates(input={}){const{patchId,...rest}=input;return this.call("read_candidates",{...rest,mode:patchId?"show":"list",...(patchId?{candidateId:patchId}:{})});}
  neighbors(input={}){return this.call("neighbors",input);}
  createCandidate(input={}){return this.call("create_candidate",input);}
  editCandidate(input={}){const{patchId,...rest}=input;return this.call("edit_candidate",{...rest,candidateId:input.candidateId??patchId});}
  reviewCandidate(input={}){return this.request(`/api/research/candidates/${encodeURIComponent(input.patchId??input.candidateId)}/review`,{method:"POST",body:JSON.stringify({decision:input.decision,reason:input.reason,expectedRevision:input.expectedRevision})});}
}
