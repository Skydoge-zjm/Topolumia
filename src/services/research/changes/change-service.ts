import { randomUUID } from "node:crypto";
import { simulateChange } from "./simulate-change.js";
import { sameObject, objectKey } from "../../../domain/research/object-ref.js";
import { versionHash } from "../../../lib/hash.js";
import { createSchema, editSchema, operationsSchema } from "../../../domain/research/changes/operations.js";
import { fail, principal, actorIdentity } from "../../../domain/research/access.js";
import type * as z from "zod/v4";
import type { ResearchCommandService } from "../research-command-service.js";
import type { ChangeSimulation, ResearchActor, StoredCandidate } from "../../../domain/research/types.js";
const clone=structuredClone;
export class ResearchChangeService {
  store;
  constructor(public c:ResearchCommandService){this.store=c.store;}
  validate<S extends z.ZodType>(schema:S,input:unknown):z.output<S>{const p=schema.safeParse(input);if(!p.success)fail("INPUT_INVALID","Invalid change input.",422,p.error.issues.slice(0,6).map(x=>({path:x.path.join("."),message:x.message})));return p.data;}
  candidate(id:string,actor:ResearchActor):StoredCandidate{const p=this.store.get("candidates",id);if(!p||!this.c.visibleCandidate(p,actor))fail("CANDIDATE_NOT_FOUND","Candidate unavailable.",404);return p;}
  simulate(operations:unknown, actor:ResearchActor, allocation:Record<string,string> = {}, candidateId = "direct", evidenceIds:string[]|undefined = undefined, checkEvidence = false):ChangeSimulation {
    const parsed = this.validate(operationsSchema, operations);
    return simulateChange(this.c, parsed, actor, allocation, candidateId, evidenceIds, checkEvidence);
  }
  createCompiled(input:unknown,actor:ResearchActor):StoredCandidate{
    this.c.check(actor,"research.proposeChange");
    const value=this.validate(createSchema,input),fingerprint=versionHash(value);const previous=this.store.all("candidates").find(p=>p.provenance.principalId===principal(actor)&&p.requestKey===value.idempotencyKey);
    if(previous){if(previous.fingerprint!==fingerprint)fail("IDEMPOTENCY_CONFLICT","Proposal key reused with different input.",409);return {...previous,idempotent:true};}
    const id="patch:"+randomUUID(),simulation=this.simulate(value.operations,actor,{},id,value.evidenceReadIds,true);
    const p:StoredCandidate={id,revision:1,status:"pending",...value,fingerprint,requestKey:value.idempotencyKey,allocation:simulation.allocation,assetIds:simulation.assetIds,provenance:actorIdentity(actor),actor:{isAgent:Boolean(actor.isAgent),user:{id:actor.user.id,displayName:actor.user.displayName},principalId:principal(actor),sessionId:actor.sessionId??null,projectId:this.c.projectId,permissions:["research.view"]},createdAt:new Date().toISOString(),reviews:[],revisions:[],evidenceReads:this.store.all("receipts").filter(r=>(value.evidenceReadIds??[]).includes(r.id))};
    this.c.mutate(()=>{this.store.put("candidates",id,p);this.c.assets.pin(p.assetIds,"pinned");},actor,"propose research change");this.c.notifyCandidate(p);return p;
  }
  editCompiled(input:unknown,actor:ResearchActor,proposalEditFingerprint:string):StoredCandidate{
    this.c.check(actor,"research.proposeChange");const value=this.validate(editSchema,input),p=this.candidate(value.candidateId,actor);if(p.provenance.principalId!==principal(actor))fail("FORBIDDEN","Cannot edit another participant's candidate.",403);if(!["pending","deferred"].includes(p.status))fail("CANDIDATE_TERMINAL","Candidate is terminal.",409);
    const fingerprint=versionHash(value);if(p.revision!==value.expectedRevision){if(p.lastEditFingerprint===fingerprint)return {...p,idempotent:true};fail("CANDIDATE_REVISION_CONFLICT","Reload the candidate.",409);}
    const view=this.simulate(value.operations,actor,clone(p.allocation),p.id,value.evidenceReadIds,true),next:StoredCandidate={...p,operations:value.operations,reason:value.reason,evidenceReadIds:value.evidenceReadIds,allocation:view.allocation,assetIds:view.assetIds,revision:p.revision+1,status:"pending",lastEditFingerprint:fingerprint,proposalEditFingerprint,revisions:[...p.revisions,{revision:p.revision,operations:p.operations,evidenceReads:p.evidenceReads}],evidenceReads:this.store.all("receipts").filter(r=>(value.evidenceReadIds??[]).includes(r.id))};
    this.c.mutate(()=>{this.store.put("candidates",p.id,next);this.c.assets.pin(next.assetIds,"pinned");},actor,"revise research change");this.c.notifyCandidate(next);return next;
  }
  review(input:{patchId?:string;candidateId?:string;expectedRevision?:number;decision?:string;reason?:string},actor:ResearchActor):StoredCandidate{
    const {patchId,candidateId,expectedRevision,decision,reason=""}=input;if(decision!=="accept"&&decision!=="reject"&&decision!=="defer")fail("INPUT_INVALID","Invalid review decision.");this.c.check(actor,reviewPermission(decision));if(actor.isAgent)fail("REVIEW_REQUIRES_USER","Only a human can review.",403);
    const p=this.candidate(candidateId??patchId??fail("INPUT_INVALID","Candidate ID is required."),actor);if(p.revision!==expectedRevision)fail("CANDIDATE_REVISION_CONFLICT","Candidate changed.",409);if(["applied","rejected"].includes(p.status)){if((p.status==="applied")!==(decision==="accept"))fail("CANDIDATE_TERMINAL","Already reviewed.",409);return {...p,idempotent:true};}
    if(decision==="accept"&&p.operations.some(o=>["deleteNode","deleteGroup"].includes(o.op)))this.c.check(actor,"research.withdrawOrSupersede");
    let topology=this.c.state.topology;
    const next:StoredCandidate={...p,status:({accept:"applied",reject:"rejected",defer:"deferred"} as const)[decision],reviews:[...p.reviews,{id:randomUUID(),decision,reason,reviewer:actorIdentity(actor),at:new Date().toISOString()}]};
    this.c.mutate(()=>{if(decision==="accept"){const view=this.simulate(p.operations,p.actor,clone(p.allocation),p.id,p.evidenceReadIds,false);next.finalSnapshot={nodes:view.nodes,groups:view.groups,blocks:view.blocks,topology:view.topology,touched:view.touched};this.persist(view,p.actor);topology=view.topology;this.c.assets.pin(p.assetIds,"attached");}this.store.put("candidates",p.id,next);return topology;},actor,reason||"review research change");this.c.notifyCandidate(next);return next;
  }
  persist(view:ChangeSimulation, actor:ResearchActor) {
    for (const owner of view.touched) this.c.objects.persist(owner, view.allObjects.get(objectKey(owner))!, view.blocks.filter(block => sameObject(block.owner, owner)), actor);
  }
  direct(input:unknown,actor:ResearchActor,reason="edit research object"){
    if(actor?.isAgent)fail("REVIEW_REQUIRES_USER","Agent changes require review.",403);
    this.c.check(actor,"research.applyChange");
    const operations=this.validate(operationsSchema,input);
    if (operations.some(op => ["deleteNode", "deleteGroup"].includes(op.op))) this.c.check(actor,"research.withdrawOrSupersede");
    const view=this.simulate(operations,actor);this.c.mutate(()=>{this.persist(view,actor);this.c.assets.pin(view.assetIds,"attached");return view.topology;},actor,reason);return view;
  }
}
import { reviewPermission } from "../../../domain/research/review-policy.js";
