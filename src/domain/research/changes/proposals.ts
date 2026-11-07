import * as z from "zod/v4";
import { contentBlockInput, sourceRef, paperCoreSchema, genericCoreSchema } from "../content-blocks.js";
import { researchNodeKinds } from "../node-kinds.js";
import { groupCoreSchema, groupMembersSchema, membershipPatchSchema, primaryRelationsSchema } from "../groups.js";
import { objectRefSchema, endpointVersionsSchema } from "../object-schemas.js";
import { experimentPatchSchema } from "../experiment-records.js";

const id = z.string().min(1).max(240);
const revision = z.number().int().positive();
const sourceRefs = z.array(sourceRef).max(80);
export const payloadFromAsset = z.strictObject({
  assetId: id, format: z.enum(["markdown", "plain"]),
}).describe("Use an uploaded UTF-8 file instead of repeating a long richText payload; exclusive with payload.");
export const proposalBlock = contentBlockInput.omit({ review: true }).extend({
  sourceRefs: z.array(sourceRef).max(80).default([]).describe('Source kinds: url, doi, arxiv, file, page, figure, table, section, range. A local/uploaded PDF uses kind="file", never "document". Locator uses page as a string (e.g. "3, 7"), not pages.'),
  review: z.enum(["unreviewed", "needs_review"]).optional(),
  payload: z.unknown().optional().describe('richText: {format:"markdown",body:"…"}; metric: {items:[{name:"…",value:0,unit:"…",condition:"…"}]}; table: {columns:[{key:"c1",label:"…"}],rows:[{c1:0}]}; link: {url:"https://…"}. For other types use get_schema(topic="contentBlock",name=type).'),
  payloadFromAsset: payloadFromAsset.optional(),
});
const blocks = z.array(proposalBlock).max(80);
const nodeFields = { blocks: blocks.optional(), sourceRefs: sourceRefs.optional() };
export const proposalNode = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("paper"), core: paperCoreSchema.describe('Bibliographic fields only. Put arXiv/DOI in identifiers:{arxiv:"2502.14321v3",doi:"…"}; year is numeric. Extra dates, paper type and reading details belong in titled blocks, not invented core fields.'), ...nodeFields }),
  z.strictObject({ kind: z.enum(researchNodeKinds.filter(k => k !== "paper")), core: genericCoreSchema, ...nodeFields }),
]);
const blockPatch = z.strictObject(Object.fromEntries(Object.entries(proposalBlock.shape).map(([key, schema]) => [
  key, (typeof schema.removeDefault === "function" ? schema.removeDefault() : schema).optional().nullable(),
]))).describe("Only supplied fields change. payload, representations and sourceRefs replace that field; null removes an optional field.");
export const nodeChange = z.strictObject({
  nodeId: id.describe("An existing formal node ID, or an ID returned by this candidate's receipt. No temporary reference syntax."),
  expectedCoreRevision: revision.optional(),
  expectedCollectionRevision: revision.optional(),
  corePatch: z.record(z.string(), z.unknown()).optional().describe("Merge supplied core fields; null removes an optional field. First change to formal core requires expectedCoreRevision and a current core read."),
  expectedExperimentRevision: revision.optional(),
  experimentPatch: experimentPatchSchema.optional().describe("Edit an experiment's run registry or link a versioned block/file/table row to an existing run. Read the experiment first; agent changes remain candidates."),
  sourceRefs: sourceRefs.optional().describe("Replace node sources; omitted sources stay unchanged."),
  addBlocks: blocks.optional(),
  updateBlocks: z.array(z.strictObject({ blockId: id, expectedRevision: revision.optional(), patch: blockPatch })).max(80).optional(),
  archiveBlocks: z.array(z.strictObject({ blockId: id, expectedRevision: revision.optional() })).max(80).optional(),
  blockOrder: z.array(id).max(2000).optional().describe("All active block IDs in desired order; requires expectedCollectionRevision for a formal node."),
});
export const proposalGroup = z.strictObject({
  core: groupCoreSchema, members: groupMembersSchema.optional(), parentId: id.nullable().optional(),
  expectedParentRevision: revision.optional(), ...nodeFields,
});
export const groupChange = nodeChange.omit({ nodeId: true, experimentPatch: true, expectedExperimentRevision: true }).extend({
  groupId: id, expectedMembershipRevision: revision.optional(), membersPatch: membershipPatchSchema.optional(),
  parentId: id.nullable().optional(), expectedParentRevisions: z.record(z.string(), revision).optional(),
  primaryRelations: primaryRelationsSchema.optional(), expectedRelationRevision: revision.optional(),
});
const relation = z.strictObject({
  from: objectRefSchema, to: objectRefSchema, type: z.string().min(1).max(120), label: z.string().max(240).optional(),
  expectedEndpointRevisions: endpointVersionsSchema.optional(),
}).describe("Use returned node/group references. Formal endpoints require their observed aggregate revisions.");
const relationChange = z.strictObject({
  relationId: id, expectedRevision: revision.optional(), expectedEndpointRevisions: endpointVersionsSchema.optional(),
  remove: z.boolean().optional(), patch: z.strictObject({type:z.string().min(1).max(120).optional(), label:z.string().max(240).optional()}).optional(),
}).refine(value => Boolean(value.remove) !== Boolean(value.patch), "Choose a patch or remove=true.");
const edits = {
  nodes: z.array(proposalNode).max(8).optional().describe("Create nodes with nested blocks. Ordinary paper saving needs only this field and reason."),
  nodeChanges: z.array(nodeChange).max(8).optional(),
  groups: z.array(proposalGroup).max(8).optional(), groupChanges: z.array(groupChange).max(8).optional(),
  deleteGroups: z.array(z.strictObject({groupId:id, expectedGroupRevision:revision, impactVersion:id, reason:z.string().min(1).max(2000)})).max(20).optional(),
  relationChanges: z.array(relationChange).max(40).optional(),
  relations: z.array(relation).max(40).optional(),
  deleteNodes: z.array(z.strictObject({ nodeId: id, expectedNodeRevision: revision.optional() })).max(20).optional(),
  evidenceReadIds: z.array(id).max(80).optional(),
};
const hasChanges = value => ["nodes", "nodeChanges", "groups", "groupChanges", "relations", "relationChanges", "deleteNodes", "deleteGroups"].some(key => value[key]?.length);
export const createProposalSchema = z.strictObject({
  reason: z.string().min(1).max(2000),
  idempotencyKey: id.optional().describe("Optional retry key. The execution layer generates one when omitted and returns it; retry with the returned key after an uncertain result."),
  ...edits,
}).refine(hasChanges, "Supply nodes, nodeChanges, relations or deleteNodes.");
export const reviseProposalSchema = z.strictObject({
  candidateId: id, expectedRevision: revision,
  reason: z.string().min(1).max(2000).optional(),
  ...edits,
}).refine(hasChanges, "Supply an incremental change; omitted content is preserved.");

export const proposalExamples = {
  create: {
    reason: "Save the paper reading for review",
    nodes: [{ kind: "paper", core: { nodeName: "Example", paperTitle: "An Example Research Paper" }, blocks: [
      { title: "Method", type: "richText", payload: { format: "markdown", body: "Source-grounded method explanation." }, sourceRefs: [{ kind: "section", value: "Method", locator: { page: "3" } }] },
    ] }],
  },
  edit: {
    candidateId: "patch:returned-id", expectedRevision: 1,
    nodeChanges: [{ nodeId: "node:returned-id", addBlocks: [{ title: "Limitations", type: "richText", payload: { format: "markdown", body: "Limitations supported by the source." } }] }],
  },
};
