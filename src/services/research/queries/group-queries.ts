import { groupRef, nodeRef } from "../../../domain/research/object-ref.js";
import { versionHash } from "../../../lib/hash.js";
import { fail } from "../../../domain/research/access.js";
import type { AgentResearchQueries, QueryInput } from "./context.js";
import type { StoredGroup, ResearchView } from "../../../domain/research/types.js";
import type { GroupMembership } from "../objects/group-service.js";
const clip = (value:unknown, length:number) => String(value ?? "").slice(0, length);

export function groupSummary(q:AgentResearchQueries, group:StoredGroup, view:ResearchView) {
  const owner = groupRef(group.id), range = q.c.groups.range(group.id, view), blocks = view.blocks.filter(block => block.owner?.kind === "group" && block.owner.id === group.id && block.lifecycle !== "archived").sort((a, b) => a.order - b.order);
  return { id: group.id, object: owner, label: group.core.nodeName, coreSummary: { ...group.core, summary: clip(group.core.summary, 240), tags: group.core.tags?.slice(0, 5) }, coreRefs: Object.fromEntries(Object.keys(group.core).map(field => [field, { ref: q.coreRef(group, field, owner), expectedVersion: String(group.coreRevision) }])), revision: group.revision, coreRevision: group.coreRevision, membershipRevision: group.membershipRevision, relationRevision: group.relationRevision, blockCollectionRevision: group.blockCollectionRevision, parentId: group.parentId, counts: { directNodes: group.members.length, childGroups: view.groups.filter(child => child.parentId === group.id).length, recursiveUniqueNodes: range.nodeIds.length }, primaryRelations: group.primaryRelations, scopeVersion: range.scopeVersion, blockCount: blocks.length, blocks: blocks.slice(0, 6).map(block => q.blockSummary(block)), omittedBlocks: Math.max(0, blocks.length - 6), readHint: { mode: "members", groupId: group.id, scope: "direct" } };
}

export function readGroups(q:AgentResearchQueries, input:QueryInput) {
  q.c.check(input.actor, "research.view");
  if(input.scope && !["direct","recursive"].includes(input.scope))fail("INPUT_INVALID","Invalid membership scope.");
  const view = q.c.snapshot(input.candidateId, input.actor);
  if (input.mode === "list") {
    const entries = view.groups.filter(group => !input.query || (group.core.nodeName + " " + (group.core.summary ?? "")).toLowerCase().includes(input.query!.toLowerCase())).map(group => ({ id: group.id, label: clip(group.core.nodeName, 160), category: group.core.category, revision: group.revision, directMemberCount: group.members.length, parentId: group.parentId, readHint: { mode: "show", groupId: group.id } }));
    return q.page("groups", entries, { ...input, maxChars: input.maxChars ?? 4000 }, { query: input.query, versions: entries.map(group => [group.id, group.revision]), candidate: input.candidateId });
  }
  const group = view.groups.find(item => item.id === input.groupId) ?? fail("RESEARCH_GROUP_NOT_FOUND", "Group unavailable.", 404), owner = groupRef(group.id);
  if (input.mode === "show" && input.section === "deleteImpact") {
    const impact = q.c.groups.deleteImpact(group.id, view), entries = [...impact.children.map(item => ({ entryType: "child", ...item })), ...impact.relations.map(item => ({ entryType: "relation", ...item })), ...impact.blocks.map(item => ({ entryType: "block", ...item }))];
    return q.page("groupImpact", entries, input, { id: group.id, impactVersion: impact.impactVersion, candidate: input.candidateId }, () => [q.receipt(input.actor, "impact", group.id, impact.impactVersion, "summary", { impactVersion: impact.impactVersion }, input, { owner })], { groupId: group.id, revision: group.revision, impactVersion: impact.impactVersion, preservedNodeCount: impact.preservedNodeCount, reparentTo: impact.reparentTo, counts: { children: impact.children.length, relations: impact.relations.length, blocks: impact.blocks.length } });
  }
  if (input.mode === "show") {
    const summary = groupSummary(q, group, view);
    const receipts = [q.receipt(input.actor, "core", group.id, group.coreRevision, "summary", { fields: Object.keys(group.core) }, input, { owner }), q.receipt(input.actor, "object", group.id, group.revision, "summary", {}, input, { owner }), q.receipt(input.actor, "membership", group.id, group.membershipRevision, "summary", { parentId: group.parentId }, input, { owner }), q.receipt(input.actor, "relation", group.id, group.relationRevision, "summary", {}, input, { owner })];
    const result = q.envelope("groups", summary, input); result.readReceipts = receipts;
    while (summary.blocks.length && JSON.stringify(result).length + 100 > result.budget.maxChars) { summary.blocks.pop(); summary.omittedBlocks++; }
    if (summary.omittedBlocks) result.coverage = { complete: false, omissions: ["blockDirectory"] };
    return q.finish(result, receipts);
  }
  const range = q.c.groups.range(group.id, view), nodeMap = new Map(view.nodes.map(node => [node.id, node]));
  const nodeEntry = (id:string, memberships:GroupMembership[] = []) => { const node = nodeMap.get(id); return { entryType: "node" as const, object: nodeRef(id), label: clip(node?.core.nodeName ?? id, 160), kind: node?.kind, status:node?.status, revision: node?.revision, memberships: memberships.slice(0, 6).map(item => ({ groupId: item.groupId, role: item.role, note: clip(item.note, input.scope === "recursive" ? 240 : 2000) })), omittedMemberships: Math.max(0, memberships.length - 6), readHint: { nodeIds: [id] } }; };
  const allEntries = input.scope === "recursive" ? range.nodeIds.map(id => nodeEntry(id, range.membership.get(id))) : [...group.members.map(member => nodeEntry(member.nodeId, [{ groupId: group.id, ...member }])), ...view.groups.filter(child => child.parentId === group.id).sort((a, b) => a.id.localeCompare(b.id)).map(child => ({ entryType: "group" as const, memberships:undefined, object: groupRef(child.id), label: clip(child.core.nodeName, 160), revision: child.revision, membershipRevision: child.membershipRevision, readHint: { mode: "show", groupId: child.id } }))];
  const entries = input.query ? allEntries.filter(entry => (entry.label+" "+JSON.stringify(entry.memberships??[])).toLowerCase().includes(input.query!.toLowerCase())) : allEntries;
  const scopeVersion = versionHash([range.scopeVersion, entries.map(entry => [entry.object, entry.revision])]);
  return q.page("groupMembers", entries, { ...input, limit: input.limit ?? 20 }, { group: group.id, scope: input.scope ?? "direct", query:input.query, scopeVersion, candidate: input.candidateId }, items => [q.receipt(input.actor, "membership", group.id, group.membershipRevision, input.scope === "recursive" ? "recursiveDirectory" : "directory", { nodeIds: items.filter(item => item.entryType === "node").map(item => item.object.id), scope: input.scope ?? "direct" }, input, { owner })], { groupId: group.id, membershipRevision: group.membershipRevision, scopeVersion, scope: input.scope ?? "direct" });
}
