import * as z from "zod/v4";

export const RECORD_INGESTION_VERSION = 1;
const id = z.string().min(1).max(500);
/** Tagged numbers retain int64 and non-finite/native floating point semantics. */
export const recordNumberSchema = z.union([
  z.number().finite(),
  z
    .strictObject({
      dtype: z.enum(["int64", "uint64", "float32", "float64"]),
      value: z
        .string()
        .max(100)
        .regex(/^(?:-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|NaN|[+-]?Infinity)$/),
    })
    .refine((number) => {
      if (number.dtype === "int64" || number.dtype === "uint64") {
        if (!/^-?\d+$/.test(number.value)) return false;
        const value = BigInt(number.value);
        return number.dtype === "int64"
          ? value >= -(2n ** 63n) && value < 2n ** 63n
          : value >= 0n && value < 2n ** 64n;
      }
      return (
        ["NaN", "Infinity", "-Infinity", "+Infinity"].includes(number.value) ||
        Number.isFinite(Number(number.value))
      );
    }, "Number must match its declared dtype"),
]);
const data = z.record(z.string().max(500), z.json());
const base = {
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceRunId: id,
  timestamp: z.number().finite().optional(),
};
export const recordEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...base,
    kind: z.literal("run"),
    label: z.string().min(1).max(240),
    status: z
      .enum([
        "queued",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "unknown",
      ])
      .default("unknown"),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("scalar"),
    key: id,
    xKey: id.default("step"),
    x: recordNumberSchema,
    value: recordNumberSchema,
  }),
  z.strictObject({
    ...base,
    kind: z.literal("metric"),
    key: id,
    xKey: id,
    unit: z.string().max(80).optional(),
  }),
  ...(
    [
      "config",
      "summary",
      "table",
      "distribution",
      "media",
      "file",
      "lifecycle",
      "extension",
    ] as const
  ).map((kind) =>
    z.strictObject({
      ...base,
      kind: z.literal(kind),
      key: id.optional(),
      data,
    }),
  ),
]);
export const recordBatchSchema = z.strictObject({
  version: z.literal(RECORD_INGESTION_VERSION),
  provider: z.enum(["wandb", "tensorboard", "mlflow", "custom"]),
  streamId: id,
  writerId: id,
  generation: id,
  sourceInfo: z
    .strictObject({
      adapterVersion: z.string().max(100),
      sdkVersion: z.string().max(100),
      cursorEncoding: z.string().max(100).optional(),
    })
    .optional(),
  events: z.array(recordEventSchema).min(1).max(128),
});
export type RecordBatch = z.infer<typeof recordBatchSchema>;
export type RecordEvent = z.infer<typeof recordEventSchema>;
export function recordNumber(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : value && typeof value === "object" && "value" in value
        ? Number(value.value)
        : NaN;
  return Number.isFinite(n) ? n : null;
}
export const recordIngestionCapabilities = {
  version: RECORD_INGESTION_VERSION,
  maxBatchBytes: 2_097_152,
  maxBatchEvents: 128,
  maxAttachmentBytes: 67_108_864,
  encoding: ["json", "gzip"],
  numbers: ["number", "int64", "uint64", "float32", "float64"],
  kinds: [
    "run",
    "scalar",
    "metric",
    "config",
    "summary",
    "table",
    "distribution",
    "media",
    "file",
    "lifecycle",
    "extension",
  ],
  rendered: [
    "scalar",
    "config",
    "summary",
    "table-preview",
    "distribution-preview",
    "media-download",
    "file-download",
  ],
  acknowledgement: "sqlite-full-transaction",
  identity: ["streamId", "writerId", "generation", "seq"],
} as const;
