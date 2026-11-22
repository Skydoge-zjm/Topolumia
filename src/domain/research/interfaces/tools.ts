import * as z from "zod/v4";
import { createProposalSchema, reviseProposalSchema } from "../changes/proposals.js";
import { researchNodeKinds } from "../node-kinds.js";
import { contentBlockTypes } from "../content-blocks.js";
import { objectRefSchema } from "../object-schemas.js";
import { compactSchemaOutput } from "./schema-output.js";
import { experimentProviders } from "../experiment-records.js";
const id = z.string().min(1).max(240), rev = z.number().int().positive();
const budget = { locale: z.enum(["zh", "en"]).optional(), maxChars: z.number().int().min(2000).max(16000).optional() };
const page = { ...budget, limit: z.number().int().min(1).max(100).optional().describe("Optional page size, 1–100. Defaults to a small page; the character budget may return fewer items."), cursor: z.string().max(8192).optional() };
const selection = z.strictObject({ offset: z.number().int().nonnegative().optional(), length: z.number().int().positive().optional(), sheet: z.string().max(240).optional(), rowOffset: z.number().int().nonnegative().optional(), rowLimit: z.number().int().min(1).max(100).optional(), columnKeys: z.array(id).max(60).optional(), itemOffset: z.number().int().nonnegative().optional(), itemLimit: z.number().int().min(1).max(100).optional(), names: z.array(id).max(100).optional() });
const path = z.string().min(1).max(500).describe('Relative to the session TRANSFER directory, not project cwd. Use "out/figure.png" for upload or "in/source.pdf" for download. Never include .topolumia/transfers/<session>/ or an absolute path. Windows separators are normalized.');
export const transferSchema = z.discriminatedUnion("direction", [
  z.strictObject({ direction: z.literal("upload"), relativePath: path, idempotencyKey: id, originalName: z.string().max(240).optional(), mediaType: z.string().max(200).optional() }),
  z.strictObject({ direction: z.literal("download"), relativePath: path, idempotencyKey: id, target: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("asset"), assetId: id, expectedChecksum: id.optional() }), z.strictObject({ kind: z.literal("recordAttachment"), blockId: id, snapshotId: id.optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }), z.strictObject({ kind: z.literal("block"), owner: objectRefSchema, blockId: id, expectedRevision: rev, representationId: id.optional(), candidateId: id.optional() })]), variant: z.enum(["original", "compiledPdf", "previewImage", "xlsx", "tex"]) }),
]);
// Native tool clients enumerate top-level properties. Keep the two wire shapes
// exclusive while making their shared parameters discoverable in both clients.
const [upload, download] = transferSchema.options;
const transferDiscovery = upload.extend({
  direction: z.enum(["upload", "download"]),
  target: download.shape.target.optional(),
  variant: download.shape.variant.optional(),
}).meta({
  if: { properties: { direction: { const: "download" } } },
  then: { required: ["target", "variant"], properties: { originalName: false, mediaType: false } },
  else: { properties: { target: false, variant: false } },
});
export const definitions = {
  read_experiment: {
    description: "Read experiment records. For reproducible analysis, find the record block in read_nodes.recordCollections, call snapshot(nodeId,blockId) first, then follow its readHint through runs → metrics → series. Carry snapshotId in both series reads and copy the returned sourceRef into nodes[].sourceRefs. Use the exact metric and xKey from the metric directory. Materials links to configuration, tables and logs. Events reads preserved rich records. Compare gives a temporary same-metric comparison. Available discovers project records; inspect requires uploaded W&B/TensorBoard asset IDs.",
    schema: z.strictObject({ ...page, mode: z.enum(["available", "runs", "materials", "metrics", "series", "compare", "inspect", "snapshot", "events"]), hostId: id.optional(), query: z.string().max(240).optional(), unassigned: z.boolean().optional(), recordOffset: z.number().int().nonnegative().optional(), snapshotId: id.optional(), eventWatermark: z.number().int().positive().optional(), eventAssetId: id.optional(), eventSourceId: id.optional(), eventIndex: z.number().int().nonnegative().optional(), textOffset: z.number().int().nonnegative().optional(), textLength: z.number().int().min(1).max(12000).optional(), eventKind: z.enum(["config", "summary", "table", "distribution", "media", "file", "lifecycle", "extension"]).optional(), after: z.number().int().nonnegative().optional(), nodeIds: z.array(id).min(2).max(100).optional(), nodeId: id.optional(), runId: id.optional(), blockId: id.optional(), blockRevision: rev.optional(), candidateId: id.optional(), expectedRevision: rev.optional(), expectedContentVersion: id.optional(), provider: z.enum(experimentProviders).optional(), assetIds: z.array(id).min(1).max(40).optional(), metric: id.optional(), xKey: id.optional(), metricKeys: z.array(id).max(32).optional(), selections: z.array(z.strictObject({ nodeId: id, blockId: id.optional(), snapshotId: id.optional(), runId: id })).min(1).max(24).optional(), pointOffset: z.number().int().nonnegative().optional(), pointLimit: z.number().int().min(1).max(100).optional() }),
    kind: "experiment", defaultBudget: 6000, command: "experiment",
  },
  get_context: { description: "Read project counts and a brief. Supply a short query to include up to three matching objects or sources and their read hints. Follow a hint for exact evidence.", schema: z.strictObject({ ...budget, query: z.string().max(500).optional() }), kind: "context", defaultBudget: 3000, command: "context" },
  get_environment: { description: "Read the selected local/SSH research environment cached brief. Use your own tools to inspect and execute there.", schema: z.strictObject({ locale: budget.locale }), kind: "environment", defaultBudget: 4000, command: "environment" },
  search: { description: "Locate nodes, groups, blocks, assets or sources. For several names, pass queries (2–6 strings) to get ranked hits per name in one response. Use query for a single paginated search. Follow each hit’s read or transfer hint.", schema: z.strictObject({ ...page, query: z.string().trim().min(1).max(500).optional(), queries: z.array(z.string().trim().min(1).max(500)).min(2).max(6).optional(), target: z.enum(["all","nodes","groups","blocks","sources","assets"]).optional(), owner: objectRefSchema.optional(), kinds: z.array(id).max(12).optional(), status: id.optional() }), kind: "search", defaultBudget: 4000, command: "search" },
  read_nodes: { description: "Read 1–8 node overviews with type core, block directory and precise read hints. Not full block evidence.", schema: z.strictObject({ ...budget, cursor: page.cursor, nodeIds: z.array(id).min(1).max(8), candidateId: id.optional() }), kind: "nodes", defaultBudget: 6000, command: "node" },
  read_groups: { description: 'Read a group directory, one compact overview, or paginated members. Use mode=show,section=deleteImpact before proposing group deletion. No member bodies are loaded automatically.', schema:z.strictObject({...page,mode:z.enum(["list","show","members"]),groupId:id.optional(),scope:z.enum(["direct","recursive"]).optional(),section:z.enum(["overview","deleteImpact"]).optional(),query:z.string().max(500).optional(),candidateId:id.optional()}),kind:"groups",defaultBudget:6000,command:"group" },
  neighbors: { description: "Explore one-hop logical relations without loading neighbor content.", schema: z.strictObject({ ...page, object: objectRefSchema, scope:z.enum(["direct","groupBoundary"]).optional(),candidateId:id.optional(), direction: z.enum(["in","out","both"]).optional(), relationTypes: z.array(id).max(12).optional() }), kind: "neighbors", defaultBudget: 6000, command: "neighbors" },
  read_source: { description: "Read exact source text using ref and expectedVersion. For indexed files, copy data.sourceRef into a candidate’s sourceRefs and readReceipts[].id into evidenceReadIds. A pending coreRef needs candidateId. Unindexed PDFs/images require native reading.", schema: z.strictObject({ ...budget, ref: z.string().min(1).max(1000), candidateId: id.optional(), offset: z.number().int().nonnegative().optional(), expectedVersion: id.optional(), factPaths: z.array(z.string().max(300)).max(12).optional() }), kind: "source", defaultBudget: 6000, command: "source" },
  read_blocks: { description: "List blocks or read text, values or a manifest. A chart manifest identifies its data block. An image manifest exposes the authored alt text, caption and a ranged description read. Pin revisions and select ranges.", schema: z.strictObject({ ...page, mode: z.enum(["list","read"]), owner: objectRefSchema, blockId: id.optional(), view: z.enum(["text","values","manifest"]).optional(), titleQuery: z.string().max(240).optional(), types: z.array(id).max(contentBlockTypes.length).optional(), review: id.optional(), candidateId: id.optional(), revision: rev.optional(), expectedRevision: rev.optional(), expectedContentVersion: id.optional(), representationId: id.optional(), selection: selection.optional() }), kind: "blocks", defaultBudget: 6000, command: "block" },
  read_assets: { description: "Inspect an asset or read already indexed text/table ranges. Unindexed PDF stays unavailable; download for native reading.", schema: z.strictObject({ ...budget, assetId: id, view: z.enum(["metadata","text","values"]).optional(), selection: selection.optional(), expectedChecksum: id.optional(), expectedContentVersion: id.optional(), candidateId: id.optional() }), kind: "asset", defaultBudget: 6000, command: "asset" },
  transfer_asset: { description: 'Upload a staged file with {direction:"upload",relativePath:"out/file.txt",idempotencyKey:"upload-file"}. Use the returned data.assetId for read_assets and a candidate block representation. Download with direction:"download", relativePath:"in/file.txt", target, variant and idempotencyKey. Poll pending transfers with identical arguments.', schema: transferSchema, kind: "transfer", defaultBudget: 2000, command: "asset", transfer: true },
  get_schema: { description: `Look up a format. Use view="example" for a short valid input, or view="schema" for full field constraints. Omit name to list available names. nodeCore: ${researchNodeKinds.join(", ")}. contentBlock: ${contentBlockTypes.join(", ")}. proposal: create, edit.`, schema: z.strictObject({ topic: z.enum(["nodeCore","groupCore","contentBlock","proposal"]), name: id.optional(), view: z.enum(["example","schema"]).optional(), locale: budget.locale }), kind: "schema", defaultBudget: 16000, command: "schema" },
  read_candidates: { description: "List candidates or read a node/block directory and evidence. Returned node IDs are pending until accepted. Read exact candidate content via read_nodes/read_blocks with candidateId.", schema: z.strictObject({ ...page, mode: z.enum(["list","show"]), candidateId: id.optional(), status: id.optional(), idempotencyKey: id.optional(), section: z.enum(["summary","nodes","groups","evidence"]).optional() }), kind: "candidates", defaultBudget: 6000, command: "candidate" },
  create_candidate: { description: 'Propose research for human review. Use reason and nodes:[{kind:"note",core:{nodeName:"Analysis"},blocks:[{type:"richText",title:"Findings",payload:{format:"markdown",body:"…"}}]}]. Omit block role unless explicitly selecting a richText primary body. Metric blocks use payload:{items:[{name,value}]} and omit role. Pin returned readReceipts[].id in top-level evidenceReadIds. Cite material on nodes or blocks with sourceRefs:[{kind:"file",value:"file:…"}] or {kind:"experimentSnapshot",value:snapshot.id}. Attach an uploaded original via block representations:[{kind:"asset",role:"source",assetId}]. Paper core uses paperTitle, authors, year, venue, field, identifiers:{doi,arxiv,other}, urls, abstract, tags and nodeName. Use nodeChanges/groupChanges with observed revisions for existing objects. Groups accept core, members:[{nodeId,role?}] and blocks. Relations use typed from/to endpoints. IDs come from receipts.', schema: createProposalSchema, kind: "candidateReceipt", defaultBudget: 4000, command: "candidate", write: true },
  edit_candidate: { description: 'Incrementally revise your pending candidate. Example: {candidateId:"returned ID",expectedRevision:1,nodeChanges:[{nodeId:"returned node ID",addBlocks:[{title:"Limits",type:"richText",payload:{format:"markdown",body:"Source limitations"}}]}]}. Omitted content stays intact. Use IDs from receipt or candidate reads. Only candidate expectedRevision is needed for content already in that candidate; first edits of formal content also require its observed revision.', schema: reviseProposalSchema, kind: "candidateReceipt", defaultBudget: 4000, command: "candidate", write: true },
};
export type ResearchToolName = keyof typeof definitions;
export type ResearchToolInputs = { [K in ResearchToolName]: z.infer<(typeof definitions)[K]["schema"]> };
type ConditionInput = {mode?:string;nodeId?:string;nodeIds?:unknown[];blockId?:string;snapshotId?:string;provider?:string;assetIds?:string[];selections?:unknown[];runId?:string;metric?:string;xKey?:string;owner?:{kind:string;id:string};object?:{kind:string;id:string};target?:unknown;groupId?:string;scope?:string;section?:string;view?:string;candidateId?:string;status?:string;cursor?:string;limit?:number;selection?:Record<string,unknown>;[key:string]:unknown};
function conditions(name:string, input:ConditionInput) {
  const reject = (message:string) => { throw Object.assign(new Error(message), { code: "INPUT_INVALID", status: 422 }); };
  if (name === "read_experiment") {
    if (["snapshot", "events"].includes(input.mode??"") && !input.blockId && !input.snapshotId) reject("record blockId is required");
    if (input.mode === "inspect" && (!input.provider || !input.assetIds)) reject("inspect takes provider and uploaded assetIds. For an existing record block, use mode=snapshot or runs with its nodeId and blockId.");
    if (input.mode === "compare" && Boolean(input.selections) === Boolean(input.nodeIds)) reject("compare requires either selections or nodeIds");
    if (["runs", "materials", "metrics", "series", "snapshot", "events"].includes(input.mode??"") && !input.nodeId && !input.snapshotId) reject("nodeId or snapshotId is required");
    if (input.mode === "metrics" && !input.runId) reject("Use mode=runs with the same record block or snapshot. Copy a returned run's readHint to request its metrics.");
    if (input.mode === "series" && (!input.runId || !input.metric)) reject("series requires runId and exact metric name");
    if (input.xKey !== undefined && input.mode !== "series") reject("xKey requires series mode");
  }
  if (name === "search") {
    if (Boolean(input.query) === Boolean(input.queries)) reject("Supply one query or a batch of queries.");
    if (input.queries && (input.cursor || (input.limit ?? 0) > 5)) reject("Batch lookup accepts up to five hits per query. Continue a single query for further pages.");
    if (input.owner && input.target !== "blocks") reject("owner requires target=blocks");
  }
  if (name === "read_groups") {
    if (input.mode !== "list" && !input.groupId) reject("Find the group with mode=list and query, then pass its groupId.");
    if (input.mode === "list" && (input.groupId || input.scope || input.section)) reject("List takes query and pagination. For a known groupId use show or members.");
    if (input.mode !== "members" && input.scope) reject("Omit scope for a group overview. To read roles, use mode=members with groupId and optional scope.");
    if (input.mode !== "show" && input.section) reject("Omit section for member lists. Use mode=show with section=deleteImpact for a deletion review.");
  }
  if(name==="neighbors"&&input.scope==="groupBoundary"&&input.object?.kind!=="group")reject("groupBoundary requires a group");
  if (name === "read_blocks") {
    if (input.mode === "list" && ["blockId","view","selection","representationId","revision","expectedRevision","expectedContentVersion"].some(k => input[k] !== undefined)) reject("list excludes block content parameters");
    if (input.mode === "read" && (!input.blockId || !input.view || ["cursor","limit","titleQuery","types","review"].some(k => input[k] !== undefined))) reject("read requires blockId/view and excludes list parameters");
    if (input.view === "manifest" && input.selection) reject("manifest excludes selection");
  }
  if (name === "read_candidates") {
    if (input.mode === "list" && (input.candidateId || input.section)) reject("Use show with a candidateId to read its sections.");
    if (input.mode === "show" && (!input.candidateId || input.status || input.idempotencyKey))
      reject("Show requires candidateId; status and idempotencyKey filter the candidate list.");
    if (input.mode === "show" && (!input.section || input.section === "summary") && (input.cursor || input.limit))
      reject("The candidate summary is a single item. Use section=nodes, groups or evidence for pagination.");
  }
  if (["read_blocks","read_assets"].includes(name) && input.selection) {
    const keys = Object.keys(input.selection);
    const allowed = input.view === "text" ? ["offset","length"] : input.view === "values" ? ["sheet","rowOffset","rowLimit","columnKeys","itemOffset","itemLimit","names"] : [];
    if (keys.some(k => !allowed.includes(k))) reject("Selection does not match view");
    if (keys.some(k => k.startsWith("row") || ["sheet","columnKeys"].includes(k)) && keys.some(k => k.startsWith("item") || k === "names")) reject("Table and metric selectors cannot mix");
  }
  return input;
}
type ToolEntry<K extends ResearchToolName> = (typeof definitions)[K] & { write?:boolean;transfer?:boolean;validate(input:unknown):ResearchToolInputs[K];command(input:ResearchToolInputs[K]):{args:string[];input:ResearchToolInputs[K]} };
export const researchTools = Object.fromEntries(Object.entries(definitions).map(([name, tool]) => [name, { ...tool, validate(input:unknown) { const parsed=tool.schema.parse(input);conditions(name,parsed);return parsed; }, command(input:unknown) { return { args: ["--tool", name, "--input", "-"], input }; } }])) as {[K in ResearchToolName]:ToolEntry<K>};
export const isResearchToolName=(name:string):name is ResearchToolName=>Object.hasOwn(researchTools,name);
export const toolPermission = (name:string, input:{direction?:string} = {}) => name === "transfer_asset" ? input.direction === "upload" ? "research.proposeChange" : "research.view" : (isResearchToolName(name)&&researchTools[name].write) ? "research.proposeChange" : "research.view";
export const isWrite = (name:string, input:{direction?:string} = {}) => Boolean((isResearchToolName(name)&&researchTools[name].write) || name === "transfer_asset" && input.direction === "upload");
export function toolDefinitions(permissions = ["research.view","research.proposeChange"]) {
  return Object.entries(researchTools).filter(([name]) => permissions.includes(toolPermission(name))).map(([name, tool]) => {
    const schema = compactSchemaOutput(z.toJSONSchema(name === "transfer_asset" ? transferDiscovery : tool.schema, { reused: "ref" })); delete schema.$schema; schema.type = "object";
    return { name, description: tool.description, inputSchema: schema, annotations: { readOnlyHint: !tool.write && !tool.transfer, destructiveHint: false, idempotentHint: name === "edit_candidate" || !tool.write, openWorldHint: false } };
  });
}
