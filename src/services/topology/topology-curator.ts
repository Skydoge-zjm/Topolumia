import { AppError } from "../../lib/errors.js";
import { versionHash } from "../../lib/hash.js";
import { validateTopologyCuratorResult, validateTopologyPatchProposal } from "../../domain/validators.js";
import { CodexCuratorDriver } from "../../adapters/agents/codex/codex-curator-driver.js";

function snapshotSourceRefs(snapshot) {
  return [
    ...(snapshot?.git?.ref ? [snapshot.git.ref] : []),
    ...(snapshot?.mlflow?.runs ?? []).map((item) => item.ref),
    ...(snapshot?.experiments?.wandb?.runs ?? []).map((item) => item.ref),
    ...(snapshot?.experiments?.tensorboard?.runs ?? []).map((item) => item.ref),
    ...(snapshot?.experiments?.simulation?.runs ?? []).map((item) => item.ref),
    ...(snapshot?.files?.files ?? []).map((item) => item.ref),
  ].filter(Boolean);
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function slug(value) {
  return String(value ?? "item")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 64) || "item";
}

function bilingual(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.zh !== "string" || !value.zh.trim() || typeof value.en !== "string" || !value.en.trim()) return null;
  return { zh: value.zh.trim(), en: value.en.trim() };
}

function fallbackPosition(topology, evidenceNodeIds, index) {
  const selected = new Map((topology.nodes ?? []).map((node) => [node.id, node]));
  const anchors = evidenceNodeIds.map((id) => selected.get(id)?.position).filter((position) => Number.isFinite(position?.x) && Number.isFinite(position?.y));
  const base = anchors.length
    ? anchors.reduce((sum, position) => ({ x: sum.x + position.x / anchors.length, y: sum.y + position.y / anchors.length }), { x: 0, y: 0 })
    : { x: 900, y: 980 };
  return { x: Math.round(base.x + 180 + (index % 3) * 190), y: Math.round(base.y + 160 + Math.floor(index / 3) * 150) };
}

function normalizeOperations(rawOperations, { topology, patchToken, evidenceNodeIds, runId, allowedSourceRefs = new Set() }) {
  const existingNodeIds = new Set((topology.nodes ?? []).map((node) => node.id));
  const existingEdgeIds = new Set((topology.edges ?? []).map((edge) => edge.id));
  const nodeIdMap = new Map();
  const usedNodeIds = new Set(existingNodeIds);
  const usedEdgeIds = new Set(existingEdgeIds);
  const operations = [];
  const candidateId = (raw, index, kind, used) => {
    const requested = slug(raw);
    let id = `candidate:${patchToken}:${kind}-${requested || index + 1}`;
    let suffix = 2;
    while (used.has(id)) id = `candidate:${patchToken}:${kind}-${requested || index + 1}-${suffix++}`;
    used.add(id);
    return id;
  };

  // Allocate every new node identity before resolving edge endpoints. The
  // model may order addEdge before addNode; semantic order must not affect
  // whether a valid proposal is accepted.
  for (const [index, operation] of (Array.isArray(rawOperations) ? rawOperations : []).entries()) {
    if (operation?.op !== "addNode") continue;
    const source = operation.node ?? {};
    const id = candidateId(source.id, index, "node", usedNodeIds);
    if (source.id) nodeIdMap.set(source.id, id);
  }

  for (const [index, operation] of (Array.isArray(rawOperations) ? rawOperations : []).entries()) {
    if (!operation || typeof operation !== "object") throw new AppError("CURATOR_OPERATION_INVALID", `Curator operation ${index} 不是对象。`, { status: 422 });
    if (operation.op === "addNode") {
      const source = operation.node ?? {};
      const id = nodeIdMap.get(source.id) ?? candidateId(source.id, index, "node", usedNodeIds);
      if (source.id) nodeIdMap.set(source.id, id);
      const label = bilingual(source.label);
      const summary = bilingual(source.summary);
      if (!label || !summary) throw new AppError("CURATOR_OPERATION_INVALID", `Curator 新节点 ${index} 缺少双语 label/summary。`, { status: 422 });
      const rawData = source.data && typeof source.data === "object" ? source.data : {};
      const dataSourceRefs = unique(rawData.sourceRefs);
      const invalidDataRefs = dataSourceRefs.filter((ref) => !allowedSourceRefs.has(ref));
      if (invalidDataRefs.length) throw new AppError("CURATOR_EVIDENCE_INVALID", `Curator 节点 ${index} 包含未授权 source ref。`, { status: 422, detail: { invalidDataRefs } });
      operations.push({
        op: "addNode",
        node: {
          id,
          kind: source.kind,
          code: typeof source.code === "string" && source.code.trim() ? source.code.trim().slice(0, 40) : `C-${index + 1}`,
          position: Number.isFinite(source.position?.x) && Number.isFinite(source.position?.y) ? source.position : fallbackPosition(topology, evidenceNodeIds, index),
          label,
          summary,
          status: "candidate",
          data: { ...rawData, sourceRefs: dataSourceRefs, provenance: "model-b", curatorRunId: runId },
        },
      });
      continue;
    }
    if (operation.op === "addEdge") {
      const source = operation.edge ?? {};
      const id = candidateId(source.id, index, "edge", usedEdgeIds);
      const label = bilingual(source.label);
      if (!label) throw new AppError("CURATOR_OPERATION_INVALID", `Curator 新关系 ${index} 缺少双语 label。`, { status: 422 });
      operations.push({
        op: "addEdge",
        edge: {
          id,
          from: { ...source.from, id: source.from?.kind === "node" ? nodeIdMap.get(source.from.id) ?? source.from.id : source.from?.id },
          to: { ...source.to, id: source.to?.kind === "node" ? nodeIdMap.get(source.to.id) ?? source.to.id : source.to?.id },
          type: source.type,
          label,
          status: "candidate",
        },
      });
      continue;
    }
    if (operation.op === "updateNode") {
      const patch = operation.patch && typeof operation.patch === "object" ? { ...operation.patch } : {};
      if (patch.label !== undefined) patch.label = bilingual(patch.label);
      if (patch.summary !== undefined) patch.summary = bilingual(patch.summary);
      delete patch.data;
      delete patch.sourceRef;
      delete patch.adapter;
      operations.push({ op: "updateNode", nodeId: nodeIdMap.get(operation.nodeId) ?? operation.nodeId, patch });
      continue;
    }
    if (operation.op === "noop") operations.push({ op: "noop" });
    else throw new AppError("CURATOR_OPERATION_INVALID", `Curator 不支持 operation ${String(operation.op)}。`, { status: 422 });
  }
  return operations;
}

function contextFor(input, relevantEvents) {
  return {
    trigger: input.context?.trigger ?? {
      mode: input.mode ?? "manual",
      cause: input.cause ?? "user_request",
      triggerId: input.triggerId ?? null,
      fingerprint: input.fingerprint ?? null,
    },
    sourceStateVersion: input.sourceStateVersion ?? null,
    operation: input.context?.operation ?? input.operation ?? null,
    entryContext: input.context?.entryContext ?? null,
    workingContext: input.context?.workingContext ?? {
      nodeIds: input.nodeIds ?? [],
      sourceRefs: input.sourceRefs ?? [],
    },
    observedContext: input.context?.observedContext ?? null,
    continuityContext: input.context?.continuityContext ?? null,
    focus: input.context?.focus ?? null,
    eventRange: { from: relevantEvents[0]?.id ?? null, to: relevantEvents.at(-1)?.id ?? null },
  };
}

export class TopologyCuratorService {
  constructor(options = {}) {
    this.adapter = options.adapter ?? "codex-topology-curator";
    this.model = options.model ?? options.config?.model ?? "gpt-6-luna";
    this.driver = options.driver ?? new CodexCuratorDriver({
      ...(options.config ?? {}),
      model: this.model,
    });
  }

  async preview({ topology, events = [], snapshot = null, ...input } = {}) {
    if (!topology) throw new AppError("TOPOLOGY_REQUIRED", "需要当前正式拓扑才能整理候选层。", { status: 409 });
    const relevantEvents = events.filter((event) => event.type !== "topologyChange").slice(-120);
    const allowedRefs = new Set([
      ...snapshotSourceRefs(snapshot),
      ...topology.nodes.map((item) => item.sourceRef).filter(Boolean),
      ...topology.nodes.flatMap((item) => item.data?.sourceRefs ?? []),
      ...topology.edges.map((item) => item.sourceRef).filter(Boolean),
    ]);
    const driverRun = await this.driver.run({
      topology,
      snapshot,
      events: relevantEvents,
      context: contextFor(input, relevantEvents),
      locale: input.locale ?? "zh",
    });
    const raw = driverRun.result;
    const actualNodeIds = new Set(driverRun.trace?.observedNodeIds ?? []);
    const actualEdgeIds = new Set(driverRun.trace?.observedEdgeIds ?? []);
    const claimedNodeIds = unique(raw.inspectedNodeIds);
    const claimedEdgeIds = unique(raw.inspectedEdgeIds);
    const inspectedNodeIds = claimedNodeIds.filter((id) => actualNodeIds.has(id));
    const inspectedEdgeIds = claimedEdgeIds.filter((id) => actualEdgeIds.has(id));
    const evidenceNodeIds = unique(raw.evidenceNodeIds).filter((id) => inspectedNodeIds.includes(id));
    const observedSourceRefs = new Set(driverRun.trace?.observedSourceRefs ?? []);
    const topologyNodeById = new Map(topology.nodes.map((item) => [item.id, item]));
    for (const nodeId of inspectedNodeIds) {
      const node = topologyNodeById.get(nodeId);
      if (node?.sourceRef) observedSourceRefs.add(node.sourceRef);
      for (const ref of node?.data?.sourceRefs ?? []) observedSourceRefs.add(ref);
    }
    const claimedSourceRefs = unique(raw.sourceRefs);
    const invalidSourceRefs = claimedSourceRefs.filter((ref) => !allowedRefs.has(ref) || !observedSourceRefs.has(ref));
    if (invalidSourceRefs.length) {
      throw new AppError("CURATOR_EVIDENCE_INVALID", "Curator 引用了未实际读取或未授权的 source ref。", {
        status: 422,
        detail: { invalidSourceRefs },
      });
    }
    const result = {
      schemaVersion: "topology-curator-result.v1",
      disposition: raw.disposition,
      summary: raw.summary,
      reason: raw.reason,
      reasonEn: raw.reasonEn,
      sourceRefs: claimedSourceRefs,
      evidenceNodeIds,
      inspectedNodeIds,
      inspectedEdgeIds,
      uncertainties: unique(raw.uncertainties),
      questions: unique(raw.questions),
      patch: null,
      runId: driverRun.runId,
      model: driverRun.model,
      threadId: driverRun.threadId,
      usage: driverRun.usage,
      explorationTrace: driverRun.trace,
      workspacePath: driverRun.workspacePath,
    };
    if (raw.disposition === "proposal") {
      if (!evidenceNodeIds.length) {
        throw new AppError("CURATOR_EVIDENCE_INVALID", "Curator proposal 没有可验证的拓扑证据。", {
          status: 422,
          detail: { claimedNodeIds, observedNodeIds: [...actualNodeIds] },
        });
      }
      const idempotencyKey = versionHash({
        baseStateVersion: topology.stateVersion,
        eventIds: relevantEvents.map((event) => event.id),
        result: raw,
        inspectedNodeIds,
        inspectedEdgeIds,
      });
      const patchToken = idempotencyKey.slice(7, 19);
      const operations = normalizeOperations(raw.patch?.operations, {
        topology,
        patchToken,
        evidenceNodeIds,
        runId: driverRun.runId,
        allowedSourceRefs: allowedRefs,
      });
      const inspected = new Set(inspectedNodeIds);
      const newNodeIds = new Set(operations.filter((operation) => operation.op === "addNode").map((operation) => operation.node.id));
      for (const operation of operations) {
        if (operation.op === "updateNode" && !inspected.has(operation.nodeId)) {
          throw new AppError("CURATOR_EVIDENCE_INVALID", `更新节点 ${operation.nodeId} 不在 Curator 实际读取路径中。`, { status: 422 });
        }
        if (operation.op === "addEdge") {
          for (const endpoint of [operation.edge.from, operation.edge.to]) {
            const endpointId = typeof endpoint === "object" ? endpoint.id : endpoint;
            if (endpoint?.kind === "group" ? !(topology.groups ?? []).some(group => group.id === endpointId) : !newNodeIds.has(endpointId) && !inspected.has(endpointId)) {
              throw new AppError("CURATOR_EVIDENCE_INVALID", `关系端点 ${endpointId} 不在 Curator 实际读取路径中。`, { status: 422 });
            }
          }
        }
      }
      const patch = {
        schemaVersion: "topology-patch-proposal.v1",
        id: `patch_${idempotencyKey.slice(7, 23)}`,
        idempotencyKey,
        baseStateVersion: topology.stateVersion,
        eventRange: { from: relevantEvents[0]?.id ?? null, to: relevantEvents.at(-1)?.id ?? null },
        reason: raw.reason,
        reasonEn: raw.reasonEn ?? raw.reason,
        sourceRefs: result.sourceRefs,
        evidenceNodeIds,
        curator: { adapter: this.adapter, mode: "real", model: driverRun.model },
        operations,
      };
      validateTopologyPatchProposal(patch, this.validationOptions(topology, allowedRefs));
      result.patch = patch;
    }
    validateTopologyCuratorResult(result, {
      allowedNodeIds: topology.nodes.map((item) => item.id),
      allowedGroupIds: (topology.groups ?? []).map(group => group.id),
      allowedEdgeIds: topology.edges.map((item) => item.id),
      allowedSourceRefs: allowedRefs,
    });
    return result;
  }

  validationOptions(topology, allowedSourceRefs) {
    return {
      baseStateVersion: topology.stateVersion,
      allowedNodeIds: topology.nodes.map((item) => item.id),
      allowedGroupIds: (topology.groups ?? []).map(group => group.id),
      allowedEdgeIds: topology.edges.map((item) => item.id),
      allowedSourceRefs,
    };
  }
}

export { normalizeOperations };
