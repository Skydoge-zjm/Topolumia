import { readJson, sendJson } from "../../../lib/http.js";
import { requirePermission } from "../../../domain/research/access.js";
import { pendingNodeCandidates } from "../../../services/research/changes/candidate-summary.js";
export async function handleResearchNodeRoutes({request,response,pathname,requestRuntime:runtime,requestActor:actor}){
  const match=pathname.match(/^\/api\/research-nodes(?:\/([^/]+))?(?:\/(core|results))?$/);if(!match)return false;
  requirePermission(actor,request.method==="GET"?"research.view":"research.applyChange");
  const id=match[1]&&decodeURIComponent(match[1]),segment=match[2],service=runtime.researchNodes;
  if(request.method==="GET"&&id){
    if(segment==="results"){requirePermission(actor,"experiment.view");sendJson(response,200,await service.results(id));}
    else sendJson(response,200,{...service.detail(id),groupCount:runtime.researchCommands.groups.list().filter(group=>group.members.some(member=>member.nodeId===id)).length,pendingCandidates:pendingNodeCandidates(runtime.researchCommands,id,actor)});
    return true;
  }
  const body=await readJson(request,262144);
  if(request.method==="DELETE"&&id&&!segment){sendJson(response,200,service.deleteNode(id,body,actor));return true;}
  if(request.method==="POST"&&!id){sendJson(response,201,service.createNode(body.kind,body.core,actor,body.sourceRefs));return true;}
  if(request.method==="PATCH"&&id&&segment==="core"){sendJson(response,200,service.updateCore(id,body.patch,actor,body.expectedCoreRevision));return true;}
  return false;
}
