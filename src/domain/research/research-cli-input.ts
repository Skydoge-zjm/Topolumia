import * as z from "zod/v4";
import { createProposalSchema, reviseProposalSchema } from "./changes/proposals.js";
import { transferSchema } from "./interfaces/tools.js";
export const writeSchemas={create:createProposalSchema,edit:reviseProposalSchema,review:z.strictObject({decision:z.enum(["accept","reject","defer"]),reason:z.string().max(2000),expectedRevision:z.number().int().positive()})};
export function inputSchema(command){const schema=command==="asset upload"||command==="asset download"?transferSchema:writeSchemas[command.split(" ")[1]];return schema?z.toJSONSchema(schema):null;}
