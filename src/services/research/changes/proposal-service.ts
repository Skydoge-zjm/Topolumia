import { randomUUID } from "node:crypto";
import { createProposalSchema, reviseProposalSchema } from "../../../domain/research/changes/proposals.js";
import { fail, principal } from "../../../domain/research/access.js";
import { versionHash } from "../../../lib/hash.js";
import { nodeRef, groupRef, sameObject, objectKey } from "../../../domain/research/object-ref.js";
const merge = (old, patch) => { const value = { ...old }; for (const [key, item] of Object.entries(patch)) item === null ? delete value[key] : value[key] = item; return value; };

export class ResearchProposalService {
  constructor(commands) { this.c = commands; }
  create(input, actor) {
    this.c.check(actor, "research.proposeChange");
    const value = this.c.changes.validate(createProposalSchema, input);
    return this.c.changes.createCompiled({ reason: value.reason, idempotencyKey: value.idempotencyKey ?? randomUUID(), operations: this.compile(value, actor), evidenceReadIds: value.evidenceReadIds }, actor);
  }
  edit(input, actor) {
    this.c.check(actor, "research.proposeChange");
    const value = this.c.changes.validate(reviseProposalSchema, input), candidate = this.c.changes.candidate(value.candidateId, actor);
    if (candidate.provenance.principalId !== principal(actor)) fail("FORBIDDEN", "Cannot edit another participant's candidate.", 403);
    const fingerprint = versionHash(value);
    if (!["pending", "deferred"].includes(candidate.status)) fail("CANDIDATE_TERMINAL", "Candidate has already been reviewed.", 409);
    if (candidate.revision !== value.expectedRevision) { if (candidate.proposalEditFingerprint === fingerprint) return { ...candidate, idempotent: true }; fail("CANDIDATE_REVISION_CONFLICT", "Read the latest candidate.", 409, { current: candidate.revision }); }
    const evidenceReadIds = candidate.evidenceReadIds === undefined && value.evidenceReadIds === undefined ? undefined : [...new Set([...(candidate.evidenceReadIds ?? []), ...(value.evidenceReadIds ?? [])])];
    return this.c.changes.editCompiled({ candidateId: candidate.id, expectedRevision: value.expectedRevision, reason: value.reason ?? candidate.reason, operations: this.compile(value, actor, candidate), evidenceReadIds }, actor, fingerprint);
  }
  compile(input, actor, candidate = null) {
    if ((input.nodes?.length ?? 0) + (input.groups?.length ?? 0) > 8) fail("INPUT_INVALID", "Create at most eight research objects per request.");
    let operations = structuredClone(candidate?.operations ?? []);
    const allocation = candidate?.allocation ?? {};
    let counter = 0;
    const key = () => "r" + (candidate?.revision ?? 0) + "-" + counter++;
    const idRef = (id, kind) => { const entry = Object.entries(allocation).find(([name, value]) => name.startsWith(kind + ":") && value === id); return entry ? "@" + entry[0].slice(kind.length + 1) : id; };
    const ownerRef = owner => ({ ...owner, id: idRef(owner.id, owner.kind) });
    const created = owner => operations.find(op => op.op === (owner.kind === "group" ? "addGroup" : "addNode") && allocation[owner.kind + ":" + op.clientRef] === owner.id);
    const addedBlock = id => operations.find(op => op.op === "addBlock" && allocation["block:" + op.clientRef] === id);
    const addBlocks = (owner, values, expectedCollectionRevision) => { for (const block of values ?? []) operations.push({ ...block, op: "addBlock", owner, clientRef: key(), ...(expectedCollectionRevision !== undefined ? { expectedCollectionRevision } : {}) }); };
    for (const node of input.nodes ?? []) { const clientRef = key(); operations.push({ op: "addNode", clientRef, kind: node.kind, core: node.core, sourceRefs: node.sourceRefs }); addBlocks(nodeRef("@" + clientRef), node.blocks, undefined); }
    for (const group of input.groups ?? []) { const clientRef = key(); operations.push({ op: "addGroup", clientRef, core: group.core, members: group.members ?? [], parentId: group.parentId ? idRef(group.parentId, "group") : null, expectedParentRevision: group.expectedParentRevision, sourceRefs: group.sourceRefs }); addBlocks(groupRef("@" + clientRef), group.blocks, undefined); }
    const changes = [...(input.nodeChanges ?? []).map(change => ({ ...change, owner: nodeRef(change.nodeId) })), ...(input.groupChanges ?? []).map(change => ({ ...change, owner: groupRef(change.groupId) }))];
    const changed = new Set();
    for (const change of changes) {
      const owner = change.owner, target = ownerRef(owner), added = created(owner), identity = objectKey(owner);
      if (changed.has(identity)) fail("INPUT_INVALID", "Combine changes for the same object."); changed.add(identity);
      if (!added) this.c.objects.get(owner);
      if (change.corePatch !== undefined || change.sourceRefs !== undefined) {
        if (added) { if (change.corePatch) added.core = merge(added.core, change.corePatch); if (change.sourceRefs) added.sourceRefs = change.sourceRefs; }
        else {
          const previous = operations.find(op => op.op === "updateCore" && sameObject(op.owner, owner));
          if (previous) { previous.patch = { ...previous.patch, ...change.corePatch }; if (change.sourceRefs) previous.sourceRefs = change.sourceRefs; }
          else { this.requireVersion(change.expectedCoreRevision, "expectedCoreRevision", owner.id); operations.push({ op: "updateCore", owner, expectedCoreRevision: change.expectedCoreRevision, patch: change.corePatch ?? {}, sourceRefs: change.sourceRefs }); }
        }
      }
      const updated = new Set();
      for (const update of change.updateBlocks ?? []) {
        if (updated.has(update.blockId)) fail("INPUT_INVALID", "Supply one patch per block."); updated.add(update.blockId);
        const newBlock = addedBlock(update.blockId);
        if (newBlock) {
          if (!sameObject(newBlock.owner, target)) fail("CONTENT_BLOCK_NOT_FOUND", "Block belongs to another object.", 404);
          const next = merge(newBlock, update.patch);
          if (update.patch.payloadFromAsset) delete next.payload; else if (update.patch.payload !== undefined) delete next.payloadFromAsset;
          operations[operations.indexOf(newBlock)] = next;
        } else {
          this.c.objects.block(owner, update.blockId);
          const previous = operations.find(op => op.op === "updateBlock" && op.blockId === update.blockId);
          if (previous) { previous.patch = { ...previous.patch, ...update.patch }; if (update.patch.payloadFromAsset) delete previous.patch.payload; else if (update.patch.payload !== undefined) delete previous.patch.payloadFromAsset; }
          else { this.requireVersion(update.expectedRevision, "expectedRevision", update.blockId); operations.push({ op: "updateBlock", owner, blockId: update.blockId, expectedRevision: update.expectedRevision, patch: update.patch }); }
        }
      }
      for (const archive of change.archiveBlocks ?? []) {
        if (updated.has(archive.blockId)) fail("INPUT_INVALID", "Cannot update and archive a block together.");
        const newBlock = addedBlock(archive.blockId);
        if (newBlock) { if (!sameObject(newBlock.owner, target)) fail("CONTENT_BLOCK_NOT_FOUND", "Block belongs to another object.", 404); operations = operations.filter(op => op !== newBlock); }
        else if (!operations.some(op => op.op === "archiveBlock" && op.blockId === archive.blockId)) { this.c.objects.block(owner, archive.blockId); this.requireVersion(archive.expectedRevision, "expectedRevision", archive.blockId); operations.push({ op: "archiveBlock", owner, blockId: archive.blockId, expectedRevision: archive.expectedRevision }); }
      }
      addBlocks(target, change.addBlocks, added ? undefined : change.expectedCollectionRevision);
      if (change.blockOrder) {
        const previous = operations.find(op => op.op === "reorderBlocks" && sameObject(op.owner, target));
        if (!added && !previous) this.requireVersion(change.expectedCollectionRevision, "expectedCollectionRevision", owner.id);
        operations = operations.filter(op => op !== previous);
        operations.push({ op: "reorderBlocks", owner: target, expectedCollectionRevision: previous?.expectedCollectionRevision ?? change.expectedCollectionRevision ?? 1, blockIds: change.blockOrder.map(id => idRef(id, "block")) });
      }
      if (owner.kind === "group") {
        if (change.membersPatch) {
          const previous = operations.find(op => op.op === "updateMembers" && op.groupId === target.id);
          const expected = change.expectedMembershipRevision ?? previous?.expectedMembershipRevision ?? (added ? 1 : undefined);
          this.requireVersion(expected, "expectedMembershipRevision", owner.id);
          operations.push({ op: "updateMembers", groupId: target.id, expectedMembershipRevision: expected, patch: change.membersPatch });
        }
        if (change.parentId !== undefined) {
          const previous = operations.find(op => op.op === "setGroupParent" && op.groupId === target.id);
          const expected = change.expectedMembershipRevision ?? previous?.expectedMembershipRevision ?? (added ? 1 : undefined);
          this.requireVersion(expected, "expectedMembershipRevision", owner.id);
          operations.push({ op: "setGroupParent", groupId: target.id, parentId: change.parentId ? idRef(change.parentId, "group") : null, expectedMembershipRevision: expected, expectedParentRevisions: change.expectedParentRevisions ?? previous?.expectedParentRevisions ?? {} });
        }
        if (change.primaryRelations) {
          const previous = operations.find(op => op.op === "setGroupPrimaryRelations" && op.groupId === target.id);
          const expected = change.expectedRelationRevision ?? previous?.expectedRelationRevision ?? (added ? 1 : undefined);
          this.requireVersion(expected, "expectedRelationRevision", owner.id);
          operations.push({ op: "setGroupPrimaryRelations", groupId: target.id, expectedRelationRevision: expected, patch: change.primaryRelations });
        }
      }
    }
    for (const relation of input.relations ?? []) operations.push({ op: "addEdge", clientRef: key(), edge: { from: ownerRef(relation.from), to: ownerRef(relation.to), type: relation.type }, label: relation.label, expectedEndpointRevisions: relation.expectedEndpointRevisions });
    for (const change of input.relationChanges ?? []) {
      const added = operations.find(op => op.op === "addEdge" && allocation["edge:" + op.clientRef] === change.relationId);
      if (added) { if (change.remove) { operations = operations.filter(op => op !== added); for (const op of operations) if (op.op === "setGroupPrimaryRelations") for (const field of ["incomingRelationId", "outgoingRelationId"]) if (op.patch[field] === change.relationId) op.patch[field] = null; } else { if (change.patch.type) added.edge.type = change.patch.type; if (change.patch.label !== undefined) added.label = change.patch.label; } }
      else { this.requireVersion(change.expectedRevision, "expectedRevision", change.relationId); operations.push({ op: change.remove ? "deleteEdge" : "updateEdge", edgeId: change.relationId, expectedRevision: change.expectedRevision, expectedEndpointRevisions: change.expectedEndpointRevisions ?? [], ...(change.remove ? {} : { patch: change.patch }) }); }
    }
    for (const target of [...(input.deleteNodes ?? []).map(item => ({ ...item, owner: nodeRef(item.nodeId) })), ...(input.deleteGroups ?? []).map(item => ({ ...item, owner: groupRef(item.groupId) }))]) {
      const added = created(target.owner), reference = ownerRef(target.owner);
      if (added) {
        operations = operations.filter(op => op !== added && !sameObject(op.owner, reference) && !(reference.kind === "group" && op.groupId === reference.id) && !(op.op === "addEdge" && [op.edge.from, op.edge.to].some(owner => sameObject(owner, reference))));
      } else if (target.owner.kind === "group") operations.push({ op: "deleteGroup", groupId: target.groupId, expectedGroupRevision: target.expectedGroupRevision, impactVersion: target.impactVersion, reason: target.reason });
      else { this.requireVersion(target.expectedNodeRevision, "expectedNodeRevision", target.nodeId); operations.push({ op: "deleteNode", nodeId: target.nodeId, expectedNodeRevision: target.expectedNodeRevision }); }
    }
    return operations;
  }
  requireVersion(value, field, id) { if (value === undefined) fail("VERSION_REQUIRED", "Read the affected object and supply " + field + ".", 422, { field, target: id }); }
}
