import * as z from "zod/v4";

const text = z.union([z.string(), z.number()]);
// fast-xml-parser represents self-closing elements without attributes as "".
const element = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.preprocess((value) => (value === "" ? {} : value), z.looseObject(shape));
const many = <T extends z.ZodType>(schema: T) =>
  z.union([schema, z.array(schema)]).optional();
export const xmlColor = element({
  "@_rgb": z.string().optional(),
  "@_theme": text.optional(),
  "@_indexed": text.optional(),
  "@_tint": text.optional(),
});
const font = element({
  b: z.unknown().optional(),
  i: z.unknown().optional(),
  u: z.unknown().optional(),
  color: xmlColor.optional(),
  sz: element({ "@_val": text.optional() }).optional(),
});
const richText = z.union([text, element({ "#text": text.optional() })]);
export const richStringSchema = element({
  t: richText.optional(),
  r: many(element({ t: richText.optional(), rPr: font.optional() })),
});
const side = element({
  "@_style": z.string().optional(),
  color: xmlColor.optional(),
});
const styles = element({
  fonts: element({ font: many(font) }).optional(),
  fills: element({
    fill: many(
      element({
        patternFill: element({
          "@_patternType": z.string().optional(),
          fgColor: xmlColor.optional(),
        }).optional(),
      }),
    ),
  }).optional(),
  borders: element({
    border: many(
      element({
        top: side.optional(),
        bottom: side.optional(),
        left: side.optional(),
        right: side.optional(),
      }),
    ),
  }).optional(),
  numFmts: element({
    numFmt: many(element({ "@_numFmtId": text, "@_formatCode": z.string() })),
  }).optional(),
  cellXfs: element({
    xf: many(
      element({
        "@_fontId": text.optional(),
        "@_fillId": text.optional(),
        "@_borderId": text.optional(),
        "@_numFmtId": text.optional(),
        alignment: element({
          "@_horizontal": z.string().optional(),
          "@_vertical": z.string().optional(),
          "@_wrapText": text.optional(),
        }).optional(),
      }),
    ),
  }).optional(),
});
export const stylesDocumentSchema = element({
  styleSheet: styles.optional(),
}).nullable();
const themeEntry = element({
  "a:srgbClr": element({ "@_val": z.string().optional() }).optional(),
  "a:sysClr": element({ "@_lastClr": z.string().optional() }).optional(),
});
export const themeDocumentSchema = element({
  "a:theme": element({
    "a:themeElements": element({
      "a:clrScheme": z
        .record(z.string(), z.union([themeEntry, z.string()]))
        .optional(),
    }).optional(),
  }).optional(),
}).nullable();
export const workbookDocumentSchema = element({
  workbook: element({
    sheets: element({
      sheet: many(element({ "@_name": z.string(), "@_r:id": z.string() })),
    }).optional(),
  }).optional(),
}).nullable();
export const relationshipsDocumentSchema = element({
  Relationships: element({
    Relationship: many(element({ "@_Id": z.string(), "@_Target": z.string() })),
  }).optional(),
}).nullable();
export const sharedStringsDocumentSchema = element({
  sst: element({ si: many(richStringSchema) }).optional(),
}).nullable();
export const worksheetCellSchema = element({
  "@_r": z.string().optional(),
  "@_t": z.string().optional(),
  "@_s": text.optional(),
  v: text.optional(),
  f: z.unknown().optional(),
  is: richStringSchema.optional(),
});
export const worksheetDocumentSchema = element({
  worksheet: element({
    sheetData: element({
      row: many(
        element({
          "@_r": text.optional(),
          "@_s": text.optional(),
          "@_ht": text.optional(),
          c: many(worksheetCellSchema),
        }),
      ),
    }).optional(),
    mergeCells: element({
      mergeCell: many(element({ "@_ref": z.string() })),
    }).optional(),
    cols: element({
      col: many(
        element({
          "@_min": text.optional(),
          "@_max": text.optional(),
          "@_width": text.optional(),
        }),
      ),
    }).optional(),
    conditionalFormatting: z.unknown().optional(),
  }).optional(),
}).nullable();
export type XmlColor = z.infer<typeof xmlColor>;
export type XmlFont = z.infer<typeof font>;
export type XmlRichString = z.infer<typeof richStringSchema>;
export type XmlCell = z.infer<typeof worksheetCellSchema>;
