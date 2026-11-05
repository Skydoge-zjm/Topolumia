import { AppError } from "../../lib/errors.js";
import { readJson, sendJson } from "../../lib/http.js";

import { sendSvg } from "../static.js";
import { eventIdPart } from "../streams.js";

export async function handleExperimentsRoutes(context) {
  const {
    request,
    response,
    url,
    pathname,
    registry,
    trainingSimulation,
    researchExperiments,
    state,
    curatorTriggerCoordinator,
    sourceRefresh,
  } = context;

  if (pathname === "/api/research-experiments" && request.method === "GET") {
    sendJson(response, 200, researchExperiments.list(state.snapshot));
    return true;
  }
  if (
    pathname === "/api/research-experiments/agent-context" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    const experimentIds = Array.isArray(body?.experimentIds)
      ? body.experimentIds
      : (body?.nodeIds ?? []).map((id) =>
          String(id).replace(/^experiment:/, ""),
        );
    sendJson(
      response,
      200,
      await researchExperiments.agentContext(experimentIds, {
        snapshot: state.snapshot,
        metricKeys: body?.metrics ?? body?.metricKeys ?? [],
        maxPoints: body?.maxPoints ?? 240,
        includeDetails: body?.includeDetails ?? false,
        includeCharts: body?.includeCharts ?? false,
        accepts: body?.accepts ?? ["text"],
      }),
    );
    return true;
  }
  const researchExperimentDetailMatch = pathname.match(
    /^\/api\/research-experiments\/([^/]+)$/,
  );
  if (researchExperimentDetailMatch && request.method === "GET") {
    let experimentId;
    try {
      experimentId = decodeURIComponent(researchExperimentDetailMatch[1]);
    } catch {
      throw new AppError(
        "RESEARCH_EXPERIMENT_ID_INVALID",
        "科研实验 ID 格式无效。",
        { status: 422 },
      );
    }
    const metrics = url.searchParams.get("metrics")
      ? url.searchParams.get("metrics").split(",").filter(Boolean)
      : [];
    sendJson(
      response,
      200,
      await researchExperiments.detail(experimentId, {
        snapshot: state.snapshot,
        metricKeys: metrics,
        maxPoints: url.searchParams.get("maxPoints") || 240,
      }),
    );
    return true;
  }
  if (pathname === "/api/experiment-adapters" && request.method === "GET") {
    sendJson(response, 200, {
      schemaVersion: "experiment-adapters.v1",
      adapters: await registry.experiments.descriptors(),
    });
    return true;
  }
  if (pathname === "/api/experiment-gateway" && request.method === "GET") {
    sendJson(response, 200, await registry.experiments.status());
    return true;
  }
  if (
    pathname === "/api/experiment-gateway/sync" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    const result = await sourceRefresh.refresh({
      reason: body?.reason ?? "gateway-manual",
      force: true,
    });
    sendJson(response, 200, {
      ...result,
      gateway: await registry.experiments.status(),
    });
    return true;
  }
  if (
    pathname === "/api/experiment-gateway/metrics" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    const result = registry.experiments.ingestMetrics(body);
    const refreshed = await sourceRefresh.refresh({
      reason: "metric-ingested",
      force: true,
    });
    state.recordEvent(
      {
        id: `experiment_metrics_delta:${eventIdPart(result.runRef, 80)}:${eventIdPart(refreshed.stateVersion ?? refreshed.checkedAt, 100)}`,
        type: "toolResult",
        actor: "adapter:experiment-gateway",
        sessionId: null,
        nodeIds: [],
        sourceRefs: result.runRef ? [result.runRef] : [],
        payload: {
          adapter: "experiment-gateway",
          status: "metrics-ingested",
          runRef: result.runRef ?? null,
          accepted: result.accepted ?? 0,
        },
      },
      { skipValidation: true },
    );
    curatorTriggerCoordinator.noteActivity();
    curatorTriggerCoordinator.updateState();
    void curatorTriggerCoordinator
      .consider("experiment_delta", {
        entryContext: {
          surface: "experiment-gateway",
          action: "metrics-ingested",
        },
      })
      .catch(() => {});
    sendJson(response, 202, {
      ...result,
      refresh: {
        outcome: refreshed.outcome,
        changed: refreshed.changed ?? false,
      },
    });
    return true;
  }
  if (
    pathname === "/api/experiment-gateway/simulations" &&
    request.method === "GET"
  ) {
    sendJson(response, 200, registry.experiments.simulationStatus());
    return true;
  }
  if (
    pathname === "/api/experiment-gateway/simulations" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    const result = await trainingSimulation.run(body ?? {});
    const refreshed = await sourceRefresh.refresh({
      reason: "simulation-completed",
      force: true,
    });
    state.recordEvent(
      {
        id: `experiment_simulation_delta:${eventIdPart(result.runRef, 80)}:${eventIdPart(refreshed.stateVersion ?? refreshed.checkedAt, 100)}`,
        type: "toolResult",
        actor: "adapter:experiment-gateway",
        sessionId: null,
        nodeIds: [],
        sourceRefs: result.runRef ? [result.runRef] : [],
        payload: {
          adapter: "experiment-gateway",
          status: "simulation-completed",
          runRef: result.runRef ?? null,
          eventCount: result.eventCount ?? 0,
        },
      },
      { skipValidation: true },
    );
    curatorTriggerCoordinator.noteActivity();
    curatorTriggerCoordinator.updateState();
    void curatorTriggerCoordinator
      .consider("experiment_delta", {
        entryContext: {
          surface: "experiment-gateway",
          action: "simulation-completed",
        },
      })
      .catch(() => {});
    sendJson(response, 201, {
      ...result,
      refresh: {
        outcome: refreshed.outcome,
        changed: refreshed.changed ?? false,
      },
    });
    return true;
  }
  if (pathname === "/api/experiments" && request.method === "GET") {
    const result = await registry.experiments.list({
      provider: url.searchParams.get("provider") || null,
      experiment: url.searchParams.get("experiment") || null,
      group: url.searchParams.get("group") || null,
      status: url.searchParams.get("status") || null,
      limit: Math.min(
        300,
        Math.max(1, Number(url.searchParams.get("limit") || 100)),
      ),
    });
    sendJson(response, 200, result);
    return true;
  }
  if (pathname === "/api/experiments/compare" && request.method === "POST") {
    const body = await readJson(request);
    sendJson(
      response,
      200,
      await registry.experiments.compare(body?.refs ?? [], {
        metricKeys: body?.metrics ?? body?.metricKeys ?? [],
        maxPoints: body?.maxPoints ?? 240,
      }),
    );
    return true;
  }
  const experimentSeriesMatch = pathname.match(
    /^\/api\/experiments\/(.+)\/series$/,
  );
  if (experimentSeriesMatch && request.method === "GET") {
    let ref;
    try {
      ref = decodeURIComponent(experimentSeriesMatch[1]);
    } catch {
      throw new AppError("EXPERIMENT_REF_INVALID", "实验引用格式无效。", {
        status: 422,
      });
    }
    const metrics = url.searchParams.get("metrics")
      ? url.searchParams.get("metrics").split(",").filter(Boolean)
      : [];
    const maxPoints = url.searchParams.get("maxPoints") || 240;
    sendJson(
      response,
      200,
      await registry.experiments.series(ref, {
        metricKeys: metrics,
        maxPoints,
      }),
    );
    return true;
  }
  const experimentChartMatch = pathname.match(
    /^\/api\/experiments\/(.+)\/chart$/,
  );
  if (experimentChartMatch && request.method === "GET") {
    let ref;
    try {
      ref = decodeURIComponent(experimentChartMatch[1]);
    } catch {
      throw new AppError("EXPERIMENT_REF_INVALID", "实验引用格式无效。", {
        status: 422,
      });
    }
    const metrics = url.searchParams.get("metrics")
      ? url.searchParams.get("metrics").split(",").filter(Boolean)
      : [];
    const chart = await registry.experiments.chart(ref, {
      metricKeys: metrics,
      maxPoints: url.searchParams.get("maxPoints") || 240,
      width: url.searchParams.get("width") || 760,
      height: url.searchParams.get("height") || 360,
    });
    sendSvg(response, chart.content);
    return true;
  }
  const experimentDetailMatch = pathname.match(/^\/api\/experiments\/(.+)$/);
  if (experimentDetailMatch && request.method === "GET") {
    let ref;
    try {
      ref = decodeURIComponent(experimentDetailMatch[1]);
    } catch {
      throw new AppError("EXPERIMENT_REF_INVALID", "实验引用格式无效。", {
        status: 422,
      });
    }
    const metrics = url.searchParams.get("metrics")
      ? url.searchParams.get("metrics").split(",").filter(Boolean)
      : [];
    const maxPoints = url.searchParams.get("maxPoints") || 240;
    sendJson(
      response,
      200,
      await registry.experiments.detail(ref, {
        metricKeys: metrics,
        maxPoints,
      }),
    );
    return true;
  }
  if (
    pathname === "/api/agent-context/experiments" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    let refs = Array.isArray(body?.refs) ? body.refs : [];
    if (!refs.length && Array.isArray(body?.nodeIds)) {
      const byId = new Map(
        (state.topology?.nodes ?? []).map((item) => [item.id, item]),
      );
      refs = body.nodeIds
        .map((id) => byId.get(String(id))?.sourceRef)
        .filter(Boolean);
    }
    sendJson(
      response,
      200,
      await registry.experiments.agentContext({ ...body, refs }),
    );
    return true;
  }

  return false;
}
