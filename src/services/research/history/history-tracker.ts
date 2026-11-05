import { graphChanges, historyActor, plannedChanges, subject } from "./changes.js";

function proposals(state) {
  return new Map((state.research?.candidates ?? []).map(patch => [patch.id, patch]));
}
export class ResearchHistoryTracker {
  constructor(store) { this.store = store; this.onDeleted = null; this.resolveAgent = null; }
  actor(value) {
    const identity = historyActor(value);
    return identity.type === "agent" ? { ...identity, ...this.resolveAgent?.(identity.sessionId) } : identity;
  }
  capture(method, before, state, args, requestActor) {
    const meta = args[2];
    const actor = meta?.actorDetails ?? meta?.actor ?? requestActor;
    const actualActor = actor && typeof actor === "object" ? actor : requestActor;
    const changes = method === "commitResearch" ? graphChanges(before.topology, state.topology).map(change => change.subject.type === "group" ? { ...change, before: change.before ? this.resolveResearchObject?.("group", change.subject.id, change.before.revision) ?? change.before : null, after: change.after ? this.resolveResearchObject?.("group", change.subject.id, change.after.revision) ?? change.after : null } : change) : [];
    const previous = proposals(before), current = proposals(state);
    let handledChanges = false, effectEvent = null;
    for (const [id, patch] of current) {
      const old = previous.get(id);
      const review = patch.reviews?.at(-1);
      let action;
      if (!old) action = "proposed";
      else if (old.status !== patch.status && ["applied", "rejected", "deferred"].includes(patch.status)) action = { applied: "accepted", rejected: "rejected", deferred: "deferred" }[patch.status];
      else if ((old.revision ?? 1) !== (patch.revision ?? 1)) action = "revised";
      else if (review?.id && review.id !== old.reviews?.at(-1)?.id) action = { accept: "accepted", reject: "rejected", defer: "deferred" }[review.decision];
      if (!action) continue;
      const initiator = patch.provenance ? this.actor(patch.provenance) : { type: "agent", id: "topology-curator", name: "Topology curator", model: patch.curator?.model };
      const isReview = ["accepted", "rejected", "deferred"].includes(action);
      const performer = isReview ? review?.reviewer ? this.actor(review.reviewer) : this.actor(actualActor) : initiator;
      const accepted = action === "accepted";
      const eventId = this.store.append({ kind: `proposal.${action}`, outcome: { accepted: "applied", rejected: "rejected", deferred: "deferred" }[action] ?? "pending",
        actor: performer, initiatedBy: initiator, ...(isReview ? { reviewedBy: performer } : {}),
        proposal: { id, revision: patch.revision ?? 1, status: patch.status }, reason: review?.reason ?? patch.rejectionReason ?? patch.reason ?? "",
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
  documentChanged({ kind, before, after, actor, context = {} }) {
    let action = !after ? "deleted" : !before ? "created" : "updated";
    if (kind === "record" && after) {
      if (after.status === "confirmed" && before?.status !== "confirmed") action = "confirmed";
      else if (after.status === "cancelled" && before?.status !== "cancelled") action = "cancelled";
      else if (!before && after.status === "planned") action = "scheduled";
    }
    const object = after ?? before;
    this.store.append({ kind: `${kind}.${action}`, outcome: "applied", actor: this.actor(actor),
      reason: context.reason ?? "", causedBy: context.causedBy ?? null,
      changes: [{ action: `${kind}.${!after ? "deleted" : !before ? "created" : "updated"}`, subject: subject(kind, object), before, after }], planned: false,
    }, `document:${kind}:${object.id}:${object.revision}:${action}`);
  }
}
