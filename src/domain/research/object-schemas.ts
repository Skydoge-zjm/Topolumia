import * as z from "zod/v4";
import { researchObjectKinds } from "./object-ref.js";
export const objectRefSchema = z.strictObject({ kind: z.enum(researchObjectKinds), id: z.string().min(1).max(240) });
export const endpointVersionsSchema = z.array(z.strictObject({ object: objectRefSchema, revision: z.number().int().positive() })).max(2);
