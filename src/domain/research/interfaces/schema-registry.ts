import * as z from "zod/v4";
import { coreSchema, contentBlockInput, payloadSchemas } from "../content-blocks.js";
import { groupCoreSchema } from "../groups.js";
import { researchNodeKinds } from "../node-kinds.js";
import { createProposalSchema, reviseProposalSchema, proposalExamples } from "../changes/proposals.js";

const payloads = {
  richText: { format: "markdown", body: "Source-grounded research note" },
  metric: { items: [{ name: "Metric", value: 0, unit: "%", condition: "Example setting" }] },
  table: { columns: [{ key: "c1", label: "Metric" }], rows: [{ c1: 0 }] },
  image: { alt: "Source figure" }, document: { format: "pdf" }, spreadsheet: { format: "xlsx" },
  link: { url: "https://example.org", label: "Source" }, quote: { text: "Source quotation", sourceRefIds: [] },
  code: { language: "python", code: "print(0)" },
  chart: { chartType: "line", dataBlockId: "block:source-data", config: {} }, file: { label: "Source file" },
};
export const schemaRegistry = {
  nodeCore: Object.fromEntries(researchNodeKinds.map(kind => [kind, {
    schema: coreSchema(kind), example: kind === "paper" ? { nodeName: "Example", paperTitle: "An Example Research Paper" } : { nodeName: "Example" },
  }])),
  groupCore: { group: {schema:groupCoreSchema,example:{nodeName:"Ablation experiments"}} },
  contentBlock: Object.fromEntries(Object.entries(payloadSchemas).map(([type, payload]) => [type, {
    schema: contentBlockInput.extend({ type: z.literal(type), payload: payload.optional() }),
    example: { title: "Example", type, payload: payloads[type], ...(["image", "document", "spreadsheet", "file"].includes(type) ? { representations: [{ kind: "asset", assetId: "asset:uploaded-file", role: "source" }] } : {}) },
  }])),
  proposal: { create: { schema: createProposalSchema, example: proposalExamples.create }, edit: { schema: reviseProposalSchema, example: proposalExamples.edit } },
};
