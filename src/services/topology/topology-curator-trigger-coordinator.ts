import { AppError } from "../../lib/errors.js";
import { versionHash, compactId } from "../../lib/hash.js";
import * as z from "zod/v4";
import type { ResearchTopology, SourceSnapshot } from "../../domain/research/types.js";
import type { ResearchState, ResearchEvent } from "../research/research-state.js";
import type { TopologyService } from "./topology-service.js";
import type { TopologyCuratorService } from "./topology-curator.js";
import type { CuratorAutomation, CuratorEnvelope, CuratorTriggerRecord, CuratorTriggerStatus, TopologyCuratorResult } from "./curator-types.js";
const contextSchema = z.looseObject({ entryContext: z.unknown().optional(), workingContext: z.record(z.string(), z.unknown()).nullable().optional(), focus: z.unknown().optional(), continuityContext: z.unknown().optional(), operation: z.unknown().optional() });
const triggerInputSchema = z.looseObject({ schemaVersion: z.string().optional(), mode: z.string().nullable().optional(), cause: z.string().nullable().optional(), nodeIds: z.unknown().optional(), edgeIds: z.unknown().optional(), sourceRefs: z.unknown().optional(), eventIds: z.unknown().optional(), workingContext: z.record(z.string(), z.unknown()).nullable().optional(), context: contextSchema.nullable().optional(), sessionId: z.unknown().optional(), requestedAt: z.string().nullable().optional(), baseTopologyVersion: z.string().nullable().optional(), sourceStateVersion: z.string().nullable().optional(), entryContext: z.unknown().optional(), focus: z.unknown().optional(), continuityContext: z.unknown().optional(), operation: z.unknown().optional(), locale: z.string().nullable().optional(), bypassDedup: z.boolean().optional(), force: z.boolean().optional() });
function triggerInput(value: unknown) { const result = triggerInputSchema.safeParse(value); if (!result.success) throw new AppError("CURATOR_TRIGGER_INVALID", "B 触发信封格式无效。", {status:422}); return result.data; }
type CuratorSettings = { curator?: { model?: string; reasoningEffort?: string; automation?: Partial<CuratorAutomation> }; automation?: Partial<CuratorAutomation> };
type CoordinatorOptions = { topologyCurator: TopologyCuratorService; topologyService: TopologyService; state: ResearchState; getSettings?: () => CuratorSettings; now?: () => Date | string | number; maxHistory?: number };
type ResponseExtra = { deduplicated?: boolean; requiresConfirmation?: boolean; triggerId?: string; reason?: string; suggestionId?: string };

const MODES = new Set(["manual", "suggested", "background"]);
const CAUSES = new Set([
  "user_request",
  "session_checkpoint",
  "experiment_delta",
  "source_delta",
  "topology_changed",
  "idle_batch",
  "continuity_break",
  "formal_state_request",
]);
const EVENT_TYPES = new Set(["agentMessage", "toolCall", "toolResult", "humanResearchMove"]);
const AUTO_CAUSES: Readonly<Record<string, keyof CuratorAutomation>> = Object.freeze({
  session_checkpoint: "triggerOnSessionCheckpoint",
  experiment_delta: "triggerOnExperimentDelta",
  source_delta: "triggerOnSourceDelta",
  idle_batch: "triggerOnIdle",
  continuity_break: "triggerOnContinuityBreak",
  topology_changed: "triggerOnTopologyChanged",
});

function clone<T>(value: T): T {
  return structuredClone(value);
}

function clockMs(now: () => Date | string | number) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : Date.now();
}

function arrayOfStrings(value: unknown, field: string, max: number, maxLength = 240): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new AppError("CURATOR_TRIGGER_INVALID", `${field} 必须是最多 ${max} 项的数组。`, { status: 422, detail: { field, max } });
  }
  if (value.some((item) => typeof item !== "string")) {
    throw new AppError("CURATOR_TRIGGER_INVALID", `${field} 必须只包含字符串。`, { status: 422, detail: { field } });
  }
  const result = [...new Set(value.map((item) => String(item).trim()))];
  if (result.some((item) => !item || item.length > maxLength)) {
    throw new AppError("CURATOR_TRIGGER_INVALID", `${field} 包含无效值。`, { status: 422, detail: { field } });
  }
  return result;
}

function objectOrNull(value: unknown, field: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("CURATOR_TRIGGER_INVALID", `${field} 必须是对象。`, { status: 422, detail: { field } });
  }
  let serialized;
  try { serialized = JSON.stringify(value); } catch {
    throw new AppError("CURATOR_TRIGGER_INVALID", `${field} 必须可序列化。`, { status: 422, detail: { field } });
  }
  if (serialized.length > 8_000) {
    throw new AppError("CURATOR_TRIGGER_INVALID", `${field} 超过 8000 字符上限。`, { status: 422, detail: { field } });
  }
  return clone(value as Record<string, unknown>);
}

function boundedValue(value: unknown, field: string, max = 8_000) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    if (value.length > max) throw new AppError("CURATOR_TRIGGER_INVALID", `${field} 超过长度上限。`, { status: 422, detail: { field, max } });
    return value;
  }
  return objectOrNull(value, field);
}

function resultSummary(result: TopologyCuratorResult | null) {
  if (!result) return null;
  return {
    disposition: result.disposition ?? null,
    summary: String(result.summary ?? "").slice(0, 1_000),
    runId: result.runId ?? null,
    model: result.model ?? null,
    patchId: result.patch?.id ?? null,
  };
}

function errorSummary(error: unknown): CuratorTriggerRecord["error"] {
  if (!error) return null;
  const object = typeof error === "object" ? error as Record<string, unknown> : {};
  return { code: String(object.code ?? "INTERNAL_ERROR"), message: String(object.message ?? error), retryable: Boolean(object.retryable) };
}

export const CURATOR_TRIGGER_SCHEMA_VERSION = "topology-curator-trigger.v1";
export const CURATOR_TRIGGER_RESULT_SCHEMA_VERSION = "topology-curator-trigger-result.v1";

export function normalizeBTriggerEnvelope(value: unknown = {}, { topology, snapshot, now = () => new Date() }: {topology?: ResearchTopology | null; snapshot?: SourceSnapshot | null; now?: () => Date | string | number} = {}): CuratorEnvelope {
  const input = triggerInput(value);
  if (!topology || typeof topology !== "object") {
    throw new AppError("TOPOLOGY_REQUIRED", "需要当前正式拓扑才能触发 B。", { status: 409 });
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("CURATOR_TRIGGER_INVALID", "B 触发信封必须是对象。", { status: 422 });
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== CURATOR_TRIGGER_SCHEMA_VERSION) {
    throw new AppError("CURATOR_TRIGGER_INVALID", "B 触发信封 schemaVersion 无效。", { status: 422 });
  }
  const mode = input.mode ?? "manual";
  if (!MODES.has(mode)) throw new AppError("CURATOR_TRIGGER_INVALID", "不支持的 B 触发模式。", { status: 422, detail: { mode, supported: [...MODES] } });
  const cause = input.cause ?? "user_request";
  if (!CAUSES.has(cause)) throw new AppError("CURATOR_TRIGGER_INVALID", "不支持的 B 触发原因。", { status: 422, detail: { cause, supported: [...CAUSES] } });
  const topologyNodeIds = new Set((topology?.nodes ?? []).map((node) => node.id));
  const topologyEdgeIds = new Set((topology?.edges ?? []).map((edge) => edge.id));
  const sourceRefs = new Set([
    ...(snapshot?.git?.ref ? [snapshot.git.ref] : []),
    ...(snapshot?.files?.files ?? []).map((item) => item.ref),
    ...(topology?.nodes ?? []).flatMap((node) => [node.sourceRef, ...(Array.isArray(node.data.sourceRefs) ? node.data.sourceRefs.filter((ref): ref is string => typeof ref === "string") : [])]),
    ...(topology?.edges ?? []).map((edge) => edge.sourceRef),
  ].filter(Boolean));
  const nodeIds = arrayOfStrings(input.nodeIds ?? input.workingContext?.nodeIds, "nodeIds", 80, 240);
  const edgeIds = arrayOfStrings(input.edgeIds ?? input.workingContext?.edgeIds, "edgeIds", 160, 240);
  const refs = arrayOfStrings(input.sourceRefs ?? input.workingContext?.sourceRefs, "sourceRefs", 80, 1_000);
  const eventIds = arrayOfStrings(input.eventIds, "eventIds", 240, 240);
  const invalidNodes = nodeIds.filter((id) => !topologyNodeIds.has(id));
  const invalidEdges = edgeIds.filter((id) => !topologyEdgeIds.has(id));
  const invalidRefs = refs.filter((ref) => !sourceRefs.has(ref));
  if (invalidNodes.length || invalidEdges.length || invalidRefs.length) {
    throw new AppError("CURATOR_TRIGGER_INVALID", "B 触发上下文包含当前状态不存在的引用。", {
      status: 422,
      detail: { invalidNodes, invalidEdges, invalidRefs },
    });
  }
  const sessionId = input.sessionId === undefined || input.sessionId === null ? null : String(input.sessionId).trim();
  if (sessionId !== null && (!sessionId || sessionId.length > 240)) {
    throw new AppError("CURATOR_TRIGGER_INVALID", "sessionId 长度无效。", { status: 422 });
  }
  const requestedAt = input.requestedAt ?? new Date(clockMs(now)).toISOString();
  if (!Number.isFinite(Date.parse(requestedAt))) {
    throw new AppError("CURATOR_TRIGGER_INVALID", "requestedAt 必须是有效 ISO 时间。", { status: 422 });
  }
  const baseTopologyVersion = input.baseTopologyVersion ?? topology?.stateVersion ?? null;
  if (!baseTopologyVersion || typeof baseTopologyVersion !== "string") {
    throw new AppError("CURATOR_TRIGGER_INVALID", "需要当前正式拓扑版本。", { status: 409 });
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(baseTopologyVersion)) {
    throw new AppError("CURATOR_TRIGGER_INVALID", "baseTopologyVersion 必须是 sha256 版本。", { status: 422 });
  }
  if (topology?.stateVersion && baseTopologyVersion !== topology.stateVersion) {
    throw new AppError("TOPOLOGY_VERSION_CONFLICT", "B 触发基于旧版正式拓扑，请重新发起。", {
      status: 409,
      detail: { expected: topology.stateVersion, received: baseTopologyVersion },
    });
  }
  const sourceStateVersion = input.sourceStateVersion ?? snapshot?.stateVersion ?? null;
  if (sourceStateVersion !== null && (typeof sourceStateVersion !== "string" || !sourceStateVersion.trim())) {
    throw new AppError("CURATOR_TRIGGER_INVALID", "sourceStateVersion 类型无效。", { status: 422 });
  }
  if (sourceStateVersion !== null && sourceStateVersion.length > 240) {
    throw new AppError("CURATOR_TRIGGER_INVALID", "sourceStateVersion 长度无效。", { status: 422 });
  }
  if (snapshot?.stateVersion && sourceStateVersion !== null && snapshot.stateVersion !== sourceStateVersion) {
    throw new AppError("SOURCE_VERSION_CONFLICT", "B 触发基于旧版研究来源，请重新发起。", {
      status: 409,
      detail: { expected: snapshot.stateVersion, received: sourceStateVersion },
    });
  }
  if (!snapshot?.stateVersion && sourceStateVersion !== null) {
    throw new AppError("SOURCE_VERSION_CONFLICT", "当前没有可匹配的研究来源版本，请重新同步。", { status: 409 });
  }
  const entryContext = objectOrNull(input.entryContext ?? input.context?.entryContext, "entryContext");
  const workingContext = objectOrNull(input.workingContext ?? input.context?.workingContext, "workingContext") ?? {};
  const focus = input.focus ?? input.context?.focus ?? null;
  const continuityContext = input.continuityContext ?? input.context?.continuityContext ?? null;
  const boundedFocus = boundedValue(focus, "focus");
  const boundedContinuity = boundedValue(continuityContext, "continuityContext");
  const operation = input.operation ?? input.context?.operation ?? null;
  if (operation !== null && (typeof operation !== "string" || operation.length > 500)) {
    throw new AppError("CURATOR_TRIGGER_INVALID", "operation 长度或类型无效。", { status: 422 });
  }
  return {
    schemaVersion: CURATOR_TRIGGER_SCHEMA_VERSION,
    mode,
    cause,
    entryContext,
    workingContext: {
      ...workingContext,
      nodeIds,
      edgeIds,
      sourceRefs: refs,
    },
    sessionId,
    eventIds,
    nodeIds,
    edgeIds,
    sourceRefs: refs,
    baseTopologyVersion,
    sourceStateVersion,
    requestedAt: new Date(requestedAt).toISOString(),
    locale: input.locale === "en" ? "en" : "zh",
    operation,
    focus: boundedFocus,
    continuityContext: boundedContinuity,
  };
}

export class TopologyCuratorTriggerCoordinator {
  topologyCurator: TopologyCuratorService; topologyService: TopologyService; state: ResearchState;
  getSettings: NonNullable<CoordinatorOptions["getSettings"]>; now: NonNullable<CoordinatorOptions["now"]>; maxHistory: number;
  inFlight: { id: string; fingerprint: string; queued?: boolean } | null;
  records = new Map<string, CuratorTriggerRecord>(); history: CuratorTriggerRecord[] = []; consumedEventIds = new Set<string>();
  lastActivityAt: number; idleTimer: ReturnType<typeof setInterval> | null; started: boolean; status: string;
  lastRecord: CuratorTriggerRecord | null; cooldownUntil: string | null; settings: CuratorAutomation;
  constructor({
    topologyCurator,
    topologyService,
    state,
    getSettings = () => ({}),
    now = () => new Date(),
    maxHistory = 40,
  }: CoordinatorOptions) {
    if (!topologyCurator || !topologyService || !state) throw new TypeError("TopologyCuratorTriggerCoordinator requires curator, topology service, and state");
    this.topologyCurator = topologyCurator;
    this.topologyService = topologyService;
    this.state = state;
    this.getSettings = getSettings;
    this.now = now;
    this.maxHistory = Math.max(5, Number(maxHistory) || 40);
    this.inFlight = null;
    this.records = new Map();
    this.history = [];
    this.consumedEventIds = new Set();
    this.lastActivityAt = clockMs(this.now);
    this.idleTimer = null;
    this.started = false;
    this.status = "idle";
    this.lastRecord = null;
    this.cooldownUntil = null;
    this.settings = this.#automationSettings(this.getSettings());
    this.updateState();
  }

  updateSettings(settings = this.getSettings()) {
    const previous = this.settings;
    this.settings = this.#automationSettings(settings);
    if (this.idleTimer && previous && (previous.idleSeconds !== this.settings.idleSeconds || previous.triggerOnIdle !== this.settings.triggerOnIdle || previous.enabled !== this.settings.enabled)) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.started && this.settings.enabled && this.settings.triggerOnIdle && !this.idleTimer) this.start();
    if (this.started && (!this.settings.enabled || !this.settings.triggerOnIdle) && this.idleTimer) this.stop();
    this.updateState();
  }

  start() {
    this.started = true;
    if (this.idleTimer || !this.settings?.enabled || !this.settings?.triggerOnIdle) return;
    const idleMs = Math.max(30_000, this.settings?.idleSeconds * 1_000 || 900_000);
    this.idleTimer = setInterval(() => {
      const age = clockMs(this.now) - this.lastActivityAt;
      if (age < idleMs) return;
      this.lastActivityAt = clockMs(this.now);
      void this.consider("idle_batch", { entryContext: { surface: "scheduler", action: "idle" } }).catch(() => {});
    }, Math.min(idleMs, 60_000));
    this.idleTimer.unref?.();
  }

  stop() {
    this.started = false;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  noteActivity() {
    this.lastActivityAt = clockMs(this.now);
    this.updateState();
  }

  statusView(): CuratorTriggerStatus {
    if (this.status === "cooldown" && this.cooldownUntil && new Date(this.cooldownUntil).getTime() <= clockMs(this.now)) {
      this.cooldownUntil = null;
      this.status = "idle";
    }
    const pendingEventIds = this.pendingEventIds();
    return {
      schemaVersion: CURATOR_TRIGGER_RESULT_SCHEMA_VERSION,
      status: this.status,
      pendingEventCount: pendingEventIds.length,
      pendingEventIds: pendingEventIds.slice(-240),
      running: Boolean(this.inFlight),
      cooldownUntil: this.cooldownUntil,
      lastActivityAt: new Date(this.lastActivityAt).toISOString(),
      last: clone(this.lastRecord),
      history: clone(this.history),
      automation: clone(this.settings ?? this.#automationSettings(this.getSettings())),
    };
  }

  async trigger(value: unknown = {}) {
    const input = triggerInput(value);
    const runtimeSettings = this.getSettings();
    this.updateSettings(runtimeSettings);
    const bypassDedup = input.bypassDedup === true || input.force === true;
    const envelope = normalizeBTriggerEnvelope(input, {
      topology: this.formalTopology(),
      snapshot: this.state.snapshot,
      now: this.now,
    });
    const selectedEvents = this.selectEvents(envelope, { pendingOnly: envelope.mode !== "manual" });
    if (envelope.mode !== "manual" && selectedEvents.length === 0) {
      return this.skip(envelope, null, "no pending events");
    }
    if (envelope.eventIds.length) {
      const availableIds = new Set((this.state.agentEvents ?? [])
        .filter((event) => EVENT_TYPES.has(event.type) && (!envelope.sessionId || event.sessionId === envelope.sessionId))
        .map((event) => event.id));
      const missingEventIds = envelope.eventIds.filter((id) => !availableIds.has(id));
      if (missingEventIds.length) {
        throw new AppError("CURATOR_TRIGGER_INVALID", "eventIds 中包含当前事件窗口不存在的事件。", { status: 422, detail: { missingEventIds } });
      }
    }
    const fingerprint = versionHash({
      baseTopologyVersion: envelope.baseTopologyVersion,
      sourceStateVersion: envelope.sourceStateVersion,
      cause: envelope.cause,
      sessionId: envelope.sessionId,
      eventIds: (envelope.eventIds.length ? envelope.eventIds : selectedEvents.map((event) => event.id)).slice().sort(),
      nodeIds: envelope.nodeIds.slice().sort(),
      edgeIds: envelope.edgeIds.slice().sort(),
      sourceRefs: envelope.sourceRefs.slice().sort(),
      operation: envelope.operation,
      focus: envelope.focus,
      continuityContext: envelope.continuityContext,
      locale: envelope.locale,
      model: runtimeSettings?.curator?.model ?? null,
      reasoningEffort: runtimeSettings?.curator?.reasoningEffort ?? null,
    });
    const previous = this.records.get(fingerprint);
    if (!bypassDedup && previous?.status === "available" && previous.result) {
      return this.response(previous.status, envelope, fingerprint, previous.result, { deduplicated: true, triggerId: previous.id });
    }
    if (!bypassDedup && envelope.mode !== "manual" && previous?.status === "suggested") {
      return this.response("suggested", envelope, fingerprint, null, { deduplicated: true, requiresConfirmation: true, triggerId: previous.id });
    }
    if (envelope.mode !== "manual" && this.lastRecord?.status === "suggested") {
      return this.response("skipped", envelope, fingerprint, null, { reason: "a curation suggestion is awaiting confirmation", suggestionId: this.lastRecord.id });
    }
    if (this.inFlight) {
      if (envelope.mode === "manual") throw new AppError("CURATOR_TRIGGER_RUNNING", "另一个 B 任务正在运行，请稍后再试。", { status: 409, retryable: true });
      return this.response("skipped", envelope, fingerprint, null, { reason: "another trigger is running" });
    }
    if (envelope.mode !== "manual" && this.cooldownUntil && new Date(this.cooldownUntil).getTime() > clockMs(this.now)) {
      this.status = "cooldown";
      this.updateState();
      return this.response("cooldown", envelope, fingerprint, null, { reason: "cooldown" });
    }
    const record: CuratorTriggerRecord = {
      id: compactId("curator_trigger"),
      fingerprint,
      envelope,
      status: envelope.mode === "suggested" ? "suggested" : envelope.mode === "background" ? "queued" : "running",
      pendingEventCount: selectedEvents.length,
      eventIds: selectedEvents.map((event) => event.id),
      startedAt: envelope.mode === "suggested" ? null : new Date(clockMs(this.now)).toISOString(),
      completedAt: null,
      consumedAt: null,
      disposition: null,
      resultSummary: null,
      error: null,
    };
    this.remember(record);
    if (envelope.mode === "suggested") {
      this.status = "suggested";
      this.updateState();
      return this.response("suggested", envelope, fingerprint, null, { requiresConfirmation: true, triggerId: record.id });
    }
    if (envelope.mode === "background") {
      // Reserve the single-flight slot before yielding to the microtask queue;
      // otherwise two simultaneous background requests could both enqueue B.
      this.inFlight = { id: record.id, fingerprint: record.fingerprint, queued: true };
      this.status = "queued";
      this.updateState();
      queueMicrotask(() => {
        void this.#run(record, selectedEvents).catch(() => {});
      });
      return this.response("queued", envelope, fingerprint, null, { triggerId: record.id });
    }
    const result = await this.#run(record, selectedEvents);
    return this.response(record.status, envelope, fingerprint, result, { triggerId: record.id });
  }

  async consider(cause: string, value: unknown = {}) {
    const input = triggerInput(value);
    this.updateSettings(this.getSettings());
    if (!AUTO_CAUSES[cause]) return this.skip({ cause }, null, "cause is not automatic", { update: false });
    const settingKey = AUTO_CAUSES[cause];
    if (!this.settings.enabled || (!this.settings[settingKey] && input.force !== true)) return this.skip({ cause }, null, "automation disabled", { update: false });
    if (this.topologyCurator.driver?.config?.enabled === false) return this.skip({ cause }, null, "curator disabled", { update: false });
    const pending = this.pendingEventIds();
    if (!pending.length && !["continuity_break", "topology_changed"].includes(cause)) return this.skip({ cause }, null, "no pending events", { update: false });
    if (pending.length < this.settings.minPendingEvents && input.force !== true && !this.highValueCause(cause)) return this.skip({ cause }, null, "pending threshold not reached", { update: false });
    const mode = this.settings.backgroundMode === "background" ? "background" : "suggested";
    return this.trigger({ ...input, mode, cause });
  }

  formalTopology() {
    if (!this.state.topology) throw new AppError("TOPOLOGY_REQUIRED", "需要当前正式拓扑才能触发 B。", { status: 409 });
    return this.topologyService.clearCandidate(this.state.topology);
  }

  pendingEventIds() {
    const events = this.state.agentEvents ?? [];
    const currentIds = new Set(events.map((event) => event.id));
    for (const eventId of this.consumedEventIds) if (!currentIds.has(eventId)) this.consumedEventIds.delete(eventId);
    return events
      .filter((event) => EVENT_TYPES.has(event.type) && !this.consumedEventIds.has(event.id))
      .map((event) => event.id);
  }

  invalidatePatch(patchId: string | null | undefined) {
    if (!patchId) return;
    for (const [fingerprint, record] of this.records.entries()) {
      if (record.result?.patch?.id !== patchId) continue;
      this.records.delete(fingerprint);
    }
    this.history = this.history.filter((record) => record.resultSummary?.patchId !== patchId);
    if (this.lastRecord?.resultSummary?.patchId === patchId) this.lastRecord = this.history[0] ?? null;
    if (this.status === "available" && !this.lastRecord) this.status = "idle";
    this.updateState();
  }

  resetForStateChange() {
    if (this.inFlight) return;
    this.status = "idle";
    this.cooldownUntil = null;
    this.lastRecord = null;
    this.updateState();
  }

  selectEvents(envelope: Partial<CuratorEnvelope>, { pendingOnly = false } = {}) {
    let events = (this.state.agentEvents ?? []).filter((event) => EVENT_TYPES.has(event.type));
    if (pendingOnly) events = events.filter((event) => !this.consumedEventIds.has(event.id));
    if (envelope.eventIds?.length) {
      const selected = new Set(envelope.eventIds);
      events = events.filter((event) => selected.has(event.id));
    }
    if (envelope.sessionId) events = events.filter((event) => event.sessionId === envelope.sessionId);
    return events.slice(-120);
  }

  async #run(record: CuratorTriggerRecord, selectedEvents: ResearchEvent[]) {
    this.inFlight = { id: record.id, fingerprint: record.fingerprint };
    this.status = "running";
    record.status = "running";
    record.startedAt ??= new Date(clockMs(this.now)).toISOString();
    this.remember(record);
    this.updateState();
    try {
      const envelope = record.envelope;
      const formalTopology = this.formalTopology();
      if (formalTopology.stateVersion !== envelope.baseTopologyVersion) {
        throw new AppError("TOPOLOGY_VERSION_CONFLICT", "B 触发执行前正式拓扑已变化，请重新发起。", {
          status: 409,
          detail: { expected: formalTopology.stateVersion, received: envelope.baseTopologyVersion },
        });
      }
      if (envelope.sourceStateVersion !== null && this.state.snapshot?.stateVersion !== envelope.sourceStateVersion) {
        throw new AppError("SOURCE_VERSION_CONFLICT", "B 触发执行前研究来源已变化，请重新发起。", {
          status: 409,
          detail: { expected: this.state.snapshot?.stateVersion ?? null, received: envelope.sourceStateVersion },
        });
      }
      const result = await this.topologyCurator.preview({
        topology: formalTopology,
        events: selectedEvents,
        snapshot: this.state.snapshot,
        nodeIds: envelope.nodeIds,
        edgeIds: envelope.edgeIds,
        sourceRefs: envelope.sourceRefs,
        sessionId: envelope.sessionId,
        sourceStateVersion: envelope.sourceStateVersion,
        mode: envelope.mode,
        cause: envelope.cause,
        triggerId: record.id,
        fingerprint: record.fingerprint,
        locale: envelope.locale,
        operation: envelope.operation,
        context: {
          operation: envelope.operation,
          entryContext: envelope.entryContext,
          workingContext: envelope.workingContext,
          focus: envelope.focus,
          continuityContext: envelope.continuityContext,
          trigger: {
            mode: envelope.mode,
            cause: envelope.cause,
            triggerId: record.id,
            fingerprint: record.fingerprint,
          },
        },
      });
      const latestTopology = this.formalTopology();
      if (latestTopology.stateVersion !== envelope.baseTopologyVersion) {
        throw new AppError("TOPOLOGY_VERSION_CONFLICT", "B 运行期间正式拓扑已变化，候选结果已丢弃。", {
          status: 409,
          detail: { expected: latestTopology.stateVersion, received: envelope.baseTopologyVersion },
        });
      }
      if (envelope.sourceStateVersion !== null && this.state.snapshot?.stateVersion !== envelope.sourceStateVersion) {
        throw new AppError("SOURCE_VERSION_CONFLICT", "B 运行期间研究来源已变化，候选结果已丢弃。", {
          status: 409,
          detail: { expected: this.state.snapshot?.stateVersion ?? null, received: envelope.sourceStateVersion },
        });
      }
      this.state.setCuratorResult(result);
      // Curation is an advisory result. Only ResearchCommandService commits
      // scientific objects; the retired graph-patch approval path is gone.
      for (const eventId of selectedEvents.map((event) => event.id)) this.consumedEventIds.add(eventId);
      record.consumedAt = new Date(clockMs(this.now)).toISOString();
      record.status = "available";
      record.completedAt = new Date(clockMs(this.now)).toISOString();
      record.disposition = result.disposition;
      record.resultSummary = resultSummary(result);
      record.error = null;
      record.result = clone(result);
      this.status = "available";
      this.lastActivityAt = clockMs(this.now);
      this.cooldownUntil = this.settings.cooldownSeconds > 0
        ? new Date(clockMs(this.now) + this.settings.cooldownSeconds * 1_000).toISOString()
        : null;
      this.remember(record);
      this.updateState();
      return result;
    } catch (error) {
      record.status = "error";
      record.completedAt = new Date(clockMs(this.now)).toISOString();
      record.error = errorSummary(error);
      record.result = null;
      this.status = "error";
      this.remember(record);
      this.updateState();
      throw error;
    } finally {
      this.inFlight = null;
      this.lastActivityAt = clockMs(this.now);
      this.updateState();
    }
  }

  response(status: string, envelope: Partial<CuratorEnvelope>, fingerprint: string | null, result: TopologyCuratorResult | null, extra: ResponseExtra = {}) {
    return {
      schemaVersion: CURATOR_TRIGGER_RESULT_SCHEMA_VERSION,
      status,
      deduplicated: Boolean(extra.deduplicated),
      requiresConfirmation: Boolean(extra.requiresConfirmation),
      fingerprint,
      trigger: clone(envelope),
      result: result ? clone(result) : null,
      ...extra,
    };
  }

  skip(envelope: Partial<CuratorEnvelope>, fingerprint: string | null, reason: string, { update = true } = {}) {
    if (update) this.status = "skipped";
    this.updateState();
    return this.response("skipped", envelope, fingerprint, null, { reason });
  }

  remember(record: CuratorTriggerRecord) {
    const copy = clone(record);
    delete copy.result;
    this.records.set(record.fingerprint, record);
    this.history = [copy, ...this.history.filter((item) => item.fingerprint !== record.fingerprint)].slice(0, this.maxHistory);
    const retained = new Set(this.history.map((item) => item.fingerprint));
    for (const fingerprint of this.records.keys()) if (!retained.has(fingerprint)) this.records.delete(fingerprint);
    this.lastRecord = copy;
  }

  highValueCause(cause: string) {
    return ["experiment_delta", "source_delta", "continuity_break", "topology_changed"].includes(cause);
  }

  #automationSettings(settings: CuratorSettings): CuratorAutomation {
    const automation = settings?.curator?.automation ?? settings?.automation ?? {};
    const numeric = (value: unknown, fallback: number, minimum: number) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
    };
    return {
      enabled: Boolean(automation.enabled ?? false),
      triggerOnSessionCheckpoint: automation.triggerOnSessionCheckpoint !== false,
      triggerOnSourceDelta: automation.triggerOnSourceDelta !== false,
      triggerOnExperimentDelta: automation.triggerOnExperimentDelta !== false,
      triggerOnIdle: automation.triggerOnIdle !== false,
      triggerOnContinuityBreak: automation.triggerOnContinuityBreak !== false,
      triggerOnTopologyChanged: automation.triggerOnTopologyChanged === true,
      idleSeconds: numeric(automation.idleSeconds, 900, 30),
      minPendingEvents: Math.floor(numeric(automation.minPendingEvents, 3, 1)),
      cooldownSeconds: numeric(automation.cooldownSeconds, 300, 0),
      backgroundMode: automation.backgroundMode === "background" ? "background" : "suggested",
    };
  }

  updateState() {
    this.state.setCuratorTrigger?.(this.statusView());
  }
}

export { MODES as CURATOR_TRIGGER_MODES, CAUSES as CURATOR_TRIGGER_CAUSES };
