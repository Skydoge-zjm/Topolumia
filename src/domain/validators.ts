import type { ResearchEvent } from "../services/research/research-state.js";
import type { CuratorPatch, CuratorOutput } from "../services/topology/curator-types.js";
import { objectRefSchema } from "./research/object-schemas.js";
import { AppError } from "../lib/errors.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: unknown, max = 2_000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function bilingual(value: unknown) {
  return isObject(value) && hasText(value.zh) && hasText(value.en);
}

function optionalTextArray(value: unknown, max = 80): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => hasText(item, 1_000));
}

type ValidationOptions = { allowedNodeIds?: string[]; allowedEdgeIds?: string[]; allowedGroupIds?: string[]; allowedSourceRefs?: string[]; baseStateVersion?: string };
const strings = (value: unknown): string[] => optionalTextArray(value, Number.MAX_SAFE_INTEGER) ? value : [];
const oneOf = (value: unknown, values: readonly string[]) => typeof value === "string" && values.includes(value);
export function validateResearchEvent(event: unknown, options: ValidationOptions = {}): asserts event is ResearchEvent {
  const issues = [];
  const allowedNodeIds = options.allowedNodeIds ? new Set(options.allowedNodeIds) : null;
  const allowedSourceRefs = options.allowedSourceRefs ? new Set(options.allowedSourceRefs) : null;
  if (!isObject(event)) {
    throw new AppError("INVALID_RESEARCH_EVENT", "研究事件必须是对象。", { status: 422 });
  }
  if (event.schemaVersion !== "research-event.v1") issues.push("schemaVersion must be research-event.v1");
  if (!hasText(event.id, 240)) issues.push("id is required");
  if (!oneOf(event.type, ["agentMessage", "toolCall", "toolResult", "humanResearchMove", "topologyChange"])) issues.push("type is invalid");
  if (!hasText(event.occurredAt, 80) || Number.isNaN(Date.parse(event.occurredAt))) issues.push("occurredAt must be an ISO date");
  if (!hasText(event.actor, 120)) issues.push("actor is required");
  if (event.sessionId !== null && event.sessionId !== undefined && !hasText(event.sessionId, 240)) issues.push("sessionId is invalid");
  if (!optionalTextArray(event.nodeIds, 80)) issues.push("nodeIds must be a string array");
  if (!optionalTextArray(event.sourceRefs, 80)) issues.push("sourceRefs must be a string array");
  if (!isObject(event.payload)) issues.push("payload must be an object");
  if (allowedNodeIds) {
    for (const id of strings(event.nodeIds)) if (!allowedNodeIds.has(id)) issues.push(`unknown node ${id}`);
  }
  if (allowedSourceRefs) {
    for (const ref of strings(event.sourceRefs)) if (!allowedSourceRefs.has(ref)) issues.push(`unknown source ref ${ref}`);
  }
  if (issues.length) {
    throw new AppError("INVALID_RESEARCH_EVENT", "研究事件未通过校验。", { status: 422, detail: { issues } });
  }

}

export function validateTopologyPatchProposal(proposal: unknown, options: ValidationOptions = {}): asserts proposal is CuratorPatch {
  const issues = [];
  const existingNodeIds = new Set(options.allowedNodeIds ?? []);
  const existingEdgeIds = new Set(options.allowedEdgeIds ?? []);
  const allowedSourceRefs = options.allowedSourceRefs ? new Set(options.allowedSourceRefs) : null;
  if (!isObject(proposal)) {
    throw new AppError("INVALID_TOPOLOGY_PATCH", "拓扑候选 patch 必须是对象。", { status: 422 });
  }
  if (proposal.schemaVersion !== "topology-patch-proposal.v1") issues.push("schemaVersion must be topology-patch-proposal.v1");
  if (!hasText(proposal.id, 240)) issues.push("id is required");
  if (!/^sha256:[a-f0-9]{64}$/.test(String(proposal.idempotencyKey ?? ""))) issues.push("idempotencyKey must be sha256");
  if (!/^sha256:[a-f0-9]{64}$/.test(String(proposal.baseStateVersion ?? ""))) issues.push("baseStateVersion must be sha256");
  if (options.baseStateVersion && proposal.baseStateVersion !== options.baseStateVersion) {
    throw new AppError("TOPOLOGY_VERSION_CONFLICT", "候选 patch 基于旧版正式拓扑，请重新整理。", {
      status: 409,
      detail: { expected: options.baseStateVersion, received: proposal.baseStateVersion },
    });
  }
  if (!isObject(proposal.eventRange)
    || ![null, "string"].includes(proposal.eventRange.from === null ? null : typeof proposal.eventRange.from)
    || ![null, "string"].includes(proposal.eventRange.to === null ? null : typeof proposal.eventRange.to)) {
    issues.push("eventRange.from/to are required");
  }
  if (!hasText(proposal.reason)) issues.push("reason is required");
  if (proposal.reasonEn !== undefined && !hasText(proposal.reasonEn)) issues.push("reasonEn is invalid");
  if (!optionalTextArray(proposal.sourceRefs, 80)) issues.push("sourceRefs must be a string array");
  if (!optionalTextArray(proposal.evidenceNodeIds, 80)) issues.push("evidenceNodeIds must be a string array");
  if (!isObject(proposal.curator) || !hasText(proposal.curator.adapter, 120)
    || !oneOf(proposal.curator.mode, ["mock", "real"]) || !hasText(proposal.curator.model, 120)) {
    issues.push("curator is invalid");
  }
  if (allowedSourceRefs) {
    for (const ref of strings(proposal.sourceRefs)) if (!allowedSourceRefs.has(ref)) issues.push(`unknown source ref ${ref}`);
  }
  for (const id of strings(proposal.evidenceNodeIds)) if (!existingNodeIds.has(id)) issues.push(`unknown evidence node ${id}`);

  if (!Array.isArray(proposal.operations) || proposal.operations.length > 24) {
    issues.push("operations must contain at most 24 items");
  }
  const operations: unknown[] = Array.isArray(proposal.operations) ? proposal.operations : [];
  const newNodeIds = new Set<string>();
  const newEdgeIds = new Set<string>();
  const deletedNodeIds = new Set<string>();
  for (const [index, operation] of operations.entries()) {
    if (!isObject(operation) || !oneOf(operation.op, ["addNode", "addEdge", "updateNode", "deleteNode", "noop"])) {
      issues.push(`operations[${index}] has an invalid op`);
      continue;
    }
    if (operation.op === "addNode") {
      const node = operation.node;
      if (!isObject(node) || !hasText(node.id, 240) || !hasText(node.kind, 120) || !hasText(node.code, 40)
        || !isObject(node.position) || !(typeof node.position.x === "number" && Number.isFinite(node.position.x)) || !(typeof node.position.y === "number" && Number.isFinite(node.position.y))
        || !bilingual(node.label) || !bilingual(node.summary) || node.status !== "candidate" || !isObject(node.data)) {
        issues.push(`operations[${index}].node is invalid`);
        continue;
      }
      if (existingNodeIds.has(node.id) || newNodeIds.has(node.id)) issues.push(`duplicate node id ${node.id}`);
      newNodeIds.add(node.id);
    }
    if (operation.op === "addEdge") {
      const edge = operation.edge;
      if (!isObject(edge) || !hasText(edge.id, 240) || !objectRefSchema.safeParse(edge.from).success || !objectRefSchema.safeParse(edge.to).success
        || !hasText(edge.type, 120) || !bilingual(edge.label) || edge.status !== "candidate") {
        issues.push(`operations[${index}].edge is invalid`);
        continue;
      }
      if (existingEdgeIds.has(edge.id) || newEdgeIds.has(edge.id)) issues.push(`duplicate edge id ${edge.id}`);
      newEdgeIds.add(edge.id);
    }
    if (operation.op === "updateNode") {
      if (!hasText(operation.nodeId, 240) || !existingNodeIds.has(String(operation.nodeId))) issues.push(`operations[${index}] updates an unknown node`);
      const patch = operation.patch;
      const keys = isObject(patch) ? Object.keys(patch) : [];
      if (!isObject(patch) || keys.length === 0 || keys.some((key) => !["label", "summary", "status"].includes(key))
        || (patch.label !== undefined && !bilingual(patch.label))
        || (patch.summary !== undefined && !bilingual(patch.summary))
        || (patch.status !== undefined && !hasText(patch.status, 80))) {
        issues.push(`operations[${index}].patch is invalid`);
      }
    }
    if (operation.op === "deleteNode") {
      if (!hasText(operation.nodeId, 240) || !existingNodeIds.has(String(operation.nodeId)) || deletedNodeIds.has(String(operation.nodeId))) issues.push(`operations[${index}] deletes a missing or duplicate node`);
      if (hasText(operation.nodeId, 240)) deletedNodeIds.add(operation.nodeId);
    }
  }
  const endpointIds = new Set([...existingNodeIds, ...newNodeIds]);
  const groups = new Set(options.allowedGroupIds ?? []);
  const knownEndpoint = (input: unknown) => { const parsed = objectRefSchema.safeParse(input); if (!parsed.success) return false; const ref = parsed.data; return ref.kind === "group" ? groups.has(ref.id) : endpointIds.has(ref.id) && !deletedNodeIds.has(ref.id); };
  for (const [index, operation] of operations.entries()) {
    if (!isObject(operation)) continue;
    if (operation.op === "updateNode" && deletedNodeIds.has(String(operation.nodeId))) issues.push(`operations[${index}] updates a node also scheduled for deletion`);
    if (operation.op !== "addEdge" || !isObject(operation.edge)) continue;
    if (!knownEndpoint(operation.edge.from)) issues.push(`operations[${index}] edge.from is unknown or being deleted`);
    if (!knownEndpoint(operation.edge.to)) issues.push(`operations[${index}] edge.to is unknown or being deleted`);
  }
  if (issues.length) {
    throw new AppError("INVALID_TOPOLOGY_PATCH", "TopologyPatchProposalV1 未通过校验。", {
      status: 422,
      detail: { issues },
    });
  }

}

export function validateTopologyCuratorResult(result: unknown, options: ValidationOptions = {}): asserts result is CuratorOutput {
  const issues = [];
  const allowedNodeIds = options.allowedNodeIds ? new Set(options.allowedNodeIds) : null;
  const allowedEdgeIds = options.allowedEdgeIds ? new Set(options.allowedEdgeIds) : null;
  const allowedSourceRefs = options.allowedSourceRefs ? new Set(options.allowedSourceRefs) : null;
  if (!isObject(result)) throw new AppError("INVALID_CURATOR_RESULT", "Topology Curator 输出必须是对象。", { status: 422 });
  if (result.schemaVersion !== "topology-curator-result.v1") issues.push("schemaVersion must be topology-curator-result.v1");
  if (!oneOf(result.disposition, ["proposal", "no_op", "needs_clarification"])) issues.push("disposition is invalid");
  if (!hasText(result.summary, 4_000)) issues.push("summary is required");
  if (!hasText(result.reason, 4_000)) issues.push("reason is required");
  const arrayLimits = {
    sourceRefs: 80,
    evidenceNodeIds: 80,
    inspectedNodeIds: 160,
    inspectedEdgeIds: 240,
    uncertainties: 24,
    questions: 24,
  };
  for (const [key, limit] of Object.entries(arrayLimits)) {
    if (!optionalTextArray(result[key], limit)) issues.push(`${key} must be a string array`);
  }
  if (allowedSourceRefs) for (const ref of strings(result.sourceRefs)) if (!allowedSourceRefs.has(ref)) issues.push(`unknown source ref ${ref}`);
  if (allowedNodeIds) {
    for (const id of strings(result.evidenceNodeIds)) if (!allowedNodeIds.has(id)) issues.push(`unknown evidence node ${id}`);
    for (const id of strings(result.inspectedNodeIds)) if (!allowedNodeIds.has(id)) issues.push(`unknown inspected node ${id}`);
  }
  if (allowedEdgeIds) for (const id of strings(result.inspectedEdgeIds)) if (!allowedEdgeIds.has(id)) issues.push(`unknown inspected edge ${id}`);
  const operations = isObject(result.patch) && Array.isArray(result.patch.operations) ? result.patch.operations : [];
  if (result.disposition === "proposal" && operations.length === 0) issues.push("proposal requires at least one operation");
  if (result.disposition !== "proposal" && operations.length > 0) issues.push("non-proposal result cannot contain operations");
  if (result.patch !== undefined && result.patch !== null && !isObject(result.patch)) issues.push("patch must be an object or null");
  if (isObject(result.patch)) {
    try {
      validateTopologyPatchProposal({
        schemaVersion: "topology-patch-proposal.v1", id: "curator-output",
        idempotencyKey: "sha256:" + "0".repeat(64), baseStateVersion: options.baseStateVersion ?? "sha256:" + "0".repeat(64),
        eventRange: { from: null, to: null }, reason: result.reason,
        sourceRefs: result.sourceRefs, evidenceNodeIds: result.evidenceNodeIds,
        curator: { adapter: "curator-output", mode: "real", model: "pending" }, ...result.patch,
      }, options);
    } catch { issues.push("patch operations are invalid"); }
  }
  if (issues.length) throw new AppError("INVALID_CURATOR_RESULT", "Topology Curator 输出未通过校验。", { status: 422, detail: { issues } });
  result.patch ??= null;

}
