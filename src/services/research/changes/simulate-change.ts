import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fail, principal, actorIdentity } from "../../../domain/research/access.js";
import { objectKey, sameObject, nodeRef, groupRef } from "../../../domain/research/object-ref.js";
import { applyExperimentPatch, registerRecordRuns } from "./experiment-mutations.js";

const merge = (old, patch) => { const value = { ...old }; for (const [key, item] of Object.entries(patch)) item === null ? delete value[key] : value[key] = item; return value; };

/** Pure simulation; all persistent writes are performed by the shared transaction. */
export function simulateChange(c, operations, actor, allocation = {}, candidateId = "direct", evidenceIds, checkEvidence = false) {
  const graph = c.formalTopology(), nodeValues = structuredClone(c.nodes.nodes()), groupValues = structuredClone(c.groups.list());
  const objects = new Map([...nodeValues.map(value => [objectKey(nodeRef(value.id)), value]), ...groupValues.map(value => [objectKey(groupRef(value.id)), value])]);
  const original = structuredClone(objects), blocks = new Map(c.store.all("blocks").map(block => [block.id, structuredClone(block)])), originalBlocks = structuredClone(blocks);
  const baseView = { nodes: structuredClone(nodeValues), groups: structuredClone(groupValues), blocks: [...originalBlocks.values()], topology: graph };
  let edges = structuredClone(graph.edges);
  const touched = new Map(), newObjects = new Set(), newBlocks = new Set(), changedBlocks = new Set(), cores = new Set(), collections = new Set(), memberships = new Set(), relationOwners = new Set(), assetIds = new Set(), deleted = [];
  const allocate = (kind, key) => allocation[kind + ":" + key] ?? (allocation[kind + ":" + key] = kind + ":" + randomUUID());
  const resolve = (id, kind) => id?.startsWith("@") ? allocation[kind + ":" + id.slice(1)] ?? fail("CLIENT_REF_INVALID", "Undefined internal reference.") : id;
  const ref = owner => ({ kind: owner.kind, id: resolve(owner.id, owner.kind) });
  const get = owner => { const value = objects.get(objectKey(owner)); if (!value || value.deleted) fail("RESEARCH_OBJECT_NOT_FOUND", "Research object unavailable.", 404, { owner }); return value; };
  const touch = (owner, part) => { const key = objectKey(owner); touched.set(key, owner); part?.add(key); };
  const cas = (actual, expected, id) => { if (actual !== expected) fail("OBJECT_VERSION_CONFLICT", "Research object changed. Reload and review.", 409, { id, expected, current: actual }); };
  const reads = c.store.all("receipts").filter(read => read.principalId === principal(actor) && read.researchSessionId === (actor.sessionId ?? null));
  if (evidenceIds?.some(id => !reads.some(read => read.id === id))) fail("READ_RECEIPT_INVALID", "Unknown or foreign reading receipt.");
  const permitted = evidenceIds === undefined ? reads : reads.filter(read => evidenceIds.includes(read.id));
  for (const read of evidenceIds ? permitted : []) {
    if (read.scope === "candidate" && read.candidateId !== candidateId) fail("READ_RECEIPT_INVALID", "Candidate evidence belongs to another proposal.");
    if (read.object.kind === "source") { const source = c.sources().find(item => item.ref === read.object.id); if (!source || (source.version ?? (source.hash ? "sha256:" + source.hash : null)) !== read.version) fail("OBJECT_VERSION_CONFLICT", "Evidence source changed.", 409); }
    if (read.object.kind === "asset") { const asset = c.assets.assert(read.object.id, actor); if (asset.checksum !== read.version || read.contentVersion && asset.contentVersion && read.contentVersion !== asset.contentVersion) fail("OBJECT_VERSION_CONFLICT", "Asset evidence changed.", 409); }
  }
  const evidence = (kind, id, version, owner, content = false) => {
    if (!checkEvidence || !actor.isAgent || newObjects.has(objectKey(owner))) return;
    if (!permitted.some(read => read.scope === "formal" && read.object.kind === kind && read.object.id === id && sameObject(read.owner, owner) && read.version === version && (!content || read.disclosure !== "summary"))) fail("EVIDENCE_SCOPE_INSUFFICIENT", "Read this object at its current version before changing it.", 422, { kind, id, version, owner });
  };
  const checkObject = (owner, field, expected, kind = "core", content = false) => { if (newObjects.has(objectKey(owner))) return; const base = original.get(objectKey(owner)); cas(base?.[field], expected, owner.id); evidence(kind, owner.id, base[field], owner, content); };
  const localize = (input, key) => { const value = structuredClone(input); value.sourceRefs = (value.sourceRefs ?? []).map((source, i) => { const { delivery: _delivery, ...rest } = source; return { ...rest, id: source.id ?? allocate("source", key + ":" + (source.clientRef ?? i)) }; }); value.representations = (value.representations ?? []).map((rep, i) => ({ ...rep, id: rep.id ?? allocate("representation", key + ":" + (rep.clientRef ?? i)) })); return value; };
  const normalize = (input, id, owner = undefined) => {
    const value = localize(input, id);
    if (value.payloadFromAsset) { if (value.payload !== undefined || value.type !== "richText") fail("CONTENT_BLOCK_INVALID", "payloadFromAsset requires richText and excludes payload."); value.payload = { format: value.payloadFromAsset.format, body: c.assets.textSync(value.payloadFromAsset.assetId, actor) }; assetIds.add(value.payloadFromAsset.assetId); delete value.payloadFromAsset; }
    const block = c.objects.validateBlock(value, actor);
    if (block.type === "experimentRecord") { if (!owner) fail("NODE_NOT_EXPERIMENT", "Experiment owner required."); registerRecordRuns(c, get(owner), owner, block, actor, allocate); }
    for (const source of [...block.sourceRefs, ...block.representations]) if (source.assetId) assetIds.add(source.assetId); return block;
  };
  const siblings = owner => [...blocks.values()].filter(block => sameObject(block.owner, owner) && block.lifecycle !== "archived").sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const relate = owner => { if (objects.get(objectKey(owner)) && !objects.get(objectKey(owner)).deleted) touch(owner, relationOwners); };
  const removeEdge = edge => { edges = edges.filter(item => item.id !== edge.id); relate(edge.from); relate(edge.to); for (const [key, object] of objects) if (!object.deleted && object.primaryRelations) for (const field of ["incomingRelationId", "outgoingRelationId"]) if (object.primaryRelations[field] === edge.id) { delete object.primaryRelations[field]; touch(touched.get(key) ?? groupRef(object.id), relationOwners); } };
  const endpointCheck = (owner, versions) => { get(owner); if (newObjects.has(objectKey(owner))) return; const expected = versions?.find(item => sameObject(item.object, owner))?.revision; cas(original.get(objectKey(owner))?.revision, expected, owner.id); evidence("core", owner.id, original.get(objectKey(owner)).coreRevision, owner); };

  for (const [index, op] of operations.entries()) {
    if (op.op === "addNode" || op.op === "addGroup") {
      const kind = op.op === "addNode" ? "node" : "group", id = allocate(kind, op.clientRef), owner = { kind, id }, key = objectKey(owner);
      if (objects.has(key)) fail("CLIENT_REF_INVALID", "Repeated object reference.");
      const value = { id, projectId: c.projectId, ...(kind === "node" ? { kind: op.kind } : { members: structuredClone(op.members), parentId: op.parentId, primaryRelations: {}, membershipRevision: 1 }), core: kind === "node" ? c.nodes.core(op.core, op.kind) : c.groups.core(op.core), sourceRefs: c.objects.sources(localize({ sourceRefs: op.sourceRefs }, key).sourceRefs, actor), revision: 1, coreRevision: 1, blockCollectionRevision: 1, relationRevision: 1, status: "active", createdBy: actorIdentity(actor) };
      objects.set(key, value); newObjects.add(key); touch(owner);
      if (kind === "node" && op.kind === "experiment") Object.assign(value, { runs: [], materialLinks: [], experimentRevision: 1 });
      if (kind === "group" && op.parentId) { const parentOwner = groupRef(resolve(op.parentId, "group")); get(parentOwner); checkObject(parentOwner, "membershipRevision", op.expectedParentRevision, "membership"); value.parentId = parentOwner.id; touch(parentOwner, memberships); }
      continue;
    }
    if (["addEdge", "updateEdge", "deleteEdge"].includes(op.op)) {
      if (op.op === "addEdge") {
        const from = ref(op.edge.from), to = ref(op.edge.to); if (sameObject(from, to)) fail("RELATION_INVALID", "A relation must connect distinct research objects.");
        endpointCheck(from, op.expectedEndpointRevisions); endpointCheck(to, op.expectedEndpointRevisions);
        edges.push({ id: allocate("edge", op.clientRef), revision: 1, from, to, type: op.edge.type, label: { zh: op.label ?? op.edge.type, en: op.label ?? op.edge.type }, status: "active" }); relate(from); relate(to);
      } else {
        const edge = edges.find(item => item.id === op.edgeId); if (!edge) fail("RELATION_NOT_FOUND", "Relation not found.", 404);
        const base = graph.edges.find(item => item.id === edge.id); if (base) cas(base.revision, op.expectedRevision, edge.id);
        endpointCheck(edge.from, op.expectedEndpointRevisions); endpointCheck(edge.to, op.expectedEndpointRevisions);
        if (op.op === "deleteEdge") removeEdge(edge); else { if (op.patch.type !== undefined) edge.type = op.patch.type; if (op.patch.label !== undefined) edge.label = { zh: op.patch.label, en: op.patch.label }; edge.revision = (base?.revision ?? 0) + 1; relate(edge.from); relate(edge.to); }
      }
      continue;
    }
    const owner = op.owner ? ref(op.owner) : op.groupId ? groupRef(resolve(op.groupId, "group")) : nodeRef(resolve(op.nodeId, "node")), object = get(owner), key = objectKey(owner), base = original.get(key);
    if (op.op === "editExperiment") {
      checkObject(owner, "experimentRevision", op.expectedExperimentRevision, "experiment", true);
      if (checkEvidence && actor.isAgent && !newObjects.has(key)) {
        const observed = permitted.filter(read => read.scope === "formal" && read.object.kind === "experiment" && sameObject(read.owner, owner) && read.version === base.experimentRevision);
        const runs = new Set(observed.filter(read => read.delivered?.section === "runs").flatMap(read => read.delivered.runIds ?? []));
        const links = new Set(observed.filter(read => read.delivered?.section === "materials").flatMap(read => read.delivered.linkIds ?? []));
        const formalRunIds = new Set((base.runs ?? []).map(run => run.id)), formalLinkIds = new Set((base.materialLinks ?? []).map(link => link.id));
        if ([...(op.patch.updateRuns ?? []).map(run => run.id), ...(op.patch.removeRunIds ?? []), ...(op.patch.addLinks ?? []).map(link => link.runId)].some(id => formalRunIds.has(id) && !runs.has(id)) || (op.patch.removeLinkIds ?? []).some(id => formalLinkIds.has(id) && !links.has(id))) fail("EVIDENCE_SCOPE_INSUFFICIENT", "Read the run records or material associations you are changing.", 422);
        for (const link of op.patch.addLinks ?? []) {
          if (!newBlocks.has(link.blockId)) evidence("block", link.blockId, link.blockRevision, owner);
          if (link.selection.kind === "assetRow") {
            const asset=c.assets.assert(link.selection.assetId,actor),sheet=link.selection.sheet??asset.defaultSheet??null;
            if(!permitted.some(read=>(read.scope==="formal"||read.candidateId===candidateId)&&read.object.kind==="asset"&&read.object.id===asset.id&&read.version===asset.checksum&&read.delivered?.tableRanges?.some(range=>(range.sheet??null)===sheet&&range.start<=link.selection.rowIndex&&range.end>link.selection.rowIndex)))fail("EVIDENCE_SCOPE_INSUFFICIENT","Read the selected file's worksheet row before associating it.",422);
          }
        }
      }
      applyExperimentPatch(c, object, owner, op.patch, blocks, allocate, index, actor, assetIds); touch(owner); continue;
    }
    if (op.op === "updateCore") { checkObject(owner, "coreRevision", op.expectedCoreRevision, "core", true); object.core = owner.kind === "group" ? c.groups.core(merge(object.core, op.patch)) : c.nodes.core(merge(object.core, op.patch), object.kind); if (op.sourceRefs) object.sourceRefs = c.objects.sources(localize({ sourceRefs: op.sourceRefs }, key).sourceRefs, actor); touch(owner, cores); continue; }
    if (op.op === "updateMembers") {
      checkObject(owner, "membershipRevision", op.expectedMembershipRevision, "membership", true);
      if (checkEvidence && actor.isAgent && !newObjects.has(key)) {
        const seen = new Set(permitted.filter(read => read.scope === "formal" && read.object.kind === "membership" && sameObject(read.owner, owner) && read.version === base.membershipRevision && read.delivered?.scope === "direct").flatMap(read => read.delivered.nodeIds ?? []));
        const required = op.patch.order ?? [...(op.patch.remove ?? []), ...(op.patch.update ?? []).map(item => item.nodeId)];
        if (required.some(id => !seen.has(id))) fail("EVIDENCE_SCOPE_INSUFFICIENT", "Read the direct members you are changing; a full reorder requires all members.");
      }
      const next = object.members.filter(member => !(op.patch.remove ?? []).includes(member.nodeId)).map(member => ({ ...member }));
      for (const update of op.patch.update ?? []) { const member = next.find(item => item.nodeId === update.nodeId); if (!member) fail("GROUP_MEMBER_NOT_FOUND", "Member is not directly in this group."); Object.assign(member, merge(member, update)); for (const field of ["role", "note"]) if (update[field] === null) delete member[field]; }
      for (const member of op.patch.add ?? []) { if (next.some(item => item.nodeId === member.nodeId)) fail("GROUP_MEMBER_DUPLICATE", "This node already belongs to the group."); get(nodeRef(member.nodeId)); next.push({ ...member }); }
      if (op.patch.order) { const ids = op.patch.order; if (ids.length !== next.length || new Set(ids).size !== next.length || next.some(member => !ids.includes(member.nodeId))) fail("GROUP_ORDER_INVALID", "Supply all direct members exactly once."); next.sort((a, b) => ids.indexOf(a.nodeId) - ids.indexOf(b.nodeId)); }
      object.members = next; touch(owner, memberships); continue;
    }
    if (op.op === "setGroupParent") {
      checkObject(owner, "membershipRevision", op.expectedMembershipRevision, "membership"); const newParent = op.parentId ? resolve(op.parentId, "group") : null;
      for (const parentId of new Set([object.parentId, newParent].filter(Boolean))) { const parentOwner = groupRef(parentId); get(parentOwner); checkObject(parentOwner, "membershipRevision", op.expectedParentRevisions[parentId], "membership"); touch(parentOwner, memberships); }
      object.parentId = newParent; touch(owner, memberships); continue;
    }
    if (op.op === "setGroupPrimaryRelations") { checkObject(owner, "relationRevision", op.expectedRelationRevision, "relation"); object.primaryRelations = merge(object.primaryRelations, op.patch); touch(owner, relationOwners); continue; }
    if (op.op === "deleteNode" || op.op === "deleteGroup") {
      checkObject(owner, "revision", op.op === "deleteNode" ? op.expectedNodeRevision : op.expectedGroupRevision, "object");
      if (owner.kind === "group") {
        const impact = c.groups.deleteImpact(owner.id, baseView); cas(impact.impactVersion, op.impactVersion, owner.id); evidence("impact", owner.id, op.impactVersion, owner);
        for (const [childKey, child] of objects) if (childKey.startsWith('["group",') && !child.deleted && child.parentId === owner.id) { child.parentId = object.parentId; touch(groupRef(child.id), memberships); }
        if (object.parentId) touch(groupRef(object.parentId), memberships);
      } else for (const [groupKey, group] of objects) if (groupKey.startsWith('["group",') && !group.deleted && group.members.some(member => member.nodeId === owner.id)) { group.members = group.members.filter(member => member.nodeId !== owner.id); touch(groupRef(group.id), memberships); }
      object.deleted = true; deleted.push(owner); touch(owner);
      for (const block of siblings(owner)) { block.lifecycle = "archived"; changedBlocks.add(block.id); }
      for (const edge of [...edges]) if (sameObject(edge.from, owner) || sameObject(edge.to, owner)) removeEdge(edge);
      continue;
    }
    if (op.op === "addBlock") {
      if (op.expectedCollectionRevision !== undefined) checkObject(owner, "blockCollectionRevision", op.expectedCollectionRevision, "collection");
      if (op.insertAfterBlockId && op.expectedCollectionRevision === undefined && !newObjects.has(key)) fail("VERSION_REQUIRED", "Ordered insert requires a collection version.");
      const id = allocate("block", op.clientRef); if (blocks.has(id)) fail("CLIENT_REF_INVALID", "Repeated block reference.");
      const { op: _op, owner: _owner, clientRef: _client, insertAfterBlockId, expectedCollectionRevision: _version, ...input } = op, items = siblings(owner); let order = items.length;
      if (insertAfterBlockId) { const at = items.findIndex(block => block.id === resolve(insertAfterBlockId, "block")); if (at < 0) fail("CONTENT_BLOCK_NOT_FOUND", "Insertion anchor not found."); order = at + 1; for (const block of items.slice(order)) block.order++; }
      blocks.set(id, { ...normalize(input, id, owner), id, owner, order, revision: 1, lifecycle: "active", createdAt: new Date().toISOString(), createdBy: actorIdentity(actor) }); newBlocks.add(id); changedBlocks.add(id); touch(owner, collections); continue;
    }
    if (op.op === "reorderBlocks") { checkObject(owner, "blockCollectionRevision", op.expectedCollectionRevision, "collection"); const ids = op.blockIds.map(id => resolve(id, "block")), items = siblings(owner); if (ids.length !== items.length || new Set(ids).size !== items.length || items.some(block => !ids.includes(block.id))) fail("CONTENT_BLOCK_ORDER_INVALID", "Supply all active blocks exactly once."); ids.forEach((id, order) => blocks.get(id).order = order); touch(owner, collections); continue; }
    const blockId = resolve(op.blockId ?? op.blockRef, "block"), block = blocks.get(blockId), previous = originalBlocks.get(blockId);
    if (!block || !sameObject(block.owner, owner) || block.lifecycle === "archived") fail("CONTENT_BLOCK_NOT_FOUND", "Block unavailable.", 404);
    if (!newBlocks.has(blockId)) { cas(previous?.revision, op.expectedRevision, blockId); evidence("block", blockId, previous.revision, owner, op.op === "updateBlock" && ["payload", "payloadFromAsset", "type"].some(field => field in op.patch)); }
    if (op.op === "archiveBlock") { block.lifecycle = "archived"; touch(owner, collections); }
    else {
      const { id: _id, owner: _owner, order: _order, revision: _revision, lifecycle: _lifecycle, createdAt: _created, createdBy: _author, updatedAt: _updated, updatedBy: _updater, ...current } = block;
      let next;
      if (op.op === "updateBlock") { next = merge(current, op.patch); if (op.patch.payloadFromAsset) delete next.payload; }
      else if (op.op === "bindAsset") next = { ...current, representations: [...current.representations, { ...op.representation, id: op.representation.id ?? allocate("representation", blockId + ":" + index) }] };
      else if (op.op === "unbindAsset") { if (!current.representations.some(rep => rep.id === op.representationId)) fail("REPRESENTATION_NOT_FOUND", "Representation unavailable."); next = { ...current, representations: current.representations.filter(rep => rep.id !== op.representationId) }; delete next.primaryRepresentationId; }
      if (!next) fail("INPUT_INVALID", "Unsupported operation.");
      if (op.op === "bindAsset" && op.makePrimary) next.primaryRepresentationId = next.representations.at(-1).id;
      const normalized = normalize(next, blockId, owner);
      if (op.op !== "updateBlock" || !Object.hasOwn(op.patch, "sourceRefs")) normalized.sourceRefs = normalized.sourceRefs.map(source => ({ ...source, delivery: current.sourceRefs.find(original => original.id === source.id)?.delivery ?? source.delivery }));
      for (const field of ["payload", "primaryRepresentationId"]) if (!Object.hasOwn(normalized, field)) delete block[field]; Object.assign(block, normalized);
    }
    changedBlocks.add(blockId); touch(owner);
  }
  for (const key of newObjects) {
    const object = objects.get(key);
    if (object.kind !== "note") continue;
    const owner = nodeRef(object.id), items = siblings(owner);
    if (!items.some(block => block.role === "body")) {
      const first = items.find(block => block.type === "richText");
      if (first) first.role = "body";
      else {
        const id = allocate("block", "body:" + object.id);
        blocks.set(id, { ...normalize({ title: "正文", type: "richText", role: "body", payload: { format: "markdown", body: "" } }, id), id, owner, order: items.length, revision: 1, lifecycle: "active", createdAt: new Date().toISOString(), createdBy: actorIdentity(actor) });
        newBlocks.add(id); changedBlocks.add(id); touch(owner, collections);
      }
    }
  }
  for (const [key, object] of objects) {
    if (object.deleted) continue;
    const owner = key.startsWith('["node",') ? nodeRef(object.id) : groupRef(object.id);
    const bodies = siblings(owner).filter(block => block.role === "body");
    if (bodies.length && (object.kind !== "note" || bodies.length > 1)) fail("CONTENT_BLOCK_INVALID", "Only a research note can have one primary body.");
    if (object.kind === "experiment" && !newObjects.has(key)) {
      const before = original.get(key);
      if (JSON.stringify([before?.runs ?? [], before?.materialLinks ?? []]) !== JSON.stringify([object.runs ?? [], object.materialLinks ?? []])) { object.experimentRevision = (before?.experimentRevision ?? 1) + 1; touch(owner); }
    }
  }
  const nodes = [...objects].filter(([key]) => key.startsWith('["node",')).map(([, value]) => value), groups = [...objects].filter(([key]) => key.startsWith('["group",')).map(([, value]) => value);
  c.groups.validate(groups, nodes, edges);
  for (const [key] of touched) { const object = objects.get(key); if (!newObjects.has(key)) object.revision++; if (cores.has(key)) object.coreRevision++; if (collections.has(key) && !newObjects.has(key)) object.blockCollectionRevision++; if (memberships.has(key) && !newObjects.has(key)) object.membershipRevision++; if (relationOwners.has(key)) object.relationRevision++; }
  for (const id of changedBlocks) { const block = blocks.get(id); if (!newBlocks.has(id)) block.revision++; block.updatedAt = new Date().toISOString(); block.updatedBy = actorIdentity(actor); }
  for (const [key, owner] of touched) { for (const source of objects.get(key).sourceRefs ?? []) if (source.assetId) assetIds.add(source.assetId); if (collections.has(key)) siblings(owner).forEach((block, order) => block.order = order); }
  for (const id of assetIds) { const asset = c.assets.assert(id, actor); if (!existsSync(c.assets.file(asset))) fail("ASSET_UNAVAILABLE", "Asset bytes are missing.", 409); }
  const topology = c.topologyService.withObjects(graph, nodes.filter(node => !node.deleted).map(node => c.nodes.project(node, graph)), edges, groups.filter(group => !group.deleted).map(group => c.groups.project(group)));
  const deletedNodes = deleted.filter(owner => owner.kind === "node").map(owner => owner.id); if (deletedNodes.length) topology.deletedNodeIds = [...new Set([...(graph.deletedNodeIds ?? []), ...deletedNodes])];
  return { nodes: nodes.filter(node => !node.deleted), groups: groups.filter(group => !group.deleted), blocks: [...blocks.values()], topology, touched: [...touched.values()], deleted, allocation, assetIds: [...assetIds], allObjects: objects };
}
