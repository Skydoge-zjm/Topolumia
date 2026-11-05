import * as z from "zod/v4";

const id = z.string().min(1).max(240);
export const groupCoreSchema = z.strictObject({
  nodeName: z.string().trim().min(1).max(240), summary: z.string().max(4000).optional(),
  category: z.string().trim().max(80).optional(), tags: z.array(z.string().trim().min(1).max(80)).max(40).optional(),
});
export const groupMemberSchema = z.strictObject({ nodeId: id, role: z.string().trim().max(120).optional(), note: z.string().max(2000).optional() });
export const groupMembersSchema = z.array(groupMemberSchema).max(1000).refine(items => new Set(items.map(item => item.nodeId)).size === items.length, "Each node can occur only once in a group.");
export const membershipPatchSchema = z.strictObject({
  add: groupMembersSchema.optional(),
  update: z.array(z.strictObject({ nodeId: id, role: z.string().trim().max(120).nullable().optional(), note: z.string().max(2000).nullable().optional() })).max(1000).optional(),
  remove: z.array(id).max(1000).optional(), order: z.array(id).max(1000).optional(),
});
export const primaryRelationsSchema = z.strictObject({ incomingRelationId: id.nullable().optional(), outgoingRelationId: id.nullable().optional() });
export const MAX_GROUP_DEPTH = 8;
