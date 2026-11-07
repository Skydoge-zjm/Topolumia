import * as z from "zod/v4";

const id = z.string().min(1).max(500);
export const experimentProviders = ["wandb", "tensorboard", "mlflow"] as const;
export const runStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
export function normalizeRunStatus(
  value: unknown,
): z.infer<typeof runStatusSchema> {
  const name = String(value ?? "unknown").toLowerCase();
  return ["finished", "completed", "success", "succeeded"].includes(name)
    ? "succeeded"
    : ["failed", "error", "crashed"].includes(name)
      ? "failed"
      : ["killed", "cancelled", "canceled"].includes(name)
        ? "cancelled"
        : name === "running" || name === "queued"
          ? name
          : "unknown";
}
export const recordRunSchema = z.strictObject({
  sourceId: id,
  runId: id.optional(),
  label: z.string().trim().min(1).max(240),
  status: runStatusSchema.default("unknown"),
  assetIds: z.array(id).max(40).default([]),
  ref: id.optional(),
});
export const experimentRecordPayloadSchema = z.strictObject({
  provider: z.enum(experimentProviders),
  runs: z.array(recordRunSchema).min(1).max(200),
});
export const materialSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("block") }),
  z.strictObject({ kind: z.literal("asset"), assetId: id }),
  z.strictObject({
    kind: z.literal("assetRow"),
    assetId: id,
    sheet: z.string().max(240).optional(),
    rowIndex: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("row"),
    rowIndex: z.number().int().nonnegative(),
  }),
]);
export const materialLinkSchema = z.strictObject({
  runId: id,
  blockId: id,
  blockRevision: z.number().int().positive(),
  selection: materialSelectionSchema,
  label: z.string().max(240).optional(),
});
export const experimentPatchSchema = z.strictObject({
  addRuns: z
    .array(
      z.strictObject({
        label: z.string().trim().min(1).max(240),
        status: runStatusSchema.default("unknown"),
        note: z.string().max(2000).optional(),
      }),
    )
    .max(100)
    .optional(),
  updateRuns: z
    .array(
      z.strictObject({
        id,
        label: z.string().trim().min(1).max(240).optional(),
        status: runStatusSchema.optional(),
        note: z.string().max(2000).optional(),
      }),
    )
    .max(100)
    .optional(),
  removeRunIds: z.array(id).max(100).optional(),
  addLinks: z.array(materialLinkSchema).max(200).optional(),
  removeLinkIds: z.array(id).max(200).optional(),
});
export type MaterialSelection = z.infer<typeof materialSelectionSchema>;
export type ExperimentRun = {
  id: string;
  label: string;
  status: z.infer<typeof runStatusSchema>;
  note?: string;
  sources: {
    provider: (typeof experimentProviders)[number];
    sourceId: string;
  }[];
};
export type ExperimentMaterialLink = z.infer<typeof materialLinkSchema> & {
  id: string;
};
export type ExperimentPoint = {
  x: number;
  y: number;
  timestamp?: number | null;
};
export type ExperimentMetricSelection = {
  key: string;
  xKey: string;
  expectedContentVersion?: string;
};
export const experimentMetricId = (metric: { key: string; xKey: string }) => JSON.stringify([metric.key, metric.xKey]);
export type ExperimentSeries = {
  key: string;
  xKey: string;
  points: ExperimentPoint[];
  unit?: string;
};
export type ImportedExperimentRun = {
  sourceId: string;
  label: string;
  status: z.infer<typeof runStatusSchema>;
  originalStatus?: string;
  params?: Record<string, unknown>;
  series: ExperimentSeries[];
  metrics?: Record<string, number>;
};
