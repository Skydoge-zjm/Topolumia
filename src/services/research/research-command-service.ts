import path from "node:path";
import { appPaths } from "../../lib/app-paths.js";
import { ResearchRepository } from "./objects/repository.js";
import { NodeObjectService } from "./objects/node-service.js";
import { ResearchObjectService } from "./objects/object-service.js";
import { GroupObjectService } from "./objects/group-service.js";
import { objectKey } from "../../domain/research/object-ref.js";
import { ResearchChangeService } from "./changes/change-service.js";
import { ResearchProposalService } from "./changes/proposal-service.js";
import { summarizeCandidate } from "./changes/candidate-summary.js";
import { AgentResearchQueries } from "./queries/context.js";
import { ResearchAssetService } from "./assets/asset-service.js";
import { RecordIngestionService } from "./experiments/record-ingestion.js";
import { ProjectRecordCatalog } from "./experiments/project-records.js";
import { ExperimentRecordService } from "./experiments/record-service.js";
import { requirePermission, hasPermission, principal, fail } from "../../domain/research/access.js";
import { ResearchState } from "./research-state.js";
import { TopologyService } from "../topology/topology-service.js";
import type { DatabaseSync } from "node:sqlite";
import type { AuthenticatedResearchActor, ResearchActor, ResearchSource, ResearchTopology, ResearchView, StoredCandidate } from "../../domain/research/types.js";
import type { ResearchObjectRef } from "../../domain/research/object-ref.js";
import type { QueryInput } from "./queries/context.js";
type ResearchCommandOptions = {
  state?: ResearchState; topologyService?: TopologyService; topologyCurator?: unknown;
  projectId?: string; projectName?: string; db?: DatabaseSync; assetRoot?: string;
  sourceReader?: ((source: ResearchSource) => Promise<{ text: string | null; complete: boolean }>) | null;
  sourceText?: ((source: ResearchSource) => string | null) | null;
  sourceAllowed?: ((source: ResearchSource) => boolean) | null;
  recordOptions?: ConstructorParameters<typeof ExperimentRecordService>[1];
};
export { requirePermission, hasPermission };
export class ResearchCommandService {
  state: ResearchState;
  topologyService: TopologyService;
  projectId: string;
  projectName: string;
  sourceReader: ResearchCommandOptions["sourceReader"];
  sourceText: ResearchCommandOptions["sourceText"];
  sourceAllowed: ResearchCommandOptions["sourceAllowed"];
  store: ResearchRepository;
  nodes: NodeObjectService;
  groups: GroupObjectService;
  objects: ResearchObjectService;
  changes: ResearchChangeService;
  proposals: ResearchProposalService;
  queries: AgentResearchQueries;
  assets: ResearchAssetService;
  records: ExperimentRecordService;
  ingestion: RecordIngestionService;
  projectRecords: ProjectRecordCatalog;
  onCandidateChange?: (candidate: StoredCandidate) => void;
  constructor({state,topologyService=new TopologyService({demo:false}),projectId="research",projectName="Research",sourceReader=null,sourceText=null,sourceAllowed=null,db,assetRoot,recordOptions={}}: ResearchCommandOptions={}) {
    this.topologyService=topologyService;this.state=state??new ResearchState(topologyService.build());this.projectId=projectId;this.projectName=projectName;this.sourceReader=sourceReader;this.sourceText=sourceText;this.sourceAllowed=sourceAllowed;
    this.store=new ResearchRepository(db,projectId);this.nodes=new NodeObjectService(this);this.groups=new GroupObjectService(this);this.objects=new ResearchObjectService(this);this.changes=new ResearchChangeService(this);this.proposals=new ResearchProposalService(this);this.queries=new AgentResearchQueries(this);
    this.assets=new ResearchAssetService(this,assetRoot??path.join(appPaths().dataRoot,"projects",projectId,"research-assets"));
    this.records=new ExperimentRecordService(this,recordOptions);
    this.ingestion=new RecordIngestionService(this);
    this.projectRecords=new ProjectRecordCatalog(this);
  }
  formalTopology(): ResearchTopology {const graph=this.topologyService.clearCandidate(this.state.topology??this.topologyService.build(this.state.snapshot));return this.topologyService.withObjects(graph,graph.nodes,graph.edges,this.groups.list().map(group=>this.groups.project(group)));}
  check(actor: ResearchActor | null | undefined,permission: string): asserts actor is AuthenticatedResearchActor {requirePermission(actor,permission);if(!actor.user?.id||!Array.isArray(actor.permissions))fail("AUTH_REQUIRED","An authenticated research actor is required.",401);if(actor.projectId&&actor.projectId!==this.projectId)fail("PROJECT_SCOPE_MISMATCH","Project scope mismatch.",403);}
  data(){
    const stored = this.store.all("candidates").map(p=>({...p,operations:this.auditCandidate(p).operations}));
    const reads = this.store.all("receipts").map(r=>({...r,actor:{sessionId:r.researchSessionId},type:r.object.kind==="source"?"source_excerpt":"node",refs:[r.object.id],sourceVersion:r.version,range:r.delivered?.textRanges?.[0]}));
    return {candidates:stored, reads};
  }
  sources(): (ResearchSource & {ref:string})[]{return this.topologyService.sourceIndex(this.state.snapshot).filter((s):s is ResearchSource & {ref:string}=>typeof s.ref==="string" && (!this.sourceAllowed || this.sourceAllowed(s)));}
  allowedSourceRefs(){return new Set(this.sources().map(s=>s.ref));}
  visibleCandidate(p: StoredCandidate,actor: ResearchActor){return !actor.isAgent||p.provenance.principalId===principal(actor)||p.status==="applied";}
  auditCandidate(p: StoredCandidate) {
    const resolve = (owner: ResearchObjectRef | undefined) => owner ? { kind: owner.kind, id: owner.id?.startsWith("@") ? p.allocation[owner.kind + ":" + owner.id.slice(1)] : owner.id } : undefined;
    return { id:p.id,revision:p.revision,status:p.status,reason:p.reason,provenance:p.provenance,reviews:p.reviews,summary:summarizeCandidate(this,p),sourceRefs:[],evidenceNodeIds:[],operations:p.operations.map(op => {
      if(op.op === "addNode")return {op:op.op,node:{id:p.allocation["node:"+op.clientRef],kind:op.kind,label:typeof op.core.nodeName === "string" ? op.core.nodeName : "",summary:""}};
      if(op.op === "addGroup")return {op:op.op,group:{id:p.allocation["group:"+op.clientRef],core:op.core,members:op.members,parentId:op.parentId}};
      if(op.op === "addEdge")return {op:op.op,edge:{id:p.allocation["edge:"+op.clientRef],...op.edge,from:resolve(op.edge.from),to:resolve(op.edge.to)}};
      return {op:op.op,owner:resolve(op.owner) ?? resolve(op.groupId?{kind:"group",id:op.groupId}:op.nodeId?{kind:"node",id:op.nodeId}:undefined),nodeId:op.nodeId,groupId:op.groupId,patch:{summary:op.title??op.op}};
    })};
  }
  mutate(fn:()=>ResearchTopology | null | void,actor: ResearchActor,reason:string){const before={research:this.state.research,topology:this.state.topology};try{return this.store.transaction(()=>{const topology=fn()??this.state.topology;const research={candidates:this.store.all("candidates").map(p=>this.auditCandidate(p)),reads:[],history:[]};this.state.commitResearch(research,topology,{actor,reason});});}catch(e){Object.assign(this.state,before);throw e;}}
  snapshot(candidateId: string | null | undefined,actor: ResearchActor,{owners=undefined,includeBlocks=true}: {owners?: ResearchObjectRef[];includeBlocks?:boolean}={}): ResearchView {if(candidateId){const p=this.changes.candidate(candidateId,actor);if(["applied","rejected"].includes(p.status)) {if(p.finalSnapshot)return p.finalSnapshot;if(p.status==="rejected")fail("CANDIDATE_TERMINAL","Rejected candidate has no live preview.",409);}return this.changes.simulate(p.operations,p.actor,structuredClone(p.allocation),p.id,p.evidenceReadIds,false);}return {nodes:this.nodes.nodes(),groups:this.groups.list(),blocks:!includeBlocks?[]:owners?[...new Map(owners.map(owner=>[objectKey(owner),owner])).values()].flatMap(owner=>this.store.blocksForOwner(owner)):this.store.all("blocks"),topology:this.formalTopology()};}
  context({actor,view,...input}: QueryInput){this.check(actor,"research.view");if(actor.isAgent||view==="compact")return this.queries.brief({actor,...input});return {schemaVersion:"research-command-context.v2",project:{id:this.projectId,name:this.projectName},stateVersion:this.formalTopology().stateVersion,topology:this.formalTopology(),candidates:this.store.all("candidates").filter(p=>this.visibleCandidate(p,actor)).map(p=>({...this.auditCandidate(p),operationCount:p.operations.length})),sources:this.sources()};}
  search(input: QueryInput){return this.queries.search(input);}
  readNode(input: QueryInput){return this.queries.readNodes({...input,nodeIds:input.nodeIds??[input.nodeId!]});}
  readSource(input: QueryInput){return this.queries.readSource(input);}
  neighbors(input: QueryInput){return this.queries.neighbors(input);}
  candidates(input: QueryInput){return this.queries.candidates({...input,candidateId:input.candidateId??input.patchId,mode:input.mode??(input.patchId?"show":"list")});}
  createCandidate({actor,...input}: QueryInput){return this.proposals.create(input,actor);}
  editCandidate({actor,patchId,...input}: QueryInput){return this.proposals.edit({...input,candidateId:input.candidateId??patchId},actor);}
  reviewCandidate({actor,...input}: QueryInput){return this.changes.review(input,actor);}
  notifyCandidate(candidate: StoredCandidate) { this.onCandidateChange?.(candidate); }
}
