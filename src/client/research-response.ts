import * as z from "zod/v4";

export const wireErrorSchema = z.looseObject({
  code: z.string().optional(), message: z.string().optional(), detail: z.unknown().optional(),
  exitCode: z.number().nullable().optional(), status: z.number().optional(), outcome: z.string().optional(),
});
export const cliMessageSchema = z.looseObject({ schemaVersion: z.string() });
export const researchResultSchema = z.looseObject({
  schemaVersion: z.literal("research-agent-result.v1"), kind: z.string(),
  projectId: z.string().optional(),
  data: z.looseObject({
    items: z.array(z.unknown()).optional(), status: z.string().optional(),
    candidateId: z.string().optional(), assetId: z.string().optional(), operationId: z.string().optional(),
    contentPath: z.string().optional(), checksum: z.string().optional(), sizeBytes: z.number().optional(),
  }),
  page: z.looseObject({ nextCursor: z.string().nullable().optional() }).optional(),
  readReceipts: z.array(z.unknown()).optional(), pages: z.number().optional(),
  budget: z.looseObject({ returnedChars: z.number(), maxChars: z.number().optional() }),
});
export type ResearchResult = z.infer<typeof researchResultSchema>;
export interface ResearchClientError extends Error {
  code?: string; status?: number; detail?: unknown; exitCode?: number | null; outcome?: string;
  execution?: { pid?: number; durationMs: number; exitCode: number | null };
}
export function clientError(cause: unknown): ResearchClientError {
  return cause instanceof Error ? cause : new Error(String(cause));
}
