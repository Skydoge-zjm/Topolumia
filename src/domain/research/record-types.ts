import type {
  ExperimentRecordCollection,
  ExperimentRun,
  ImportedExperimentRun,
} from "./experiment-records.js";
import type {
  PayloadMap,
  ResearchActor,
  StoredAsset,
  StoredBlock,
  StoredNode,
  ResearchView,
  JsonObject,
} from "./types.js";

export type RecordProvider = PayloadMap["experimentRecord"]["provider"];
export type RecordNumber =
  number | { dtype: "int64" | "uint64" | "float32" | "float64"; value: string };
export type RecordExactPoint = {
  x: RecordNumber;
  y: RecordNumber;
  timestamp?: number | null;
};
export type RecordPoint = {
  x: number;
  y: number;
  timestamp?: number | null;
  originalX?: RecordNumber;
  originalY?: RecordNumber;
  nonFinite?: boolean;
};
export type RecordDependencyWarning = {
  key?: string;
  missingDependencies?: string[];
};
export type RecordNativeSemantics = {
  warnings?: RecordDependencyWarning[];
  [key: string]: unknown;
};
export type IndexedRecordRun = Omit<ImportedExperimentRun, "series"> & {
  events?: RecordRichEvent[];
  nativeSemantics?: RecordNativeSemantics;
  series: { key: string; xKey: string; unit?: string; points: RecordPoint[] }[];
};
export type RecordIndex = {
  schemaVersion: string;
  provider: RecordProvider;
  assetId: string;
  checksum: string;
  contentVersion: string;
  runs: IndexedRecordRun[];
};
export type RecordManifest = Omit<RecordIndex, "runs"> & {
  runs: (Omit<IndexedRecordRun, "series" | "events"> & {
    series: { key: string; xKey: string; unit?: string; pointCount: number }[];
  })[];
};
export type RecordAsset = StoredAsset & { file: string };
export type RecordBlock = StoredBlock & {
  type: "experimentRecord";
  payload: PayloadMap["experimentRecord"];
  recordCollection: ExperimentRecordCollection;
};
export function isRecordBlock<
  T extends Pick<StoredBlock, "type" | "payload" | "recordCollection">,
>(
  block: T,
): block is T & {
  type: "experimentRecord";
  payload: PayloadMap["experimentRecord"];
  recordCollection: ExperimentRecordCollection;
} {
  return (
    block.type === "experimentRecord" &&
    Boolean(block.payload && block.recordCollection)
  );
}
export type RecordStorageTarget = Omit<
  StoredBlock,
  "owner" | "type" | "payload"
> & {
  type: "experimentRecord";
  payload: PayloadMap["experimentRecord"];
  owner: StoredBlock["owner"] | { kind: "project"; id: string };
};
export type ProjectRecordSource = {
  id: string;
  userId: string;
  hostId: string;
  hostLabel: string;
  provider: RecordProvider;
  directory: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  mode?: "import" | "collector";
  contentVersion?: string;
  grantId?: string;
};
export type ProjectRunBinding = {
  sourceId: string;
  runId: string;
  watermark: number;
};
export type LiveRecordRun = Omit<ExperimentRun, "sources"> & {
  sources: {
    provider: RecordProvider | "custom";
    sourceId: string;
    streamId?: string;
    writerId?: string;
    generation?: string;
  }[];
  blockId?: string;
  projectSource?: { sourceId: string; runId: string };
  directory?: string;
  firstWatermark?: number;
  lastWatermark?: number;
  updatedAt?: string;
  hostLabel?: string;
  metadataFields?: ("label" | "status" | "note")[];
};
export type RecordSource = {
  blockId: string;
  blockRevision?: number;
  assetId?: string;
  provider?: RecordProvider | "collector";
  sourceId?: string;
  contentVersion?: string;
  sampledAtSource?: boolean;
  observedAt?: string;
  ref?: string;
  watermark?: number;
  runId?: string;
};
export type RecordSegment = {
  assetId?: string;
  asset?: RecordAsset;
  provider?: RecordProvider;
  sourceId?: string;
  points?: RecordPoint[];
  live?: boolean;
  blockId?: string;
  runId?: string;
  watermark?: number;
};
export type RecordLine = {
  key: string;
  xKey: string;
  unit?: string;
  pointCount: number;
  segments: RecordSegment[];
  sources: RecordSource[];
};
export type RecordSelection = {
  nodeId: string;
  blockId?: string;
  runId?: string;
  snapshotId?: string;
};
export type RecordPointRange = {
  offset?: number;
  limit?: number;
  maxPoints?: number;
};
export type RecordWorkerInput =
  | { action: "close" }
  | { action: "ensure"; provider: RecordProvider; asset: RecordAsset }
  | {
      action: "table";
      asset: RecordAsset;
      selection?: {
        sheet?: string;
        rowOffset?: number;
        rowLimit?: number;
        columnKeys?: string[];
      };
    }
  | {
      action: "select";
      queries: (RecordPointRange & {
        key: string;
        xKey: string;
        segments: RecordSegment[];
      })[];
    };
export type RecordWorkerRequest = RecordWorkerInput & {
  id: number;
  root: string;
  pythonCommand: string;
};
export type RecordWorkerError = {
  message: string;
  code?: string;
  status?: number;
};
export type RecordImporterOptions = { pythonCommand?: string | (() => string) };
export type RecordReaderContext = {
  assets: {
    root: string;
    assert: (id: string, actor: ResearchActor) => StoredAsset;
    file: (asset: StoredAsset) => string;
  };
};
export type RecordReadScope = {
  views?: Map<string, { node: StoredNode; blocks: StoredBlock[] }>;
  metricKeys?: string[];
  indices?: Map<string, Promise<RecordManifest>>;
  entries?: Map<
    string,
    Map<
      string,
      {
        block: RecordBlock;
        entry: PayloadMap["experimentRecord"]["runs"][number];
      }[]
    >
  >;
  candidateSnapshot?: ResearchView;
};
export type RecordSnapshot = {
  id: string;
  blockId: string;
  nodeId: string;
  watermark: number;
  blockRevision: number;
  createdAt: string;
  block: RecordBlock;
  node: StoredNode;
  recordCollection: ExperimentRecordCollection;
  runs: LiveRecordRun[];
  sourceBindings?: ProjectRunBinding[];
  [key: string]: unknown;
};
export type RecordRichEvent = {
  seq?: number;
  sourceRunId?: string;
  kind: string;
  key?: string;
  data?: JsonObject;
  [key: string]: unknown;
};
export type RecordEventItem = {
  watermark: number;
  runId: string;
  event: RecordRichEvent;
  totalChars?: number;
  readHint?: Record<string, unknown>;
  order?: number;
  eventAssetId?: string;
  eventSourceId?: string;
  eventIndex?: number;
  attachments?: Record<string, unknown>[];
};
export type RecordReadInput = {
  mode:
    | "available"
    | "snapshot"
    | "events"
    | "inspect"
    | "compare"
    | "runs"
    | "materials"
    | "metrics"
    | "series";
  nodeId?: string;
  nodeIds?: string[];
  blockId?: string;
  blockRevision?: number;
  runId?: string;
  snapshotId?: string;
  candidateId?: string;
  expectedRevision?: number;
  expectedContentVersion?: string;
  metric?: string;
  xKey?: string;
  metricKeys?: string[];
  provider?: RecordProvider;
  assetIds?: string[];
  pointOffset?: number;
  pointLimit?: number;
  eventWatermark?: number;
  eventAssetId?: string;
  eventSourceId?: string;
  eventIndex?: number;
  textOffset?: number;
  textLength?: number;
  eventKind?: string;
  after?: number;
  recordOffset?: number;
  limit?: number;
  cursor?: string;
  locale?: "en" | "zh";
  maxChars?: number;
  hostId?: string;
  query?: string;
  unassigned?: boolean;
  selections?: (RecordSelection & { runId: string })[];
};
export type RecordPlotInput = Omit<RecordReadInput, "mode"> & {
  maxPoints?: number;
};
export type RecordTableInput = RecordSelection & {
  runId: string;
  candidateId?: string;
  metrics: { key: string; xKey: string; expectedContentVersion?: string }[];
  pointOffset?: number;
  pointLimit?: number;
};
