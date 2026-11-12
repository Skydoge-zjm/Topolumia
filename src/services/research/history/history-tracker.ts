import { graphChanges, historyActor, plannedChanges, subject } from "./changes.js";

import type { ResearchHistoryStore } from "./history-store.js";
import type { HistoryActorInput, HistoryActor, HistoryObject, HistoryChange } from "./history-types.js";
import type { ResearchStateView } from "../research-state.js";
import type { NotebookChange } from "../notebook-store.js";
type ChangeMeta={actorDetails?:HistoryActorInput;actor?:HistoryActorInput|string;reason?:string};
function proposals(state:Pick<ResearchStateView,"research">) {
  return new Map((state.research?.candidates ?? []).map(patch => [patch.id, patch]));
}
export class ResearchHistoryTracker {
  onDeleted:((ids:string[],actor:HistoryActorInput|null|undefined,eventId:string|null)=>void)|null=null;
  resolveAgent:((sessionId?:string)=>Partial<HistoryActor>|null)|null=null;
  resolveResearchObject:((type:string,id:string,revision?:number)=>Partial<HistoryObject>|null)|null=null;
  constructor(public store:ResearchHistoryStore) {}
  actor(value:HistoryActorInput|null|undefined) {
    const identity = historyActor(value);
    return identity.type === "agent" ? { ...identity, ...this.resolveAgent?.(identity.sessionId) } : identity;
  }
  capture(method:string, before:ResearchStateView, state:ResearchStateView, args:unknown[], requestActor?:HistoryActorInput|null) {
    const meta = args[2] as ChangeMeta|undefined;
    const actor = meta?.actorDetails ?? meta?.actor ?? requestActor;
    const actualActor = actor && typeof actor === "object" ? actor : requestActor;
    const snapshot = (type:string, object:HistoryObject|null) => object ? { ...object, ...this.resolveResearchObject?.(type, object.id, object.revision ?? (typeof object.data?.researchRevision === "number" ? object.data.researchRevision : undefined)) } : null;
    const changes:HistoryChange[] = method === "commitResearch" ? graphChanges(before.topology, state.topology).map(change => ["group", "node"].includes(change.subject.type) ? { ...change, before: snapshot(change.subject.type, change.before), after: snapshot(change.subject.type, change.after) } : change) : [];
    const previous = proposals(before), current = proposals(state);
    let handledChanges = false, effectEvent:string|null = null;
    for (const [id, patch] of current) {
      const old = previous.get(id);
      const review = patch.reviews?.at(-1);
      let action:string|undefined;
      if (!old) action = "proposed";
      else if (old.status !== patch.status && ["applied", "rejected", "deferred"].includes(patch.status)) action = ({ applied: "accepted", rejected: "rejected", deferred: "deferred" } as Record<string,string>)[patch.status];
      else if ((old.revision ?? 1) !== (patch.revision ?? 1)) action = "revised";
      else if (review?.id && review.id !== old.reviews?.at(-1)?.id) action = ({ accept: "accepted", reject: "rejected", defer: "deferred" } as Record<string,string>)[review.decision];
      if (!action) continue;
      const initiator = this.actor(patch.provenance);
      const isReview = ["accepted", "rejected", "deferred"].includes(action);
      const performer = isReview ? review?.reviewer ? this.actor(review.reviewer) : this.actor(actualActor) : initiator;
      const accepted = action === "accepted";
      const eventId = this.store.append({ kind: `proposal.${action}`, outcome: ({ accepted: "applied", rejected: "rejected", deferred: "deferred" } as Record<string,string>)[action] ?? "pending",
        actor: performer, initiatedBy: initiator, ...(isReview ? { reviewedBy: performer } : {}),
        proposal: { id, revision: patch.revision ?? 1, status: patch.status }, reason: review?.reason ?? patch.reason ?? "",
        proposalReason: patch.reason ?? "", sourceRefs: patch.sourceRefs ?? [], evidenceNodeIds: patch.evidenceNodeIds ?? [],
        changes: accepted ? changes : plannedChanges(patch, before.topology), planned: !accepted,
        beforeStateVersion: before.topology?.stateVersion, afterStateVersion: state.topology?.stateVersion,
      }, `proposal:${id}:${patch.revision ?? 1}:${action}:${isReview ? review?.id ?? patch.status : ""}`);
      if (accepted) { handledChanges = true; effectEvent = eventId; }
    }
    if (changes.length && !handledChanges) {
      effectEvent = this.store.append({ kind: changes.length === 1 ? changes[0].action : changes.every(change => change.action === "node.created") ? "node.created" : changes.some(change => change.action === "node.deleted") ? "node.deleted" : changes.some(change => change.action === "group.deleted") ? "group.deleted" : changes.every(change => change.subject.type === "group") ? (changes.every(change => change.action === "group.created") ? "group.created" : "group.updated") : "research.changed",
        outcome: "applied", actor: this.actor(actualActor), changes, reason: meta?.reason ?? "", planned: false,
        beforeStateVersion: before.topology?.stateVersion, afterStateVersion: state.topology?.stateVersion });
    }
    const deleted = changes.filter(change => change.action === "node.deleted").map(change => change.subject.id);
    if (deleted.length) this.onDeleted?.(deleted, actualActor, effectEvent);
  }
  documentChanged({ kind, before, after, actor, context = {} }:NotebookChange) {
    let action = !after ? "deleted" : !before ? "created" : "updated";
    if (kind === "record" && after && "status" in after) {
      if (after.status === "confirmed" && (before && "status" in before ? before.status : undefined) !== "confirmed") action = "confirmed";
      else if (after.status === "cancelled" && (before && "status" in before ? before.status : undefined) !== "cancelled") action = "cancelled";
      else if (!before && after.status === "planned") action = "scheduled";
    }
    const object = after ?? before;if(!object)return;
    this.store.append({ kind: `${kind}.${action}`, outcome: "applied", actor: this.actor(actor),
      reason: context.reason ?? "", causedBy: context.causedBy ?? null,
      changes: [{ action: `${kind}.${!after ? "deleted" : !before ? "created" : "updated"}`, subject: subject(kind, object), before, after }], planned: false,
    }, `document:${kind}:${object.id}:${object.revision}:${action}`);
  }
}
