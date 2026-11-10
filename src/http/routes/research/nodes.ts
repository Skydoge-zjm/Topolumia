import * as z from "zod/v4";
import { sourceRef } from "../../../domain/research/content-blocks.js";
import type { RouteContext } from "../../route-context.js";
import { readJsonObject, sendJson, parseInput } from "../../../lib/http.js";
import { requirePermission } from "../../../domain/research/access.js";
import { pendingNodeCandidates } from "../../../services/research/changes/candidate-summary.js";
export async function handleResearchNodeRoutes({request,response,pathname,requestRuntime:runtime,requestActor:actor}: RouteContext){
  const match=pathname.match(/^\/api\/research-nodes(?:\/([^/]+))?(?:\/(core))?$/);if(!match)return false;
  requirePermission(actor,request.method==="GET"?"research.view":"research.applyChange");
  const id=match[1]&&decodeURIComponent(match[1]),segment=match[2],service=runtime.researchNodes;
  if(request.method==="GET"&&id){
    sendJson(response,200,{...service.detail(id),groupCount:runtime.researchCommands.groups.list().filter(group=>group.members.some(member=>member.nodeId===id)).length,pendingCandidates:pendingNodeCandidates(runtime.researchCommands,id,actor)});
    return true;
  }
  const body=await readJsonObject(request,262144);
  if(request.method==="DELETE"&&id&&!segment){sendJson(response,200,service.deleteNode(id,body,actor));return true;}
  if(request.method==="POST"&&!id){sendJson(response,201,(()=>{const input=parseInput(z.object({kind:z.enum(["paper","experiment","note"]),core:z.unknown(),sourceRefs:z.array(sourceRef).optional(),body:z.string().optional()}),body);return service.createNode(input.kind,input.core,actor,input.sourceRefs,input.body);})());return true;}
  if(request.method==="PATCH"&&id&&segment==="core"){sendJson(response,200,service.updateCore(id,body.patch,actor,parseInput(z.number().int().positive(),body.expectedCoreRevision)));return true;}
  return false;
}
