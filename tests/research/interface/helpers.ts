import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { startMvpServer } from "../../../src/server.js";
import { buildResearchMcpBinding } from "../../../src/agent/research-mcp-binding.js";
import { openResearchMcp } from "../../../src/mcp/research-probe.js";
export async function fixture(t,{mcp=true}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),"topolumia-interface-v2-"));
  const app=await startMvpServer({port:0,testMode:false,collaborationFile:path.join(root,"db.sqlite"),userSettingsFile:path.join(root,"settings.json"),config:{project:{id:"interface-tests",name:"Synthetic interface tests",root:path.join(root,"workspace"),workspacesRoot:path.join(root,"workspaces")},filesystem:{roots:[path.join(root,"workspace")]},sourceRefresh:{enabled:false},curator:{enabled:false}}});
  const user=app.collaboration.bootstrapAdmin({username:"interface-admin",password:"Isolated-Interface-Test-2026!"}),actor=app.collaboration.actorForUser(user.id,app.config.project.id),human=app.collaboration.login("interface-admin","Isolated-Interface-Test-2026!").token;
  const runtimeId=randomUUID(),token=app.collaboration.issueAgentCredential(actor,app.config.project.id,runtimeId,{researchSessionId:"research-test"});
  const binding=buildResearchMcpBinding({baseUrl:app.url,projectId:app.config.project.id,sessionToken:token,cwd:app.config.project.root,runtimeInstanceId:runtimeId,researchSessionId:"research-test",dataRoot:root});
  const connection=mcp?await openResearchMcp(binding):null;
  const api=async(method,route,body,credential=human)=>{const r=await fetch(app.url+route,{method,headers:{"content-type":"application/json","x-rw-project-id":app.config.project.id,"x-rw-session":credential},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json()};};
  const call=async(name,args={})=>connection.client.callTool({name,arguments:args},undefined,{timeout:115000});
  const data=async(name,args={})=>{const r=await call(name,args);assert.ok(!r.isError,JSON.stringify(r));assert.ok(r._meta.execution.pid>0);assert.equal(r.structuredContent.schemaVersion,"research-agent-result.v1");assert.ok(JSON.stringify(r.structuredContent).length<=r.structuredContent.budget.maxChars);assert.equal(JSON.stringify(r.structuredContent).length,r.structuredContent.budget.returnedChars);return r.structuredContent;};
  t.after(async()=>{await connection?.close();await app.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  return{root,app,actor,human,token,binding,connection,api,call,data,runtime:app.runtimes.get(app.config.project.id)};
}
