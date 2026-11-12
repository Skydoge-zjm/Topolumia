import { omitFields } from "../../../domain/research/object-values.js";
import { groupCoreSchema, groupMembersSchema, MAX_GROUP_DEPTH } from "../../../domain/research/groups.js";
import { groupRef, objectKey, sameObject } from "../../../domain/research/object-ref.js";
import { fail } from "../../../domain/research/access.js";
import { versionHash } from "../../../lib/hash.js";
import type { ResearchCommandService } from "../research-command-service.js";
import type { ResearchView, StoredGroup, StoredNode, TopologyEdge, TopologyGroup } from "../../../domain/research/types.js";
export type GroupMembership = StoredGroup["members"][number] & {groupId:string};

export class GroupObjectService {
  store;
  constructor(public c: ResearchCommandService) { this.store = c.store; }
  list() { return this.store.all("groups").filter(group => !group.deleted); }
  get(id: string) { const group = this.store.get("groups", id); if (!group || group.deleted) fail("RESEARCH_GROUP_NOT_FOUND", "Node group not found.", 404); return group; }
  core(input: unknown) { const result = groupCoreSchema.safeParse(input); if (!result.success) fail("GROUP_CORE_INVALID", "Invalid group core.", 422, result.error.issues.slice(0, 6)); return result.data; }
  range(id: string, view:ResearchView = this.c.snapshot(null, { isAgent: false })) {
    const groupMap = new Map(view.groups.map(group => [group.id, group]));
    if (!groupMap.has(id)) fail("RESEARCH_GROUP_NOT_FOUND", "Node group not found.", 404);
    const groupIds: string[] = [], membership = new Map<string, GroupMembership[]>();
    const visit = (groupId: string) => { groupIds.push(groupId); for (const member of groupMap.get(groupId)!.members) { if (!membership.has(member.nodeId)) membership.set(member.nodeId, []); membership.get(member.nodeId)!.push({ groupId, ...member }); } for (const child of view.groups.filter(group => group.parentId === groupId).sort((a, b) => a.id.localeCompare(b.id))) visit(child.id); };
    visit(id);
    return { groupIds, nodeIds: [...membership.keys()], membership, scopeVersion: versionHash(groupIds.map(groupId => { const group = groupMap.get(groupId)!; return [groupId, group.membershipRevision, group.parentId, group.members]; })) };
  }
  validate(groups:StoredGroup[], nodes:StoredNode[], edges:TopologyEdge[]) {
    const active = groups.filter(group => !group.deleted), byId = new Map(active.map(group => [group.id, group])), nodeIds = new Set(nodes.filter(node => !node.deleted).map(node => node.id));
    for (const group of active) {
      const result = groupMembersSchema.safeParse(group.members); if (!result.success) fail("GROUP_MEMBERS_INVALID", "Invalid or repeated group members.", 422, result.error.issues.slice(0, 4));
      if (group.members.some(member => !nodeIds.has(member.nodeId))) fail("GROUP_MEMBER_INVALID", "Group members must be existing nodes in this project.");
      const seen = new Set([group.id]); let parentId = group.parentId, depth = 1;
      while (parentId) { if (seen.has(parentId)) fail("GROUP_CYCLE", "Group hierarchy cannot contain cycles."); const parent = byId.get(parentId); if (!parent) fail("GROUP_PARENT_INVALID", "Parent group does not exist."); seen.add(parentId); if (++depth > MAX_GROUP_DEPTH) fail("GROUP_DEPTH_LIMIT", `Groups support at most ${MAX_GROUP_DEPTH} levels.`); parentId = parent.parentId; }
      for (const [field, endpoint] of [["incomingRelationId", "to"], ["outgoingRelationId", "from"]] as const) if (group.primaryRelations?.[field]) { const edge = edges.find(item => item.id === group.primaryRelations[field]); if (!edge || !sameObject(edge[endpoint], groupRef(group.id))) fail("GROUP_PRIMARY_RELATION_INVALID", "Primary relation must directly connect this group in the specified direction."); }
    }
  }
  project(group:StoredGroup):TopologyGroup { return { id: group.id, core: { ...group.core, summary: group.core.summary?.slice(0, 240) }, parentId: group.parentId, members: group.members.map(member => ({ nodeId: member.nodeId })), primaryRelations: group.primaryRelations, revision: group.revision, coreRevision: group.coreRevision, membershipRevision: group.membershipRevision, relationRevision: group.relationRevision }; }
  detail(id:string) { const view = this.c.snapshot(null, { isAgent: false }), group = this.get(id), range = this.range(id, view), detail = this.c.objects.detail(groupRef(id)); const metadata=omitFields(group,["members"]); return { ...detail, group: metadata, contentBlocks: detail.contentBlocks.slice(0, 6).map(block => this.c.queries.blockSummary(block)), blockCount: detail.contentBlocks.length, membershipRevision: group.membershipRevision, counts: { directNodes: group.members.length, childGroups: view.groups.filter(child => child.parentId === id).length, recursiveUniqueNodes: range.nodeIds.length }, scopeVersion: range.scopeVersion }; }
  deleteImpact(id:string, view:ResearchView = this.c.snapshot(null, { isAgent: false })) {
    const group = view.groups.find(item => item.id === id) ?? fail("RESEARCH_GROUP_NOT_FOUND", "Node group not found.", 404), owner = groupRef(id);
    const children = view.groups.filter(item => item.parentId === id), parent = view.groups.find(item => item.id === group.parentId), relations = view.topology.edges.filter(edge => sameObject(edge.from, owner) || sameObject(edge.to, owner));
    const endpoints = [...new Map(relations.flatMap(edge => [edge.from, edge.to]).filter(ref => !sameObject(ref, owner)).map(ref => [objectKey(ref), { object: ref, revision: this.c.objects.from(view, ref).revision }])).values()];
    const blocks = view.blocks.filter(block => sameObject(block.owner, owner) && block.lifecycle !== "archived").map(block => ({ id: block.id, revision: block.revision, title: block.title }));
    const dependency = { group: { id, revision: group.revision }, parent: parent ? { id: parent.id, revision: parent.membershipRevision } : null, children: children.map(child => ({ id: child.id, revision: child.membershipRevision, label: child.core.nodeName })), relations: relations.map(edge => ({ id: edge.id, revision: edge.revision, from: edge.from, to: edge.to, type: edge.type })), endpoints, blocks };
    return { groupId: id, impactVersion: versionHash(dependency), preservedNodeCount: this.range(id, view).nodeIds.length, reparentTo: group.parentId, ...dependency };
  }
}
