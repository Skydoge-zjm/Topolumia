import crypto from "node:crypto";
import { AppError } from "../../lib/errors.js";

export const METRIC_EVENT_SCHEMA = "metric-event.v1";
export const METRIC_INGESTION_SCHEMA = "metric-ingestion.v1";

const RUN_REF_PATTERN = /^[a-z0-9_-]+:run:.+$/i;

function finiteNumber(value, field, { min = -Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) {
    throw new AppError("METRIC_EVENT_INVALID", `${field} 必须是有限数字。`, {
      status: 422,
      detail: { field, value },
    });
  }
  return number;
}

function optionalTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new AppError("METRIC_EVENT_INVALID", "timestamp 不是有效时间。", {
      status: 422,
      detail: { field: "timestamp", value },
    });
  }
  return date.toISOString();
}

function stableEventDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

export function validateRunRef(value) {
  const ref = String(value ?? "").trim();
  if (!RUN_REF_PATTERN.test(ref)) {
    throw new AppError("METRIC_RUN_REF_INVALID", "runRef 必须是带 provider 前缀的稳定引用。", {
      status: 422,
      detail: { runRef: value },
    });
  }
  return ref;
}

export function providerFromRunRef(ref) {
  return validateRunRef(ref).split(":", 1)[0].toLowerCase();
}

export function normalizeMetricEvent(raw, {
  runRef: defaultRunRef = null,
  source = "unknown",
  clock = () => new Date(),
} = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError("METRIC_EVENT_INVALID", "指标事件必须是对象。", { status: 422 });
  }
  const runRef = validateRunRef(raw.runRef ?? defaultRunRef);
  const metric = String(raw.metric ?? raw.key ?? "").trim();
  if (!metric || metric.length > 160) {
    throw new AppError("METRIC_EVENT_INVALID", "metric 名称不能为空且不能超过 160 个字符。", {
      status: 422,
      detail: { metric },
    });
  }
  const step = finiteNumber(raw.step ?? raw.epoch ?? raw.x, "step", { min: 0 });
  const value = finiteNumber(raw.value ?? raw.y, "value");
  const timestamp = optionalTimestamp(raw.timestamp ?? raw.time ?? raw._timestamp);
  const currentTime = clock();
  const fallbackTimestamp = currentTime instanceof Date ? currentTime.toISOString() : new Date(currentTime).toISOString();
  const normalized = {
    schemaVersion: METRIC_EVENT_SCHEMA,
    runRef,
    metric,
    value,
    step,
    timestamp: timestamp ?? fallbackTimestamp,
    phase: raw.phase === undefined || raw.phase === null ? null : String(raw.phase).slice(0, 80),
    split: raw.split === undefined || raw.split === null ? null : String(raw.split).slice(0, 80),
    unit: raw.unit === undefined || raw.unit === null ? null : String(raw.unit).slice(0, 40),
    source: String(raw.source ?? source ?? "unknown").slice(0, 120),
  };
  const digestInput = {
    runRef: normalized.runRef,
    metric: normalized.metric,
    step: normalized.step,
    timestamp: normalized.timestamp,
    value: normalized.value,
    phase: normalized.phase,
    split: normalized.split,
  };
  // A missing timestamp is filled from the clock for display, but must not
  // make an otherwise identical event receive a different id on retry.
  if (timestamp === null) delete digestInput.timestamp;
  normalized.eventId = String(raw.eventId ?? stableEventDigest(digestInput)).slice(0, 200);
  return normalized;
}

export function validateMetricBatch(events, { maxEvents = 300_000 } = {}) {
  if (!Array.isArray(events)) {
    throw new AppError("METRIC_BATCH_INVALID", "events 必须是数组。", { status: 422 });
  }
  if (events.length > maxEvents) {
    throw new AppError("METRIC_BATCH_TOO_LARGE", `单批最多接收 ${maxEvents} 个指标事件。`, {
      status: 422,
      detail: { count: events.length, maxEvents },
    });
  }
  return events;
}
