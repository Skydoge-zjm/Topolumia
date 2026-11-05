import { AppError } from "../../lib/errors.js";
import { validateExperimentQuery } from "../../domain/experiments/experiment-domain.js";
import {
  RESEARCH_EXPERIMENT_CONTEXT_SCHEMA,
  RESEARCH_EXPERIMENT_DETAIL_SCHEMA,
  RESEARCH_EXPERIMENT_INDEX_SCHEMA,
  aggregateResearchExperiments,
  compactResearchExperiment,
  providerAttemptRefs,
  researchExperimentRecord,
} from "../../domain/experiments/research-experiment.js";

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function compactAttempt(attempt) {
  return structuredClone({
    id: attempt.id,
    ref: attempt.ref,
    sequence: attempt.sequence,
    source: attempt.source,
    provider: attempt.provider,
    label: attempt.label,
    status: attempt.status,
    attemptRole: attempt.attemptRole,
    failure: attempt.failure,
    params: attempt.params,
    metrics: attempt.metrics,
    metricSummary: attempt.metricSummary,
    artifactCount: attempt.artifactCount,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    observedAt: attempt.observedAt,
    mode: attempt.mode,
    sourceStatus: attempt.sourceStatus,
  });
}

function contextSummary(record) {
  return {
    ...compactResearchExperiment(record.summary),
    limitations: record.summary.limitations,
    sourceCount: providerAttemptRefs(record).length,
  };
}

export class ResearchExperimentService {
  constructor({ gateway } = {}) {
    if (!gateway || typeof gateway.detail !== "function" || typeof gateway.agentContext !== "function") {
      throw new Error("ResearchExperimentService requires an experiment tracking gateway");
    }
    this.gateway = gateway;
  }

  list(snapshot = null) {
    const aggregate = aggregateResearchExperiments(snapshot);
    return {
      schemaVersion: RESEARCH_EXPERIMENT_INDEX_SCHEMA,
      items: aggregate.records.map((record) => compactResearchExperiment(record.summary)),
      unassignedRunCount: aggregate.unassignedRuns.length,
      observedAt: aggregate.observedAt,
    };
  }

  summary(experimentId, snapshot = null) {
    const record = researchExperimentRecord(experimentId, snapshot);
    return compactResearchExperiment(record.summary);
  }

  async detail(experimentId, {
    snapshot = null,
    metricKeys = [],
    maxPoints = 240,
  } = {}) {
    const query = validateExperimentQuery({ metrics: metricKeys, maxPoints });
    const record = researchExperimentRecord(experimentId, snapshot);
    const providerRefs = providerAttemptRefs(record);
    const results = await Promise.allSettled(providerRefs.map((ref) => this.gateway.detail(ref, {
      metricKeys: query.metrics,
      maxPoints: query.maxPoints,
    })));
    const warnings = [];
    const details = [];
    results.forEach((result, index) => {
      const ref = providerRefs[index];
      if (result.status === "fulfilled") {
        details.push({ attemptRef: ref, ...result.value });
      } else {
        warnings.push({
          ref,
          code: result.reason?.code ?? "EXPERIMENT_ATTEMPT_DETAIL_UNAVAILABLE",
          message: result.reason?.message ?? String(result.reason),
        });
      }
    });
    return {
      schemaVersion: RESEARCH_EXPERIMENT_DETAIL_SCHEMA,
      experiment: {
        ...structuredClone(record.summary),
        attempts: record.attempts.map(compactAttempt),
      },
      attempts: record.attempts.map(compactAttempt),
      details,
      sourceRefs: unique(providerRefs),
      provenance: {
        observedAt: snapshot?.observedAt ?? null,
        sourceCount: providerRefs.length,
        warnings,
      },
      warnings,
    };
  }

  async agentContext(experimentIds, {
    snapshot = null,
    metricKeys = [],
    maxPoints = 240,
    includeDetails = false,
    includeCharts = false,
    accepts = ["text"],
  } = {}) {
    const ids = unique(Array.isArray(experimentIds) ? experimentIds.map(String) : []);
    if (!ids.length || ids.length > 8) {
      throw new AppError("RESEARCH_EXPERIMENT_CONTEXT_INVALID", "请提供 1 到 8 个科研实验 ID。", { status: 422 });
    }
    const query = validateExperimentQuery({ metrics: metricKeys, maxPoints });
    const records = ids.map((id) => researchExperimentRecord(id, snapshot));
    const refs = unique(records.flatMap(providerAttemptRefs));
    const shouldExpand = Boolean(includeDetails || includeCharts);
    let providerContext = null;
    if (shouldExpand && refs.length) {
      providerContext = await this.gateway.agentContext({
        refs,
        metrics: query.metrics,
        maxPoints: query.maxPoints,
        includeCharts,
        accepts,
      });
    }
    const experiments = records.map(contextSummary);
    const text = JSON.stringify({
      experiments,
      note: shouldExpand
        ? "Provider attempt details were requested explicitly."
        : "This is an experiment-level summary. Request attempt detail only when necessary.",
      ...(providerContext ? { runs: providerContext.runs, series: providerContext.series, warnings: providerContext.warnings } : {}),
    });
    return {
      schemaVersion: RESEARCH_EXPERIMENT_CONTEXT_SCHEMA,
      experiments,
      runs: providerContext?.runs ?? [],
      series: providerContext?.series ?? [],
      assets: providerContext?.assets ?? [],
      content: [{ type: "text", text }, ...(providerContext?.content ?? []).filter((item) => item.type === "image")],
      capabilities: {
        experimentSummary: true,
        attemptDetails: shouldExpand && refs.length > 0,
        chartImage: Boolean(providerContext?.assets?.length),
        fullLogs: false,
      },
      warnings: providerContext?.warnings ?? [],
      provenance: {
        experimentIds: ids,
        runRefs: refs,
        generatedAt: new Date().toISOString(),
      },
    };
  }
}
