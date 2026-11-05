import * as z from "zod/v4";
import { activityKinds } from "./node-fields.js";
export const id = z.string().min(1).max(240);
export const title = z.string().trim().min(1).max(240);
const text = z.string().max(20000);
export const revision = z.number().int().min(1);
export const linkSchema = z.strictObject({ label: z.string().max(240), url: z.url().max(2000).refine(value => {
  const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "链接必须是无凭据的 HTTP(S) URL"), kind: z.enum(["paper", "code", "dataset", "wandb", "tensorboard", "mlflow", "artifact", "image", "report", "other"]).default("other") });
export const links = z.array(linkSchema).max(40).default([]);
export const metrics = z.array(z.strictObject({ name: title, value: z.number().finite(), unit: z.string().max(80).default(""), split: z.string().max(120).default(""), direction: z.enum(["min", "max", "none"]).default("none") })).max(100).default([]);
export const recordInput = z.strictObject({ type: z.enum(Object.keys(activityKinds)), title,
  scheduledAt: z.iso.datetime({ offset: true }).nullable().default(null), occurredAt: z.iso.datetime({ offset: true }).nullable().default(null),
  timezone: z.string().max(120).default("Asia/Shanghai"), participants: z.array(z.string().trim().min(1).max(240)).max(100).default([]),
  agenda: text.default(""), body: z.string().max(100000).default(""), decisions: z.array(z.string().max(4000)).max(100).default([]),
  openQuestions: z.array(z.string().max(4000)).max(100).default([]),
  actions: z.array(z.strictObject({ id: id.optional(), text: title, assignee: z.string().max(240).default(""), dueDate: z.iso.date().nullable().default(null), status: z.enum(["open", "done", "cancelled"]).default("open") })).max(100).default([]),
  links, nodeIds: z.array(id).max(80).default([]), status: z.enum(["planned", "draft", "confirmed", "cancelled"]).default("draft"),
});
export const seriesInput = z.strictObject({ title, type: z.enum(Object.keys(activityKinds)).default("meeting"),
  participants: z.array(z.string().trim().min(1).max(240)).max(100).default([]),
  frequency: z.enum(["weekly", "monthly"]), interval: z.number().int().min(1).max(12).default(1),
  timezone: z.string().max(120), startDate: z.iso.date(), localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  active: z.boolean().default(true) });
