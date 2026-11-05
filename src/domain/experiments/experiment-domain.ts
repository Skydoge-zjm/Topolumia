import crypto from "node:crypto";
import { AppError } from "../../lib/errors.js";
import { capabilityProfileWithDetails } from "./experiment-provider.js";

export const EXPERIMENT_CONTEXT_SCHEMA = "experiment-agent-context.v1";
export const EXPERIMENT_INDEX_SCHEMA = "experiment-index.v1";
export const EXPERIMENT_DETAIL_SCHEMA = "experiment-detail.v1";
export const EXPERIMENT_SERIES_SCHEMA = "experiment-series.v1";

export const DEFAULT_MAX_POINTS = 240;
export const MAX_CONTEXT_RUNS = 8;
export const MAX_CONTEXT_METRICS = 8;
export const MAX_ARTIFACT_BYTES = 512 * 1024;

export const METRIC_ORDER = ["psnr", "ssim", "lpips", "fid", "loss", "val_loss", "accuracy"];

function metricIsLowerBetter(key) {
  const normalized = String(key ?? "").toLowerCase();
  const leaf = normalized.split(/[/.]/).at(-1);
  return leaf === "loss" || leaf === "lpips" || leaf === "fid" || normalized === "val_loss";
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function asKeyValueObject(value) {
  if (!value) return {};
  if (!Array.isArray(value)) return { ...value };
  return Object.fromEntries(value
    .filter((item) => item && item.key !== undefined)
    .map((item) => [String(item.key), item.value]));
}

const SENSITIVE_FIELD = /(token|secret|password|passwd|api[_-]?key|authorization|credential|private[_-]?key)/i;

export function redactSensitiveFields(value, depth = 0) {
  if (depth > 6) return "[nested value omitted]";
  if (Array.isArray(value)) return value.map((item) => redactSensitiveFields(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_FIELD.test(key) ? "[redacted]" : redactSensitiveFields(item, depth + 1),
  ]));
}

export function normalizeMetricHistory(value) {
  const result = {};
  if (!value) return result;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item) continue;
      if (item.key === undefined) {
        const x = numberOrNull(item.step ?? item.epoch ?? item.x) ?? 0;
        for (const [key, raw] of Object.entries(item)) {
          if (["step", "epoch", "x", "timestamp", "time", "_timestamp", "_step"].includes(key)) continue;
          const y = numberOrNull(raw?.value ?? raw);
          if (y === null) continue;
          result[key] ??= [];
          result[key].push({ x, y, timestamp: item.timestamp ?? item.time ?? item._timestamp ?? null });
        }
        continue;
      }
      const key = String(item.key);
      const points = Array.isArray(item.points) ? item.points : [item];
      result[key] ??= [];
      for (const point of points) {
        const y = numberOrNull(point.value ?? point.y);
        if (y === null) continue;
        result[key].push({
          x: numberOrNull(point.step ?? point.epoch ?? point.x) ?? result[key].length,
          y,
          timestamp: point.timestamp ?? point.time ?? null,
        });
      }
    }
  } else {
    for (const [key, points] of Object.entries(value)) {
      const list = Array.isArray(points) ? points : [];
      result[key] = list.flatMap((point, index) => {
        const y = numberOrNull(point?.value ?? point?.y ?? point);
        if (y === null) return [];
        return [{
          x: numberOrNull(point?.step ?? point?.epoch ?? point?.x) ?? index,
          y,
          timestamp: point?.timestamp ?? point?.time ?? null,
        }];
      });
    }
  }
  for (const [key, points] of Object.entries(result)) {
    points.sort((a, b) => a.x - b.x);
    result[key] = points;
  }
  return result;
}

export function latestMetricValues(value) {
  const history = normalizeMetricHistory(value);
  return Object.fromEntries(Object.entries(history)
    .filter(([, points]) => points.length)
    .map(([key, points]) => [key, points.at(-1).y]));
}

export function metricSummary(pointsOrHistory, metricValues = {}) {
  const history = normalizeMetricHistory(pointsOrHistory);
  const result = {};
  const keys = new Set([...Object.keys(history), ...Object.keys(metricValues ?? {})]);
  for (const key of keys) {
    const points = history[key] ?? [];
    const values = points.map((point) => point.y).filter(Number.isFinite);
    const latest = values.at(-1) ?? numberOrNull(metricValues?.[key]);
    if (latest === null || latest === undefined) continue;
    let min = latest;
    let max = latest;
    let sum = 0;
    for (const value of values) {
      if (value < min) min = value;
      if (value > max) max = value;
      sum += value;
    }
    const mean = values.length ? sum / values.length : latest;
    const best = metricIsLowerBetter(key) ? min : max;
    result[key] = {
      latest,
      best,
      min,
      max,
      mean,
      count: values.length || 1,
      first: values[0] ?? latest,
      lastStep: points.at(-1)?.x ?? null,
    };
  }
  return result;
}

/**
 * Reduces a series while retaining its first/last observations and local
 * extrema. The function intentionally returns plain points so existing
 * provider contracts remain compatible; normalizeSeries adds the strategy
 * metadata for callers that need to explain the reduction.
 */
export function downsamplePoints(points, maxPoints = DEFAULT_MAX_POINTS, { strategy = "extrema-bucket" } = {}) {
  const list = Array.isArray(points) ? points : [];
  const limit = Math.max(2, Math.min(2_000, Number(maxPoints) || DEFAULT_MAX_POINTS));
  if (list.length <= limit) return list.map((point) => ({ ...point }));

  if (strategy === "uniform") {
    const selected = [list[0]];
    const stride = (list.length - 1) / (limit - 1);
    for (let index = 1; index < limit - 1; index += 1) selected.push(list[Math.round(index * stride)]);
    selected.push(list.at(-1));
    return selected.map((point) => ({ ...point }));
  }

  const interiorBudget = limit - 2;
  const interior = list.slice(1, -1);
  const bucketCount = Math.max(1, Math.ceil(interiorBudget / 2));
  const candidates = [];
  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const start = Math.floor(bucketIndex * interior.length / bucketCount);
    const end = Math.max(start + 1, Math.floor((bucketIndex + 1) * interior.length / bucketCount));
    const bucket = interior.slice(start, end);
    if (!bucket.length) continue;
    let minIndex = 0;
    let maxIndex = 0;
    for (let index = 1; index < bucket.length; index += 1) {
      if (Number(bucket[index].y) < Number(bucket[minIndex].y)) minIndex = index;
      if (Number(bucket[index].y) > Number(bucket[maxIndex].y)) maxIndex = index;
    }
    const range = Math.abs(Number(bucket[maxIndex].y) - Number(bucket[minIndex].y));
    candidates.push({ index: start + minIndex + 1, range });
    if (maxIndex !== minIndex) candidates.push({ index: start + maxIndex + 1, range });
  }

  const unique = [...new Map(candidates.map((candidate) => [candidate.index, candidate])).values()];
  let selected = unique;
  if (selected.length > interiorBudget) {
    selected = [...selected]
      .sort((a, b) => b.range - a.range || a.index - b.index)
      .slice(0, interiorBudget);
  } else if (selected.length < interiorBudget) {
    const chosen = new Set(selected.map((candidate) => candidate.index));
    const stride = (list.length - 1) / (interiorBudget + 1);
    for (let index = 1; selected.length < interiorBudget && index <= interiorBudget; index += 1) {
      const candidateIndex = Math.max(1, Math.min(list.length - 2, Math.round(index * stride)));
      if (chosen.has(candidateIndex)) continue;
      chosen.add(candidateIndex);
      selected.push({ index: candidateIndex, range: 0 });
    }
  }
  selected.sort((a, b) => a.index - b.index);
  return [list[0], ...selected.map((candidate) => list[candidate.index]), list.at(-1)].map((point) => ({ ...point }));
}

export function normalizeSeries(history, { metricKeys = null, maxPoints = DEFAULT_MAX_POINTS } = {}) {
  const source = normalizeMetricHistory(history);
  const keys = Array.isArray(metricKeys) && metricKeys.length
    ? metricKeys.map(String).filter((key) => Object.hasOwn(source, key))
    : Object.keys(source).sort((a, b) => {
      const ai = METRIC_ORDER.indexOf(a);
      const bi = METRIC_ORDER.indexOf(b);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.localeCompare(b);
    });
  return keys.map((key) => {
    const points = source[key] ?? [];
    const sampled = downsamplePoints(points, maxPoints);
    return {
      key,
      displayName: key,
      xKey: "step",
      points: sampled,
      pointCount: points.length,
      returnedPointCount: sampled.length,
      downsampled: sampled.length < points.length,
      aggregation: sampled.length < points.length ? "extrema-bucket" : "none",
      missing: points.length === 0,
      higherIsBetter: !metricIsLowerBetter(key),
    };
  });
}

export function parseExperimentRef(ref) {
  const value = String(ref ?? "");
  const match = value.match(/^([a-z0-9_-]+):run:(.+)$/i);
  if (!match) {
    throw new AppError("EXPERIMENT_REF_INVALID", "实验引用格式无效。", { status: 422, detail: { ref: value } });
  }
  return { provider: match[1].toLowerCase(), externalId: match[2], ref: value };
}

export function stableRunRef(provider, externalId) {
  return `${String(provider).toLowerCase()}:run:${String(externalId)}`;
}

export function normalizeRun(run, {
  provider,
  sourceStatus = "ready",
  mode = "fixture",
  capabilityProfile = {},
  observedAt = new Date().toISOString(),
} = {}) {
  const value = asObject(run);
  const capabilities = capabilityProfileWithDetails(
    { ...capabilityProfile, ...(value.capabilityProfile ?? {}) },
    value.capabilityDetails ?? value.capabilities,
  );
  const externalId = String(value.externalId ?? value.runId ?? value.id ?? "");
  const history = normalizeMetricHistory(value.metricHistory ?? value.history ?? value.series);
  const metrics = { ...latestMetricValues(history), ...asObject(value.metrics) };
  return {
    ...value,
    ref: value.ref ?? stableRunRef(provider, externalId),
    provider,
    externalId,
    sourceStatus,
    mode,
    observedAt: value.observedAt ?? observedAt,
    metrics,
    metricSummary: value.metricSummary ?? metricSummary(history, metrics),
    metricHistory: history,
    ...capabilities,
    params: redactSensitiveFields(asObject(value.params)),
    tags: redactSensitiveFields(asObject(value.tags)),
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
    inputs: Array.isArray(value.inputs) ? value.inputs : [],
  };
}

export function sanitizeSvg(svg) {
  return String(svg ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/(?:href|xlink:href)\s*=\s*["']https?:[^"']*["']/gi, "");
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Generates a small self-contained, script-free SVG suitable for multimodal agents. */
export function renderMetricChart(runs, { metricKeys = null, maxPoints = DEFAULT_MAX_POINTS, width = 760, height = 360 } = {}) {
  const list = Array.isArray(runs) ? runs : [];
  const series = list.flatMap((run) => normalizeSeries(run.metricHistory ?? run.series, {
    metricKeys,
    maxPoints,
  }).map((item) => ({ ...item, runRef: run.ref, label: run.label ?? run.externalId })));
  const groups = [...new Set(series.map((item) => item.key))].map((key) => ({ key, lines: series.filter((item) => item.key === key) }));
  const colors = ["#197f70", "#7565d3", "#bd6b42", "#4f79ca", "#9a69ad", "#ac7f3e"];
  const rowHeight = 148;
  const chartHeight = Math.max(rowHeight, rowHeight * groups.length);
  const pad = { left: 56, right: 18, top: 30, bottom: 26 };
  const innerWidth = width - pad.left - pad.right;
  const rows = groups.map((group, rowIndex) => {
    const rowTop = rowIndex * rowHeight;
    const innerHeight = rowHeight - pad.top - pad.bottom;
    const points = group.lines.flatMap((item) => item.points);
    const allX = points.map((point) => point.x);
    const allY = points.map((point) => point.y);
    const minX = allX.length ? Math.min(...allX) : 0;
    const maxX = allX.length ? Math.max(...allX) : 1;
    const minY = allY.length ? Math.min(...allY) : 0;
    const maxY = allY.length ? Math.max(...allY) : 1;
    const x = (value) => pad.left + ((value - minX) / Math.max(1e-9, maxX - minX)) * innerWidth;
    const y = (value) => rowTop + pad.top + innerHeight - ((value - minY) / Math.max(1e-9, maxY - minY)) * innerHeight;
    const grid = [0, 0.5, 1].map((ratio) => {
      const yy = rowTop + pad.top + ratio * innerHeight;
      const value = maxY - ratio * (maxY - minY);
      return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${yy.toFixed(2)}" y2="${yy.toFixed(2)}" stroke="#d7ddd7" stroke-width="1"/><text x="${pad.left - 8}" y="${yy + 4}" text-anchor="end" fill="#6d7973" font-size="11">${escapeXml(value.toFixed(3))}</text>`;
    }).join("");
    const paths = group.lines.map((item, lineIndex) => {
      const d = item.points.map((point, pointIndex) => `${pointIndex ? "L" : "M"}${x(point.x).toFixed(2)} ${y(point.y).toFixed(2)}`).join(" ");
      const color = colors[(rowIndex + lineIndex) % colors.length];
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"><title>${escapeXml(item.label)} · ${escapeXml(item.key)}</title></path><circle cx="${pad.left + 10 + lineIndex * 190}" cy="${rowTop + 16}" r="4" fill="${color}"/><text x="${pad.left + 20 + lineIndex * 190}" y="${rowTop + 20}" fill="#4e5c56" font-size="11">${escapeXml(item.label)}</text>`;
    }).join("");
    return `<text x="${pad.left}" y="${rowTop + 14}" fill="#14201c" font-size="11" font-weight="700">${escapeXml(group.key)}</text>${grid}<line x1="${pad.left}" x2="${pad.left}" y1="${rowTop + pad.top}" y2="${rowTop + rowHeight - pad.bottom}" stroke="#9da69f"/><line x1="${pad.left}" x2="${width - pad.right}" y1="${rowTop + rowHeight - pad.bottom}" y2="${rowTop + rowHeight - pad.bottom}" stroke="#9da69f"/>${paths}`;
  }).join("");
  const title = `Metric history · ${list.length} run${list.length === 1 ? "" : "s"}`;
  return sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(title)}" viewBox="0 0 ${width} ${chartHeight}" width="${width}" height="${chartHeight}"><rect width="100%" height="100%" fill="#fbfaf5"/><text x="${pad.left}" y="${chartHeight - 8}" fill="#6d7973" font-size="11">step</text>${rows}</svg>`);
}

export function svgDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(sanitizeSvg(svg), "utf8").toString("base64")}`;
}

export function hashLocator(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function validateExperimentQuery({ maxPoints = DEFAULT_MAX_POINTS, metrics = [] } = {}) {
  const parsedMax = Number(maxPoints);
  if (!Number.isInteger(parsedMax) || parsedMax < 2 || parsedMax > 2_000) {
    throw new AppError("EXPERIMENT_QUERY_TOO_LARGE", "曲线点数必须在 2 到 2000 之间。", { status: 422, detail: { maxPoints } });
  }
  if (!Array.isArray(metrics) || metrics.length > MAX_CONTEXT_METRICS) {
    throw new AppError("EXPERIMENT_QUERY_TOO_LARGE", "一次最多请求 8 个指标。", { status: 422 });
  }
  return { maxPoints: parsedMax, metrics: metrics.map(String).filter(Boolean) };
}
