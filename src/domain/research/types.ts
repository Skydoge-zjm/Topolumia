import type * as z from "zod/v4";
import type { DatabaseSync } from "node:sqlite";
import type { ResearchObjectRef } from "./object-ref.js";
import type { contentBlockInput, genericCoreSchema, paperCoreSchema, payloadSchemas, representationSchema, sourceRef } from "./content-blocks.js";
import type { groupCoreSchema, groupMemberSchema, primaryRelationsSchema } from "./groups.js";
import type { operationsSchema } from "./changes/operations.js";
import type { ExperimentRecordCollection } from "./experiment-records.js";
import type { recordInput, seriesInput } from "./workspace-input.js";
import type { TableGrid } from "./table-presentation.js";

/** JSON-facing application data is narrowed at its schema/transport boundary. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type LocalizedText = string | { zh: string; en: string };
export type ResearchActor = {
  id?: string; name?: string; actorId?: string; actorType?: string; type?: string;
  isAgent: boolean; isServerAdmin?: boolean; principalId?: string;
  projectId?: string; sessionId?: string | null; runtimeInstanceId?: string;
  user?: { id: string; displayName?: string; username?: string };
  permissions?: string[]; model?: string | null; agentName?: string;
  collectorGrant?: { id: string; blockId: string; projectId: string; userId: string; expiresAt: string; revoked: boolean };
  refreshCollectorAuthority?: () => ResearchActor | null;
};
export type AuthenticatedResearchActor = ResearchActor & {
  user: { id: string; displayName?: string; username?: string };
  permissions: string[];
};
export type ActorIdentity = {
  actorType: "agent" | "human"; actorId: string; principalId: string;
  projectId?: string; sessionId: string | null; name: string;
};
export type ResearchCore = z.infer<typeof genericCoreSchema> & Partial<Omit<z.infer<typeof paperCoreSchema>, "nodeName" | "tags">>;
export type SourceReference = z.infer<typeof sourceRef> & { delivery?: "agentReported" | "humanRecorded" };
export type Representation = z.infer<typeof representationSchema>;
export type ResearchObjectMetadata = {
  id: string; projectId?: string; revision: number; coreRevision: number;
  blockCollectionRevision: number; relationRevision: number;
  sourceRefs: SourceReference[]; status?: string; deleted?: boolean;
  createdAt?: string | null; updatedAt?: string; createdBy?: ActorIdentity; updatedBy?: ActorIdentity;
};
export type StoredNode = ResearchObjectMetadata & { kind: "paper" | "experiment" | "note"; core: ResearchCore };
export type StoredGroup = ResearchObjectMetadata & {
  kind?: never; core: z.infer<typeof groupCoreSchema>; members: z.infer<typeof groupMemberSchema>[];
  parentId: string | null; primaryRelations: z.infer<typeof primaryRelationsSchema>; membershipRevision: number;
};
export type StoredResearchObject = StoredNode | StoredGroup;
export type PayloadMap = { [K in keyof typeof payloadSchemas]: z.infer<(typeof payloadSchemas)[K]> };
export type ContentPayload = Partial<{
  format: "markdown" | "plain" | "html" | "pdf" | "tex" | "text" | "xlsx" | "csv";
  body: string; code: string; language: string; filename: string; text: string; translation: string;
  note: string; sourceRefIds: string[]; items: PayloadMap["metric"]["items"];
  columns: PayloadMap["table"]["columns"]; rows: PayloadMap["table"]["rows"];
  caption: string; sheetName: string; totalRows: number; truncated: boolean;
  sourceFormat: NonNullable<PayloadMap["table"]["sourceFormat"]>; alt: string; locator: string;
  title: string; sheet: string; range: string; url: string; label: string; kind: string;
  chartType: PayloadMap["chart"]["chartType"]; dataBlockId: string; config: Record<string, unknown>;
  provider: PayloadMap["experimentRecord"]["provider"]; runs: PayloadMap["experimentRecord"]["runs"];
  followSources: PayloadMap["experimentRecord"]["followSources"];
}>;
export type ValidatedBlock = Omit<z.infer<typeof contentBlockInput>, "payload" | "sourceRefs"> & {
  payload?: ContentPayload; sourceRefs: SourceReference[]; recordCollection?: ExperimentRecordCollection;
};
export type StoredBlock = ValidatedBlock & {
  id: string; owner: ResearchObjectRef; order: number; revision: number; lifecycle: "active" | "archived";
  createdAt?: string; updatedAt?: string; createdBy?: ActorIdentity; updatedBy?: ActorIdentity;
};
export type TopologyNode = {
  id: string; kind: string; code?: string; label: LocalizedText; summary: LocalizedText; status: string;
  position: { x: number; y: number }; tags?: string[]; sourceRef?: string | null; sourceRefs?: string[];
  candidate?: boolean; candidatePatchId?: string; exploration?: unknown;
  data: Record<string, unknown> & { researchRevision?: number; createdAt?: string | null; provenance?: string | { files?: string[] } };
};
export type TopologyEdge = {
  id: string; from: ResearchObjectRef; to: ResearchObjectRef; type: string; label: LocalizedText;
  status?: string; revision?: number; candidate?: boolean; candidatePatchId?: string; adapter?: string; exploration?: unknown;
  sourceRef?: string | null;
};
export type TopologyGroup = Pick<StoredGroup, "id" | "core" | "parentId" | "members" | "primaryRelations" | "revision" | "coreRevision" | "membershipRevision" | "relationRevision"> & { deleted?: boolean };
export type ResearchTopology = {
  schemaVersion: string; stateVersion: string; nodes: TopologyNode[]; edges: TopologyEdge[]; groups: TopologyGroup[];
  coordinateSystem: { width: number; height: number; direction: string; layout: string };
  focusNodeIds: string[]; sourceSnapshotVersion?: string | null; integration?: Record<string, string>;
  deletedNodeIds?: string[];
};
export type ResearchSource = {
  ref?: string; id?: string; label?: string; version?: string; hash?: string; excerpt?: string | null;
  locator?: string; relativePath?: string; mediaType?: string; capabilities?:{text?:boolean}; [field: string]: unknown;
};
export type SourceSnapshot = {
  stateVersion: string; observedAt?: string; schemaVersion?: string; git?: ResearchSource | null;
  files?: { files: ResearchSource[]; [key: string]: unknown } | null;
  sourceErrors?: { source: string; code: string; message: string }[];
};
type AllUnionKeys<T> = T extends T ? keyof T : never;
type WithOptionalUnionKeys<T, Keys extends PropertyKey> = T extends T ? T & Partial<Record<Exclude<Keys, keyof T>, never>> : never;
/** Absent variant fields remain readable as undefined; the op tag still narrows writes. */
export type ResearchOperation = WithOptionalUnionKeys<z.infer<typeof operationsSchema>[number], AllUnionKeys<z.infer<typeof operationsSchema>[number]>>;
export type ResearchOperationInput = WithOptionalUnionKeys<z.input<typeof operationsSchema>[number], AllUnionKeys<z.input<typeof operationsSchema>[number]>>;
export type ResearchView = { nodes: StoredNode[]; groups: StoredGroup[]; blocks: StoredBlock[]; topology: ResearchTopology; touched?: ResearchObjectRef[] };
export type ChangeSimulation = ResearchView & { touched: ResearchObjectRef[]; deleted: ResearchObjectRef[]; allocation: Record<string, string>; assetIds: string[]; allObjects: Map<string, StoredResearchObject> };
export type ReadReceipt = {
  id: string; projectId: string; principalId: string; researchSessionId: string | null;
  object: { kind: string; id: string }; version: string | number | null | undefined;
  disclosure: string; delivered: ReadDelivery; scope: "candidate" | "formal";
  candidateId?: string; candidateRevision?: number; owner?: ResearchObjectRef;
  contentVersion?: string; at: string;
};
export type ReadDelivery = {
  textRanges?: { start: number; end: number }[];
  tableRanges?: { start: number; end: number; sheet?: string | null; columns?: string[] }[];
  itemRanges?: { start: number; end: number }[];
  fields?: string[]; section?: string; scope?: string; nodeIds?: string[]; runIds?: string[]; linkIds?: string[];
  relationIds?: string[]; impactVersion?:string; parentId?:string|null;
};
export type StoredCandidate = {
  id: string; revision: number; status: "pending" | "deferred" | "applied" | "rejected";
  reason: string; idempotencyKey: string; fingerprint: string; requestKey: string; operations: ResearchOperation[];
  allocation: Record<string, string>; assetIds: string[]; provenance: ActorIdentity; actor: ResearchActor;
  evidenceReadIds?: string[]; evidenceReads: ReadReceipt[]; createdAt: string;
  reviews: { id: string; decision: string; reason: string; at: string; reviewer: ActorIdentity }[];
  revisions: { revision: number; operations: ResearchOperation[]; evidenceReads: ReadReceipt[] }[];
  lastEditFingerprint?: string; proposalEditFingerprint?: string; finalSnapshot?: ResearchView; updatedAt?: string; idempotent?: boolean;
  sourceTurnId?: string | null;
};
export type StoredAsset = {
  id: string; projectId: string; originalName: string; mediaType: string; sizeBytes: number; checksum: string;
  storageKey: string; owner: string; sessionId?: string | null; bindingState: string; processing: string;
  createdAt: string; createdBy?: string; role?: string; previewKey?: string; diagnostic?: string;
  sheetNames?: string[]; defaultSheet?: string; availableRows?: number; contentVersion?: string;
  compiled?: { state: string; pdf?: string | null; image?: string | null; error?: string | null } | null;
  recordManifests?: Record<string, { checksum: string; sourceIds: string[]; parserRevision?: number }>;
  tableSheetFacts?: Record<string, { checksum: string; rowCount: number }>;
};
export type ExportTarget =
  | { kind: "recordAttachment"; blockId: string; sha256: string; snapshotId?: string }
  | { kind: "asset"; assetId: string; expectedChecksum?: string }
  | { kind: "block"; owner: ResearchObjectRef; blockId: string; expectedRevision: number; representationId?: string; candidateId?: string };
export type StoredAssetJob = {
  id: string; type: "index" | "export" | "download"; status: string; assetId?: string; error?: string;
  target?: ExportTarget; variant?: string; checksum?: string; sizeBytes?: number; fingerprint?: string;
  block?: StoredBlock; owner?: string; actor?: ResearchActor;
};
export type ObjectVersion = { owner: ResearchObjectRef; object: StoredResearchObject; blocks: StoredBlock[]; previousRevision: number | null };
export type RepositoryCollections = {
  collections: ExperimentRecordCollection; nodes: StoredNode; groups: StoredGroup; blocks: StoredBlock;
  versions: StoredBlock | ObjectVersion; assets: StoredAsset; candidates: StoredCandidate; receipts: ReadReceipt;
  jobs: StoredAssetJob; uploads: { assetId: string; fingerprint: string }; settings: Record<string, unknown>;
};
export type NotebookMetadata = { id: string; revision: number; createdAt: string; updatedAt: string; author: { id: string; name?: string }; updatedBy: string };
export type ResearchRecord = Omit<z.infer<typeof recordInput>, "nodeIds"> & NotebookMetadata & {
  linkedNodes: { id: string; kind: string; label: LocalizedText; summary: LocalizedText; version: string; capturedAt: string }[];
  seriesId: string | null; occurrenceKey: string | null;
};
export type ResearchSeries = z.infer<typeof seriesInput> & NotebookMetadata;
export type NotebookDocuments = { record: ResearchRecord; series: ResearchSeries };
export type DatabaseOwner = { db: DatabaseSync };
export type TableHeaderContext = {rows:{index:number;values:(string|number|boolean|null)[]}[];merges:string[]};
export type IndexedTable = PayloadMap["table"] & { schemaVersion?:string; grid?: TableGrid; availableRows?: number; rangeOffset?: number; headerContext?: TableHeaderContext; sheetNames?: string[] };
