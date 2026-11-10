import * as z from "zod/v4";
import { experimentRecordPayloadSchema } from "./experiment-records.js";

export const contentBlockTypes = [
  "richText", "metric", "table", "image", "document", "spreadsheet", "link", "quote", "code", "chart", "file", "experimentRecord",
] as const;
export type ContentBlockType = typeof contentBlockTypes[number];
/** Patch fields preserve their schema output types while removing create-time defaults. */
export function nullablePatchShape<S extends Record<string, z.ZodType>>(shape: S) {
  type PatchShape = { [K in keyof S]: z.ZodOptional<z.ZodNullable<z.ZodType<z.output<S[K]>, z.input<S[K]>>>> };
  return Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, z.optional(z.nullable(schema instanceof z.ZodDefault ? schema.removeDefault() : schema))])) as PatchShape;
}

export const sourceRef = z.strictObject({
  id: z.string().max(240).optional(), clientRef: z.string().max(240).optional(), assetId: z.string().max(240).optional(),
  kind: z.enum(["url", "doi", "arxiv", "file", "page", "figure", "table", "section", "range", "experimentSnapshot"]),
  value: z.string().trim().min(1).max(2_000),
  locator: z.strictObject({
    page: z.string().max(80).optional(), figure: z.string().max(80).optional(), table: z.string().max(80).optional(),
    section: z.string().max(240).optional(), range: z.string().max(240).optional(),
  }).optional(),
  label: z.string().max(240).optional(),
});
const metricItem = z.strictObject({
  name: z.string().trim().min(1).max(240), value: z.union([z.number().finite(), z.string().max(240)]),
  unit: z.string().max(80).optional(), split: z.string().max(240).optional(), condition: z.string().max(500).optional(),
  direction: z.enum(["min", "max", "none"]).optional(), sourceRefIds: z.array(z.string().min(1).max(240)).max(40).optional(),
  note: z.string().max(2_000).optional(),
});
export const payloadSchemas = {
  experimentRecord: experimentRecordPayloadSchema,
  richText: z.strictObject({ format: z.enum(["markdown", "plain", "html"]).default("markdown"), body: z.string().max(200_000) }),
  metric: z.strictObject({ items: z.array(metricItem).max(500) }),
  table: z.strictObject({
    columns: z.array(z.strictObject({ key: z.string().min(1).max(120), label: z.string().min(1).max(240) })).max(100),
    rows: z.array(z.record(z.string(), z.union([z.string().max(4_000), z.number(), z.boolean(), z.null()]))).max(20_000),
    sourceFormat: z.enum(["manual", "csv", "xlsx", "tex", "image"]).optional(),
    caption: z.string().max(2000).optional(),
    sheetName: z.string().max(240).optional(),
    totalRows: z.number().int().min(0).optional(),
    truncated: z.boolean().optional(),
  }),
  image: z.strictObject({ caption: z.string().max(2_000).optional(), alt: z.string().max(500).optional(), locator: z.string().max(240).optional() }),
  document: z.strictObject({ format: z.enum(["pdf", "markdown", "tex", "text"]), title: z.string().max(240).optional() }),
  spreadsheet: z.strictObject({ format: z.enum(["xlsx", "csv"]), sheet: z.string().max(240).optional(), range: z.string().max(240).optional() }),
  link: z.strictObject({ url: z.url().max(2_000), label: z.string().max(240).optional(), kind: z.string().max(80).optional(), note: z.string().max(2_000).optional() }),
  quote: z.strictObject({ text: z.string().min(1).max(50_000), sourceRefIds: z.array(z.string().min(1).max(240)).max(40), translation: z.string().max(50_000).optional(), note: z.string().max(2_000).optional() }),
  code: z.strictObject({ language: z.string().max(80).optional(), code: z.string().max(200_000), filename: z.string().max(240).optional() }),
  chart: z.strictObject({ chartType: z.enum(["line", "bar", "scatter", "area"]), dataBlockId: z.string().min(1).max(240), config: z.record(z.string(), z.unknown()).default({}) }),
  file: z.strictObject({ label: z.string().max(240).optional(), note: z.string().max(2_000).optional() }),
} as const;

const httpUrl = z.url().max(2000).refine(value => { const u = new URL(value); return ["http:","https:"].includes(u.protocol) && !u.username && !u.password; }, "Use HTTP(S) without credentials");
export const representationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ id: z.string().max(240).optional(), clientRef: z.string().max(240).optional(), kind: z.literal("asset"), assetId: z.string().max(240), role: z.enum(["source","transcription","rendering","supplement"]), label: z.string().max(240).optional(), sourceRefIds: z.array(z.string().max(240)).max(80).optional() }),
  z.strictObject({ id: z.string().max(240).optional(), clientRef: z.string().max(240).optional(), kind: z.literal("link"), url: httpUrl, role: z.enum(["source","supplement"]), label: z.string().max(240).optional(), sourceRefIds: z.array(z.string().max(240)).max(80).optional() }),
]);
export const contentBlockInput = z.strictObject({
  title: z.string().trim().min(1).max(240),
  type: z.enum(contentBlockTypes),
  role: z.literal("body").optional(),
  payload: z.unknown().optional(),
  representations: z.array(representationSchema).max(40).default([]),
  primaryRepresentationId: z.string().max(240).optional(),
  sourceRefs: z.array(sourceRef).max(80).default([]),
  review: z.enum(["unreviewed", "needs_review", "confirmed", "rejected"]).default("unreviewed"),
});

export function validateContentBlockPayload(type: ContentBlockType, payload: unknown) {
  const result = payloadSchemas[type].safeParse(payload);
  if (!result.success) return { success: false as const, issues: result.error.issues.slice(0, 12) };
  return { success: true as const, data: result.data };
}

export function extractContentBlockText(type: ContentBlockType, payload: any) {
  if (!payload) return "";
  if (type === "experimentRecord") return [payload.provider, ...(payload.runs ?? []).map((run: { label: string }) => run.label)].join("\n");
  if (type === "richText" || type === "code") return String(payload.body ?? payload.code ?? "");
  if (type === "quote") return [payload.text, payload.translation, payload.note].filter(Boolean).join("\n");
  if (type === "link") return [payload.label, payload.url, payload.note].filter(Boolean).join("\n");
  if (type === "metric") return (payload.items ?? []).map((item: any) => [item.name, item.value, item.unit, item.split].filter(v => v !== undefined && v !== null && v !== "").join(" ")).join("\n");
  if (type === "table") return (payload.rows ?? []).map((row: any) => Object.values(row).join(" ")).join("\n");
  return String(payload.caption ?? payload.title ?? payload.label ?? "");
}

export const paperCoreSchema = z.strictObject({
  nodeName: z.string().trim().min(1).max(240),
  paperTitle: z.string().max(500).optional(),
  authors: z.array(z.string().trim().min(1).max(240)).max(200).optional(),
  year: z.number().int().min(1_000).max(3_000).optional(),
  venue: z.string().max(240).optional(),
  field: z.string().max(240).optional(),
  identifiers: z.strictObject({ doi: z.string().max(240).optional(), arxiv: z.string().max(240).optional(), other: z.array(z.string().max(240)).max(20).optional() }).optional(),
  urls: z.array(z.url().max(2_000)).max(40).optional(),
  abstract: z.string().max(50_000).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(40).optional(),
});
export const genericCoreSchema = z.strictObject({ nodeName: z.string().trim().min(1).max(240), summary: z.string().max(2_000).optional(), tags: z.array(z.string().trim().min(1).max(80)).max(40).optional() });
export function coreSchema(kind: string) { return kind === "paper" ? paperCoreSchema : genericCoreSchema; }
