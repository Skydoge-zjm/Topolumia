import { omitFields } from "../../domain/research/object-values.js";
import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors.js";
import { versionHash } from "../../lib/hash.js";
import { recordInput, seriesInput } from "../../domain/research/workspace-input.js";
import { requirePermission } from "./research-command-service.js";
import { requireTimezone, seriesOccurrence } from "./record-recurrence.js";
import type * as z from "zod/v4";
import type { ResearchActor } from "../../domain/research/types.js";
import type { NotebookSaveOptions, NotebookStore } from "./notebook-store.js";
import type { ResearchState } from "./research-state.js";
const parse = <S extends z.ZodType>(schema:S, input:unknown):z.output<S> => {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError("RECORD_INPUT_INVALID", "研究记录字段无效。", { status: 422, detail: result.error.issues.slice(0, 6) });
  return result.data;
};
export class ResearchRecords {
  constructor(public store:NotebookStore, public state:ResearchState) {}
  list({ query = "", type = "", status = "", offset = 0, limit = 40 } = {}) {
    if (query.length > 300 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AppError("RECORD_QUERY_INVALID", "记录查询参数无效。", { status: 422 });
    const items = this.store.list("record").filter(item => (!type || item.type === type) && (!status || item.status === status) &&
      [item.title, item.body, ...item.participants, ...item.decisions].join(" ").toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => String(b.occurredAt ?? b.scheduledAt ?? b.createdAt).localeCompare(String(a.occurredAt ?? a.scheduledAt ?? a.createdAt)));
    return { items: items.slice(offset, offset + limit).map(item => ({ ...omitFields(item,["body","agenda"]), excerpt: item.body.slice(0, 220) })),
      total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null };
  }
  get(id:string) { return this.store.get("record", id); }
  save(input:unknown, actor:ResearchActor, options:NotebookSaveOptions = {}) {
    const value = parse(recordInput, input);
    requireTimezone(value.timezone);
    if (value.status === "planned" && (!value.scheduledAt || value.occurredAt))
      throw new AppError("RECORD_PLAN_INVALID", "已安排的活动需要计划时间，实际发生时间应留空。", { status: 422 });
    if (value.status === "confirmed") {
      requirePermission(actor, "research.review");
      if (!value.body.trim() || !value.occurredAt) throw new AppError("RECORD_CONFIRMATION_INVALID", "确认记录需要正文与实际发生时间。", { status: 422 });
      if (Date.parse(value.occurredAt) > Date.now() + 60000) throw new AppError("RECORD_CONFIRMATION_INVALID", "尚未发生的活动不能确认纪要。", { status: 422 });
    }
    const previous = options.id ? this.get(options.id) : null;
    const nodes = new Map((this.state.topology?.nodes??[]).map(node => [node.id, node]));
    const linkedNodes = [...new Set(value.nodeIds)].map(id => {
      const saved = previous?.linkedNodes.find(node => node.id === id);
      if (saved) return saved;
      const node = nodes.get(id);
      if (!node) throw new AppError("RECORD_NODE_INVALID", "引用的科研节点不存在。", { status: 422 });
      return { id, kind: node.kind, label: node.label, summary: node.summary, version: versionHash(node), capturedAt: new Date().toISOString() };
    });
    const data=omitFields(value,["nodeIds"]);
    return this.store.save("record", { ...data, actions: data.actions.map(action => ({ ...action, id: action.id ?? randomUUID() })), linkedNodes,
      seriesId: previous?.seriesId ?? null, occurrenceKey: previous?.occurrenceKey ?? null }, actor, options);
  }
  versions(id:string) { return this.store.versions("record", id); }
  series() { return this.store.list("series"); }
  saveSeries(input:unknown, actor:ResearchActor, options:NotebookSaveOptions = {}) {
    const value = parse(seriesInput, input);
    requireTimezone(value.timezone); seriesOccurrence(value, 0);
    return this.store.save("series", value, actor, options);
  }
  schedule(id:string, actor:ResearchActor, { date = null }: {date?:string|null} = {}) {
    const series = this.store.get("series", id);
    if (!series.active) throw new AppError("RECORD_SERIES_INACTIVE", "此周期活动已停用。", { status: 409 });
    const existing = this.store.list("record").filter(record => record.seriesId === id);
    let occurrence;
    for (let i = 0; i < 2400; i++) {
      const candidate = seriesOccurrence(series, i);
      if (date ? candidate.date === date : Date.parse(candidate.scheduledAt) >= Date.now()) { occurrence = candidate; break; }
      if (date && candidate.date > date) break;
    }
    if (!occurrence) throw new AppError("RECORD_OCCURRENCE_INVALID", "指定日期不属于周期活动，或超出可安排范围。", { status: 422 });
    const duplicate = existing.find(record => record.occurrenceKey === occurrence.date);
    if (duplicate) return { ...duplicate, idempotent: true };
    const data = parse(recordInput, { type: series.type, title: `${series.title} · ${occurrence.date}`, scheduledAt: occurrence.scheduledAt,
      participants: series.participants, timezone: series.timezone, status: "planned" });
    const fields=omitFields(data,["nodeIds"]);
    return this.store.save("record", { ...fields, linkedNodes: [], seriesId: id, occurrenceKey: occurrence.date }, actor);
  }
}
