import { z } from "zod";

export const AgentTurnInputSchema = z
  .object({
    text: z.string().trim().max(10_000),
    attachmentIds: z.array(z.string()).max(8).optional(),
    model: z.string().trim().max(160).optional(),
    reasoningEffort: z.string().trim().max(32).optional(),
  })
  .refine((value) => Boolean(value.text || value.attachmentIds?.length), {
    message: "请输入文字或添加图片。",
  });
