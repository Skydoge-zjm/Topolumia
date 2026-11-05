import { versionHash } from "../../../lib/hash.js";

export function historyActor(actor) {
  if (!actor) return { type: "system", id: "system", name: "Topolumia" };
  const type = actor.actorType ?? actor.type ?? (actor.isAgent ? "agent" : "human");
  return {
    type,
    id: type === "agent" ? actor.principalId ?? actor.sessionId ?? actor.actorId ?? "agent" : actor.actorId ?? actor.user?.id ?? actor.id ?? "unknown",
    name: type === "agent" ? actor.agentName ?? "Agent" : actor.name ?? actor.user?.displayName ?? actor.user?.username ?? "Researcher",
    ...(type === "agent" ? { ownerId: actor.user?.id ?? actor.actorId ?? null } : {}),
    ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
    ...(actor.model ? { model: actor.model } : {}),
  };
}
function businessValue(value) {
  if (!value) return null;
  const { position, exploration, candidate, candidatePatchId, ...rest } = value;
  const data = { ...rest.data };
  for (const key of ["updatedAt", "updatedBy", "createdBy", "lastChangedBy", "acceptedFromPatchId", "humanEdited"]) delete data[key];
  return { ...rest, data };
}
export function subject(type, object) {
  if (!object) return null;
  return { type, id: object.id, kind: object.kind ?? object.type ?? type, label: object.label ?? object.core?.nodeName ?? object.title ?? object.id,
    summary: object.summary ?? object.core?.summary ?? object.description ?? "", status: object.status ?? null, version: versionHash(object) };
}
export function graphChanges(before, after) {
  const result = [];
  for (const [type, key] of [["node", "nodes"], ["group", "groups"], ["relation", "edges"]]) {
    const previous = new Map((before?.[key] ?? []).map(object => [object.id, object]));
    const current = new Map((after?.[key] ?? []).map(object => [object.id, object]));
    for (const [id, object] of current) {
      const old = previous.get(id);
      if (!old || versionHash(businessValue(old)) !== versionHash(businessValue(object))) result.push({ action: `${type}.${old ? "updated" : "created"}`, subject: subject(type, object), before: old ?? null, after: object });
    }
    for (const [id, object] of previous) if (!current.has(id)) result.push({ action: `${type}.deleted`, subject: subject(type, object), before: object, after: null });
  }
  return result;
}
export function plannedChanges(patch, topology) {
  return (patch.operations ?? []).filter(operation => operation.op !== "noop").map(operation => {
    if (operation.op === "addNode") return { action:"node.created",subject:subject("node",operation.node),before:null,after:operation.node };
    if (operation.op === "addGroup") return { action:"group.created",subject:subject("group",operation.group),before:null,after:operation.group };
    if (operation.op === "addEdge") return { action:"relation.created",subject:subject("relation",operation.edge),before:null,after:operation.edge };
    const owner=operation.owner??(operation.groupId?{kind:"group",id:operation.groupId}:{kind:"node",id:operation.nodeId});
    const object=topology?.[owner.kind==="group"?"groups":"nodes"]?.find(item=>item.id===owner.id)??{id:owner.id};
    const deleting=["deleteNode","deleteGroup"].includes(operation.op);
    return { action:owner.kind+"."+(deleting?"deleted":"updated"),subject:subject(owner.kind,object),before:object,after:deleting?null:{...object,...operation.patch} };
  });
}
