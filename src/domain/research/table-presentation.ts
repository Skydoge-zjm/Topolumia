import * as z from "zod/v4";

const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const border = z.strictObject({
  style: z.enum(["thin", "medium", "thick", "dotted", "dashed", "double"]),
  color: color.optional(),
});
export const tableCellStyleSchema = z.strictObject({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  fontSize: z.number().min(1).max(72).optional(),
  color: color.optional(),
  background: color.optional(),
  horizontal: z.enum(["left", "center", "right", "justify"]).optional(),
  vertical: z.enum(["top", "middle", "bottom"]).optional(),
  wrap: z.boolean().optional(),
  numberFormat: z.string().max(240).optional(),
  borders: z.strictObject({ top: border.optional(), bottom: border.optional(), left: border.optional(), right: border.optional() }).optional(),
});
const run = z.strictObject({
  text: z.string().max(4_000),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  color: color.optional(),
});
export const tableGridSchema = z.strictObject({
  cells: z.array(z.array(z.strictObject({
    value: z.union([z.string().max(4_000), z.number().finite(), z.boolean(), z.null()]),
    text: z.string().max(4_000).optional(),
    rowSpan: z.number().int().min(1).max(301).optional(),
    colSpan: z.number().int().min(1).max(60).optional(),
    covered: z.boolean().optional(),
    style: tableCellStyleSchema.optional(),
    runs: z.array(run).max(200).optional(),
  })).max(60)).max(301),
  columnWidths: z.array(z.number().min(0).max(2_000)).max(60).optional(),
  rowHeights: z.array(z.number().min(0).max(1_000)).max(301).optional(),
  warnings: z.array(z.string().max(500)).max(20).optional(),
});
export type TableCellStyle = z.infer<typeof tableCellStyleSchema>;
export type TableGrid = z.infer<typeof tableGridSchema>;
