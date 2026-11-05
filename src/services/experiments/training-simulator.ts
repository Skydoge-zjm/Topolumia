import { AppError } from "../../lib/errors.js";
import { summarizeIngestedRun } from "./metric-ingestion-store.js";

const DEFAULTS = Object.freeze({
  totalSteps: 50_000,
  logEvery: 100,
  batchSteps: 500,
  seed: 42,
  // Direct calls to createTrainingSimulation are also used for deterministic
  // contract tests and fixture generation. The service layer replaces this
  // with its wall-clock start time when a run is launched from the API.
  startedAt: "2026-01-01T00:00:00.000Z",
  group: "G1",
  runId: "sr3-g1-seed42",
  conditioning: "degradation_encoder",
  noiseSchedule: "baseline",
  dataset: "DIV2K-valid-x4",
});

function finiteInteger(value, fallback, { min, max }) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError("SIMULATION_INPUT_INVALID", `模拟参数必须是 ${min} 到 ${max} 之间的整数。`, {
      status: 422,
      detail: { value, min, max },
    });
  }
  return parsed;
}

function boundedId(value, fallback) {
  const id = String(value ?? fallback).trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id || id.length > 120) throw new AppError("SIMULATION_INPUT_INVALID", "runId 不能为空且长度不能超过 120。", { status: 422 });
  return id;
}

function normalizeStartedAt(value) {
  const date = new Date(value ?? DEFAULTS.startedAt);
  if (Number.isNaN(date.getTime())) {
    throw new AppError("SIMULATION_INPUT_INVALID", "startedAt 必须是有效时间。", { status: 422, detail: { value } });
  }
  return date.toISOString();
}

function noise(seed, step, metric) {
  let hash = Number(seed) * 12.9898 + step * 78.233;
  for (const character of metric) hash = (hash * 31 + character.charCodeAt(0)) % 1_000_003;
  const value = Math.sin(hash) * 43_758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function metricValues({ step, totalSteps, seed, conditioning, noiseSchedule }) {
  const progress = step / totalSteps;
  const convergence = 1 - Math.exp(-step / Math.max(1, totalSteps * 0.23));
  const overfit = Math.max(0, (progress - 0.82) / 0.18);
  const conditioningOn = conditioning !== "none";
  const correctedSchedule = noiseSchedule !== "baseline";
  const conditionGain = conditioningOn ? 0.16 * convergence : 0;
  const scheduleGain = correctedSchedule ? 0.24 * progress : 0;
  const trainNoise = noise(seed, step, "train/loss");
  const valNoise = noise(seed, step, "val/loss");
  const psnrNoise = noise(seed, step, "eval/psnr");
  const lpipsNoise = noise(seed, step, "eval/lpips");
  const ssimNoise = noise(seed, step, "eval/ssim");
  const warmup = Math.min(1, step / Math.max(1, Math.min(1_000, totalSteps * 0.04)));
  const cosine = 0.5 * (1 + Math.cos(Math.PI * progress));
  return {
    "train/loss": clamp(1.32 * Math.exp(-step / Math.max(1, totalSteps * 0.22)) + 0.075 + trainNoise * 0.012, 0.04, 2),
    "val/loss": clamp(1.38 * Math.exp(-step / Math.max(1, totalSteps * 0.24)) + 0.14 + overfit * 0.18 + valNoise * 0.016, 0.06, 2),
    "eval/psnr": clamp(22.1 + 5.05 * convergence + conditionGain + scheduleGain - overfit * 0.18 + psnrNoise * 0.035, 20, 35),
    "eval/lpips": clamp(0.48 - 0.275 * convergence - conditionGain * 0.055 - scheduleGain * 0.012 + overfit * 0.018 + lpipsNoise * 0.0025, 0.05, 0.7),
    "eval/ssim": clamp(0.60 + 0.185 * convergence + conditionGain * 0.012 + scheduleGain * 0.008 - overfit * 0.008 + ssimNoise * 0.0015, 0.4, 0.95),
    "train/learning_rate": 2e-4 * (warmup < 1 ? warmup : cosine),
    "system/throughput": clamp(7.8 - progress * 0.35 + noise(seed, step, "system/throughput") * 0.12, 5, 10),
    "system/gpu_memory": clamp(17.2 + progress * 0.6 + noise(seed, step, "system/gpu_memory") * 0.08, 16, 20),
  };
}

function metricMeta(metric) {
  const map = {
    "eval/psnr": { phase: "validation", split: "test", unit: "dB" },
    "eval/lpips": { phase: "validation", split: "test", unit: null },
    "eval/ssim": { phase: "validation", split: "test", unit: null },
    "val/loss": { phase: "validation", split: "val", unit: null },
    "train/loss": { phase: "train", split: "train", unit: null },
    "train/learning_rate": { phase: "train", split: "train", unit: "per-step" },
    "system/throughput": { phase: "train", split: null, unit: "it/s" },
    "system/gpu_memory": { phase: "train", split: null, unit: "GiB" },
  };
  return map[metric] ?? { phase: null, split: null, unit: null };
}

function normalizeOptions(options = {}) {
  const totalSteps = finiteInteger(options.totalSteps, DEFAULTS.totalSteps, { min: 10, max: 100_000 });
  const logEvery = finiteInteger(options.logEvery, DEFAULTS.logEvery, { min: 1, max: totalSteps });
  const batchSteps = finiteInteger(options.batchSteps, DEFAULTS.batchSteps, { min: 1, max: 10_000 });
  const seed = finiteInteger(options.seed, DEFAULTS.seed, { min: 0, max: 1_000_000_000 });
  const runId = boundedId(options.runId, DEFAULTS.runId);
  const group = boundedId(options.group, DEFAULTS.group);
  const conditioning = String(options.conditioning ?? DEFAULTS.conditioning);
  const noiseSchedule = String(options.noiseSchedule ?? options.noise_schedule ?? DEFAULTS.noiseSchedule);
  const dataset = String(options.dataset ?? DEFAULTS.dataset);
  const runRef = String(options.runRef ?? `simulation:run:${runId}`);
  if (!/^[a-z0-9_-]+:run:.+$/i.test(runRef)) throw new AppError("SIMULATION_INPUT_INVALID", "runRef 格式无效。", { status: 422 });
  return { totalSteps, logEvery, batchSteps, seed, runId, group, conditioning, noiseSchedule, dataset, runRef };
}

function stepList(totalSteps, logEvery) {
  const steps = [];
  for (let step = 0; step <= totalSteps; step += logEvery) steps.push(step);
  if (steps.at(-1) !== totalSteps) steps.push(totalSteps);
  return steps;
}

export function createTrainingSimulation(options = {}) {
  const config = normalizeOptions(options);
  const startedAt = normalizeStartedAt(options.startedAt);
  const run = {
    ref: config.runRef,
    label: options.label ?? `${config.group} · simulated training · seed ${config.seed}`,
    group: config.group,
    status: "RUNNING",
    startedAt,
    params: {
      group: config.group,
      seed: String(config.seed),
      conditioning: config.conditioning,
      noise_schedule: config.noiseSchedule,
      dataset: config.dataset,
      total_steps: String(config.totalSteps),
      log_every: String(config.logEvery),
    },
    tags: {
      "research.group": config.group,
      "research.mode": "simulation",
      "research.source": "workbench-training-simulator",
    },
  };
  const steps = stepList(config.totalSteps, config.logEvery);
  const metrics = Object.keys(metricValues({ step: 0, ...config }));
  function* batches() {
    for (let offset = 0; offset < steps.length; offset += config.batchSteps) {
      const batchSteps = steps.slice(offset, offset + config.batchSteps);
      const events = [];
      for (const step of batchSteps) {
        const values = metricValues({ step, ...config });
        for (const metric of metrics) {
          const metadata = metricMeta(metric);
          events.push({
            eventId: `${config.runRef}:${metric}:${step}`,
            runRef: config.runRef,
            metric,
            value: values[metric],
            step,
            timestamp: new Date(Date.parse(startedAt) + step * 20).toISOString(),
            ...metadata,
            source: "workbench-training-simulator",
          });
        }
      }
      yield events;
    }
  }
  return {
    config,
    run,
    steps,
    metricKeys: metrics,
    totalEvents: steps.length * metrics.length,
    batches,
  };
}

export class TrainingSimulationService {
  constructor({ gateway, clock = () => new Date() } = {}) {
    if (!gateway || typeof gateway.ingestMetrics !== "function") throw new Error("TrainingSimulationService requires an experiment gateway");
    this.gateway = gateway;
    this.clock = clock;
  }

  async run(options = {}) {
    const initialTime = this.clock();
    const initialTimestamp = initialTime instanceof Date ? initialTime.toISOString() : new Date(initialTime).toISOString();
    const simulation = createTrainingSimulation({ ...options, startedAt: options.startedAt ?? initialTimestamp });
    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    for (const events of simulation.batches()) {
      const result = this.gateway.ingestMetrics({ run: simulation.run, events, mode: "simulation", source: "workbench-training-simulator" });
      accepted += result.accepted;
      duplicates += result.duplicates;
      rejected += result.rejected;
      await Promise.resolve();
    }
    const completedAt = this.clock();
    this.gateway.ingestMetrics({
      run: { ...simulation.run, status: "FINISHED", endedAt: completedAt instanceof Date ? completedAt.toISOString() : new Date(completedAt).toISOString() },
      events: [],
      mode: "simulation",
      source: "workbench-training-simulator",
    });
    const record = this.gateway.ingestion.get(simulation.config.runRef);
    return {
      schemaVersion: "training-simulation.v1",
      run: summarizeIngestedRun(record?.run),
      runRef: simulation.config.runRef,
      config: simulation.config,
      metricKeys: simulation.metricKeys,
      stepCount: simulation.steps.length,
      eventCount: simulation.totalEvents,
      accepted,
      duplicates,
      rejected,
      startedAt: simulation.run.startedAt,
      completedAt: record?.run?.endedAt ?? null,
      mode: "simulation",
    };
  }
}
