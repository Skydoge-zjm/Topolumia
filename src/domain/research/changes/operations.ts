import * as z from "zod/v4";
import { contentBlockInput, representationSchema, sourceRef } from "../content-blocks.js";
import { objectRefSchema, endpointVersionsSchema } from "../object-schemas.js";
import { groupCoreSchema, groupMembersSchema, membershipPatchSchema, primaryRelationsSchema } from "../groups.js";
const id = z.string().min(1).max(240), revision = z.number().int().positive();
const refs = z.array(sourceRef).max(80).optional();
const fromAsset = z.strictObject({ assetId: id, format: z.enum(["markdown", "plain"]) });
const blockFields = contentBlockInput.omit({ review: true }).extend({ review: z.enum(["unreviewed", "needs_review"]).optional() });
export const blockPatchSchema = z.strictObject({ ...Object.fromEntries(Object.entries(blockFields.shape).map(([key, schema]) => [key, (typeof schema.removeDefault === "function" ? schema.removeDefault() : schema).optional().nullable()])), payloadFromAsset: fromAsset.optional() });
export const operationSchemas = {
  addNode: z.strictObject({ op: z.literal("addNode"), clientRef: id, kind: z.string().max(80), core: z.record(z.string(), z.unknown()), sourceRefs: refs }),
  addGroup: z.strictObject({ op: z.literal("addGroup"), clientRef: id, core: groupCoreSchema, members: groupMembersSchema.default([]), parentId: id.nullable().default(null), expectedParentRevision: revision.optional(), sourceRefs: refs }),
  updateCore: z.strictObject({ op: z.literal("updateCore"), owner: objectRefSchema, expectedCoreRevision: revision, patch: z.record(z.string(), z.unknown()), sourceRefs: refs }),
  updateMembers: z.strictObject({ op: z.literal("updateMembers"), groupId: id, expectedMembershipRevision: revision, patch: membershipPatchSchema }),
  setGroupParent: z.strictObject({ op: z.literal("setGroupParent"), groupId: id, parentId: id.nullable(), expectedMembershipRevision: revision, expectedParentRevisions: z.record(z.string(), revision).default({}) }),
  setGroupPrimaryRelations: z.strictObject({ op: z.literal("setGroupPrimaryRelations"), groupId: id, expectedRelationRevision: revision, patch: primaryRelationsSchema }),
  addBlock: blockFields.extend({ op: z.literal("addBlock"), owner: objectRefSchema, clientRef: id, payloadFromAsset: fromAsset.optional(), insertAfterBlockId: id.optional(), expectedCollectionRevision: revision.optional() }),
  updateBlock: z.strictObject({ op: z.literal("updateBlock"), owner: objectRefSchema, blockId: id, expectedRevision: revision, patch: blockPatchSchema }),
  archiveBlock: z.strictObject({ op: z.literal("archiveBlock"), owner: objectRefSchema, blockId: id, expectedRevision: revision, reason: z.string().max(2000).optional() }),
  reorderBlocks: z.strictObject({ op: z.literal("reorderBlocks"), owner: objectRefSchema, expectedCollectionRevision: revision, blockIds: z.array(id).max(2000) }),
  bindAsset: z.strictObject({ op: z.literal("bindAsset"), owner: objectRefSchema, blockRef: id, expectedRevision: revision.optional(), representation: representationSchema, makePrimary: z.boolean().optional() }),
  unbindAsset: z.strictObject({ op: z.literal("unbindAsset"), owner: objectRefSchema, blockId: id, expectedRevision: revision, representationId: id }),
  addEdge: z.strictObject({ op: z.literal("addEdge"), clientRef: id, edge: z.strictObject({ from: objectRefSchema, to: objectRefSchema, type: z.string().min(1).max(120) }), label: z.string().max(240).optional(), expectedEndpointRevisions: endpointVersionsSchema.optional() }),
  updateEdge: z.strictObject({ op: z.literal("updateEdge"), edgeId: id, expectedRevision: revision, expectedEndpointRevisions: endpointVersionsSchema, patch: z.strictObject({ type: z.string().min(1).max(120).optional(), label: z.string().max(240).optional() }) }),
  deleteEdge: z.strictObject({ op: z.literal("deleteEdge"), edgeId: id, expectedRevision: revision, expectedEndpointRevisions: endpointVersionsSchema }),
  deleteNode: z.strictObject({ op: z.literal("deleteNode"), nodeId: id, expectedNodeRevision: revision, reason: z.string().max(2000).optional() }),
  deleteGroup: z.strictObject({ op: z.literal("deleteGroup"), groupId: id, expectedGroupRevision: revision, impactVersion: id, reason: z.string().trim().min(1).max(2000) }),
};
export const operationsSchema = z.array(z.discriminatedUnion("op", Object.values(operationSchemas))).min(1).max(800);
export const deleteNodeInput = operationSchemas.deleteNode.omit({ op: true, nodeId: true }).extend({ reason: z.string().trim().min(1, "请填写删除原因。").max(2000) });
export const createSchema = z.strictObject({ reason: z.string().min(1).max(2000), idempotencyKey: id, operations: operationsSchema, evidenceReadIds: z.array(id).max(80).optional() });
export const editSchema = z.strictObject({ candidateId: id, expectedRevision: revision, reason: z.string().min(1).max(2000), operations: operationsSchema, evidenceReadIds: z.array(id).max(80).optional() });
