import { AppError } from "../../lib/errors.js";

export const RESEARCH_EXPERIMENT_SCHEMA = "research-experiment.v1";
export const RESEARCH_EXPERIMENT_INDEX_SCHEMA = "research-experiment-index.v1";
export const RESEARCH_EXPERIMENT_DETAIL_SCHEMA = "research-experiment-detail.v1";
export const RESEARCH_EXPERIMENT_CONTEXT_SCHEMA = "research-experiment-agent-context.v1";

const bilingual = (zh, en) => ({ zh, en });

/**
 * The catalog is authored research intent, not a tracker mirror. Tracker runs
 * join it only through an explicit group identifier; their raw state remains
 * owned by the provider adapters.
 */
export const RESEARCH_EXPERIMENT_CATALOG = Object.freeze([
  {
    id: "g0",
    code: "G0",
    status: "needs_evidence",
    label: bilingual("SR3 baseline", "SR3 baseline"),
    summary: bilingual(
      "复现基线：不使用 degradation conditioning，保留 baseline noise schedule。",
      "Reproduction baseline: no degradation conditioning and the baseline noise schedule.",
    ),
    purpose: bilingual(
      "建立可比较的 SR3 ×4 超分基线。",
      "Establish a comparable SR3 ×4 super-resolution baseline.",
    ),
    design: { conditioning: "off", noise_schedule: "baseline", dataset: "DIV2K-valid-x4", sampler_steps: "50" },
    controls: [
      bilingual("DIV2K-valid-x4 数据划分", "DIV2K-valid-x4 split"),
      bilingual("checkpoint step 50000", "checkpoint step 50000"),
      bilingual("使用同一 evaluator", "same evaluator"),
    ],
    limitations: [bilingual("缺少逐图像 metric artifact。", "Per-image metric artifacts are missing.")],
    authoredAttempts: [],
  },
  {
    id: "g1",
    code: "G1",
    status: "needs_evidence",
    label: bilingual("加入 degradation encoder", "Add degradation encoder"),
    summary: bilingual(
      "只改变 degradation conditioning；用于检验感知指标是否改善。",
      "Change only degradation conditioning to test whether perceptual metrics improve.",
    ),
    purpose: bilingual(
      "在 G0 基线上测试 degradation-aware conditioning 的影响。",
      "Test degradation-aware conditioning against the G0 baseline.",
    ),
    design: { conditioning: "degradation_encoder", noise_schedule: "baseline", dataset: "DIV2K-valid-x4", sampler_steps: "50" },
    controls: [
      bilingual("沿用 G0 数据集与划分", "G0 dataset and split"),
      bilingual("checkpoint step 50000", "checkpoint step 50000"),
      bilingual("baseline noise schedule", "baseline noise schedule"),
      bilingual("使用同一 evaluator", "same evaluator"),
    ],
    limitations: [bilingual("evaluator package version 与 LPIPS backbone 尚未归档。", "Evaluator package version and LPIPS backbone are not archived.")],
    authoredAttempts: [
      {
        id: "g1-oom",
        ref: "research:attempt:g1-oom",
        sequence: 1,
        label: bilingual("Attempt 01 · CUDA OOM", "Attempt 01 · CUDA OOM"),
        status: "FAILED",
        attemptRole: "failed",
        failure: bilingual("batch=8 在 step 18,240 触发 CUDA out of memory。", "batch=8 hit CUDA out of memory at step 18,240."),
        params: { batch_size: "8", stop_step: "18240", gradient_accumulation: "not recorded" },
      },
      {
        id: "g1-unstable",
        ref: "research:attempt:g1-unstable",
        sequence: 2,
        label: bilingual("Attempt 02 · 训练不稳定", "Attempt 02 · Training unstable"),
        status: "UNSTABLE",
        attemptRole: "unstable",
        failure: bilingual("恢复训练后 validation loss 持续振荡，未进入比较集。", "Validation loss kept oscillating after resume; this attempt was excluded from comparison."),
        params: { batch_size: "4", resume: "yes", stop_reason: "unstable validation loss" },
      },
    ],
  },
  {
    id: "g2",
    code: "G2",
    status: "needs_evidence",
    label: bilingual("conditioning + corrected schedule", "Conditioning + corrected schedule"),
    summary: bilingual(
      "保留 degradation encoder，切换至 logSNR-corrected noise schedule。",
      "Keep the degradation encoder and switch to a logSNR-corrected noise schedule.",
    ),
    purpose: bilingual(
      "检验 schedule 是否能恢复 G1 的像素保真，同时保留感知收益。",
      "Test whether the schedule recovers G1 pixel fidelity while retaining perceptual benefit.",
    ),
    design: { conditioning: "degradation_encoder", noise_schedule: "logsnr-corrected", dataset: "DIV2K-valid-x4", sampler_steps: "50" },
    controls: [
      bilingual("沿用 G1 degradation encoder", "G1 degradation encoder"),
      bilingual("DIV2K-valid-x4 数据划分", "DIV2K-valid-x4 split"),
      bilingual("checkpoint step 50000", "checkpoint step 50000"),
      bilingual("使用同一 evaluator", "same evaluator"),
    ],
    limitations: [bilingual("conditioning 与 schedule 仍未形成完整因子设计。", "Conditioning and schedule are not yet a complete factorial design.")],
    authoredAttempts: [],
  },
  {
    id: "g3",
    code: "G3",
    status: "proposed",
    label: bilingual("2×2×3 区分实验", "2×2×3 distinguishing experiment"),
    summary: bilingual(
      "用 conditioning × schedule × seeds 区分主效应、交互与 seed 方差。",
      "Use conditioning × schedule × seeds to distinguish main effects, interactions, and seed variance.",
    ),
    purpose: bilingual(
      "分离 conditioning、corrected schedule 与随机种子方差的影响。",
      "Separate conditioning, corrected-schedule, and random-seed effects.",
    ),
    design: { conditioning: "off|on", noise_schedule: "baseline|logsnr-corrected", seeds: "13|42|73", dataset: "DIV2K-valid-x4", sampler_steps: "50" },
    controls: [
      bilingual("使用同一 checkpoint", "same checkpoint"),
      bilingual("使用同一数据划分", "same split"),
      bilingual("使用同一 evaluator", "same evaluator"),
      bilingual("保留逐图像指标", "per-image metrics"),
    ],
    limitations: [bilingual("缺失 conditioning=off + corrected 的对照 cell。", "The conditioning=off + corrected control cell is still missing.")],
    authoredAttempts: [
      {
        id: "g3-missing-cell",
        ref: "research:attempt:g3-missing-cell",
        sequence: 1,
        label: bilingual("待运行 cell · conditioning off + corrected", "Planned cell · conditioning off + corrected"),
        status: "PLANNED",
        attemptRole: "planned",
        failure: null,
        params: { conditioning: "none", noise_schedule: "logsnr-corrected", seeds: "13,42,73" },
      },
    ],
  },
]);

function clone(value) {
  return structuredClone(value);
}

function toText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normaliseGroup(value) {
  const source = String(value ?? "").trim().toUpperCase();
  const match = source.match(/^G\s*([0-9]+)$/);
  return match ? `G${match[1]}` : source;
}

export function experimentGroupForRun(run = {}) {
  return normaliseGroup(
    run.group
    ?? run.params?.group
    ?? run.tags?.["research.group"]
    ?? run.tags?.group
    ?? null,
  );
}

export function snapshotRuns(snapshot = null) {
  const candidates = [
    ...(snapshot?.mlflow?.runs ?? []),
    ...(snapshot?.experiments?.wandb?.runs ?? []),
    ...(snapshot?.experiments?.tensorboard?.runs ?? []),
    ...(snapshot?.experiments?.simulation?.runs ?? []),
  ].filter((item) => item && typeof item === "object");
  const refs = new Set();
  return candidates.filter((item) => {
    const ref = String(item.ref ?? "");
    if (!ref || refs.has(ref)) return false;
    refs.add(ref);
    return true;
  });
}

function attemptRole(status, fallback = "observed") {
  const normalized = String(status ?? "").toUpperCase();
  if (["FINISHED", "COMPLETED", "SUCCESS"].includes(normalized)) return "completed";
  if (["FAILED", "KILLED", "CANCELLED", "CANCELED", "ERROR"].includes(normalized)) return "failed";
  if (["UNSTABLE", "DIVERGED", "DEGRADED"].includes(normalized)) return "unstable";
  if (["RUNNING", "SCHEDULED", "QUEUED"].includes(normalized)) return "running";
  if (["PLANNED", "PROPOSED"].includes(normalized)) return "planned";
  return fallback;
}

function compactMetrics(value = {}) {
  return Object.fromEntries(Object.entries(value ?? {})
    .filter(([, item]) => Number.isFinite(Number(item)))
    .slice(0, 24)
    .map(([key, item]) => [key, Number(item)]));
}

function compactMetricSummary(value = {}) {
  return Object.fromEntries(Object.entries(value ?? {})
    .slice(0, 24)
    .map(([key, item]) => [key, {
      latest: Number.isFinite(Number(item?.latest)) ? Number(item.latest) : null,
      best: Number.isFinite(Number(item?.best)) ? Number(item.best) : null,
      count: Number.isFinite(Number(item?.count)) ? Number(item.count) : null,
      lastStep: Number.isFinite(Number(item?.lastStep)) ? Number(item.lastStep) : null,
    }]));
}

function providerAttempt(run, index) {
  const role = attemptRole(run.status);
  return {
    id: String(run.externalId ?? run.ref ?? `provider-${index}`),
    ref: String(run.ref),
    sequence: 100 + index,
    source: "provider",
    provider: run.provider ?? null,
    label: run.label ?? run.externalId ?? run.ref,
    status: run.status ?? "UNKNOWN",
    attemptRole: role,
    failure: run.errorMessage ? String(run.errorMessage).slice(0, 800) : null,
    params: clone(run.params ?? {}),
    metrics: compactMetrics(run.metrics),
    metricSummary: compactMetricSummary(run.metricSummary),
    artifactCount: Array.isArray(run.artifacts) ? run.artifacts.length : Number(run.artifactCount ?? 0),
    startedAt: run.startedAt ?? null,
    endedAt: run.endedAt ?? null,
    observedAt: run.observedAt ?? null,
    mode: run.mode ?? null,
    sourceStatus: run.sourceStatus ?? "unknown",
  };
}

function authoredAttempt(attempt) {
  return {
    id: attempt.id,
    ref: attempt.ref,
    sequence: attempt.sequence ?? 0,
    source: "authored",
    provider: null,
    label: clone(attempt.label),
    status: attempt.status,
    attemptRole: attempt.attemptRole ?? attemptRole(attempt.status),
    failure: attempt.failure ? clone(attempt.failure) : null,
    params: clone(attempt.params ?? {}),
    metrics: {},
    metricSummary: {},
    artifactCount: 0,
    startedAt: null,
    endedAt: null,
    observedAt: null,
    mode: "authored",
    sourceStatus: "authored",
  };
}

function statusSummary(attempts) {
  const result = {
    total: attempts.length,
    completed: 0,
    failed: 0,
    unstable: 0,
    running: 0,
    planned: 0,
    observed: 0,
  };
  for (const attempt of attempts) {
    const role = attempt.attemptRole ?? "observed";
    if (Object.hasOwn(result, role)) result[role] += 1;
    else result.observed += 1;
  }
  return result;
}

function experimentStatus(summary, declaredStatus) {
  if (summary.completed > 0 && (summary.failed > 0 || summary.unstable > 0)) return "mixed";
  if (summary.completed > 0) return "completed";
  if (summary.running > 0) return "running";
  if (summary.failed > 0 || summary.unstable > 0) return "failed";
  if (summary.planned > 0) return declaredStatus === "proposed" ? "proposed" : "planned";
  return declaredStatus ?? "needs_evidence";
}

const METRIC_ALIASES = Object.freeze({
  psnr: ["psnr", "eval/psnr"],
  ssim: ["ssim", "eval/ssim"],
  lpips: ["lpips", "eval/lpips"],
  fid: ["fid", "eval/fid"],
});

function keyMetrics(attempts) {
  const preferred = [...attempts]
    .filter((attempt) => attempt.attemptRole === "completed" && Object.keys(attempt.metrics ?? {}).length)
    .sort((a, b) => String(b.observedAt ?? b.endedAt ?? "").localeCompare(String(a.observedAt ?? a.endedAt ?? "")));
  const source = preferred[0]?.metrics ?? {};
  const result = {};
  for (const [key, aliases] of Object.entries(METRIC_ALIASES)) {
    const found = aliases.find((alias) => Number.isFinite(Number(source[alias])));
    if (found) result[key] = Number(source[found]);
  }
  return result;
}

function keyMetricSummary(attempts) {
  const preferred = [...attempts]
    .filter((attempt) => attempt.attemptRole === "completed" && Object.keys(attempt.metricSummary ?? {}).length)
    .sort((a, b) => String(b.observedAt ?? b.endedAt ?? "").localeCompare(String(a.observedAt ?? a.endedAt ?? "")));
  const source = preferred[0]?.metricSummary ?? {};
  const result = {};
  for (const [key, aliases] of Object.entries(METRIC_ALIASES)) {
    const found = aliases.find((alias) => source[alias]);
    if (found) result[key] = clone(source[found]);
  }
  return result;
}

function statusSentence(summary, locale) {
  if (locale === "en") {
    const pieces = [`${summary.total} attempt${summary.total === 1 ? "" : "s"}`];
    if (summary.completed) pieces.push(`${summary.completed} completed`);
    if (summary.failed) pieces.push(`${summary.failed} failed`);
    if (summary.unstable) pieces.push(`${summary.unstable} unstable`);
    if (summary.running) pieces.push(`${summary.running} running`);
    if (summary.planned) pieces.push(`${summary.planned} planned`);
    return pieces.join(" · ");
  }
  const pieces = [`${summary.total} 次尝试`];
  if (summary.completed) pieces.push(`${summary.completed} 次完成`);
  if (summary.failed) pieces.push(`${summary.failed} 次失败`);
  if (summary.unstable) pieces.push(`${summary.unstable} 次不稳定`);
  if (summary.running) pieces.push(`${summary.running} 次运行中`);
  if (summary.planned) pieces.push(`${summary.planned} 次计划中`);
  return pieces.join(" · ");
}

function definitionFor(value) {
  const id = String(value ?? "").trim().toLowerCase();
  const definition = RESEARCH_EXPERIMENT_CATALOG.find((item) => item.id === id || item.code.toLowerCase() === id);
  if (!definition) {
    throw new AppError("RESEARCH_EXPERIMENT_NOT_FOUND", "没有找到该科研实验。", { status: 404, detail: { experimentId: value } });
  }
  return definition;
}

function buildExperiment(definition, runs = []) {
  const external = runs
    .filter((run) => experimentGroupForRun(run) === definition.code)
    .map((run, index) => providerAttempt(run, index));
  const attempts = [
    ...definition.authoredAttempts.map(authoredAttempt),
    ...external,
  ].sort((a, b) => a.sequence - b.sequence || String(a.label?.zh ?? a.label).localeCompare(String(b.label?.zh ?? b.label)));
  const runSummary = statusSummary(attempts);
  const status = experimentStatus(runSummary, definition.status);
  const metrics = keyMetrics(attempts);
  const metricSummary = keyMetricSummary(attempts);
  const summary = {
    schemaVersion: RESEARCH_EXPERIMENT_SCHEMA,
    id: definition.id,
    code: definition.code,
    kind: "experiment",
    status,
    label: clone(definition.label),
    summary: {
      zh: `${definition.summary.zh} ${statusSentence(runSummary, "zh")}。`,
      en: `${definition.summary.en} ${statusSentence(runSummary, "en")}.`,
    },
    purpose: clone(definition.purpose),
    design: clone(definition.design),
    controls: clone(definition.controls),
    limitations: clone(definition.limitations),
    runSummary,
    keyMetrics: metrics,
    metricSummary,
    attemptSourceCount: external.length,
    detailRef: `research:experiment:${definition.id}`,
    sourceRefs: external.map((attempt) => attempt.ref),
  };
  return { summary, attempts };
}

export function aggregateResearchExperiments(snapshot = null) {
  const runs = snapshotRuns(snapshot);
  const records = RESEARCH_EXPERIMENT_CATALOG.map((definition) => buildExperiment(definition, runs));
  const knownGroups = new Set(RESEARCH_EXPERIMENT_CATALOG.map((item) => item.code));
  const unassignedRuns = runs.filter((run) => !knownGroups.has(experimentGroupForRun(run)));
  return {
    schemaVersion: RESEARCH_EXPERIMENT_INDEX_SCHEMA,
    observedAt: snapshot?.observedAt ?? null,
    items: records.map((record) => record.summary),
    records,
    unassignedRuns: unassignedRuns.map((run, index) => providerAttempt(run, index)),
  };
}

export function researchExperimentRecord(experimentId, snapshot = null) {
  const definition = definitionFor(experimentId);
  const runs = snapshotRuns(snapshot);
  return buildExperiment(definition, runs);
}

export function providerAttemptRefs(record) {
  return record.attempts.filter((attempt) => attempt.source === "provider" && attempt.ref).map((attempt) => attempt.ref);
}

export function researchExperimentNodeData(summary) {
  return {
    experimentId: summary.id,
    purpose: clone(summary.purpose),
    design: clone(summary.design),
    runSummary: clone(summary.runSummary),
    keyMetrics: clone(summary.keyMetrics),
    metricSummary: clone(summary.metricSummary),
    limitationCount: summary.limitations.length,
    attemptSourceCount: summary.attemptSourceCount,
    detailRef: summary.detailRef,
  };
}

export function compactResearchExperiment(summary) {
  const {
    sourceRefs: _sourceRefs,
    controls: _controls,
    limitations: _limitations,
    ...compact
  } = summary;
  return clone(compact);
}
