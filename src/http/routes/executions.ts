import type { RouteContext } from "../route-context.js";
import { AppError } from "../../lib/errors.js";
import { readJsonObject, sendJson, requiredString } from "../../lib/http.js";

import { eventIdPart } from "../streams.js";

export async function handleExecutionsRoutes(context: RouteContext) {
  const {
    request,
    response,
    pathname,
    requestRuntime,
    registry,
    state,
    curatorTriggerCoordinator,
    sourceRefresh,
  }: RouteContext = context;

  if (
    pathname === "/api/executions/docker/preview" &&
    request.method === "POST"
  ) {
    const body = await readJsonObject(request);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.templateId !== "string"
    ) {
      throw new AppError(
        "EXECUTION_INPUT_REQUIRED",
        "需要包含 templateId 的执行预览输入。",
        { status: 422 },
      );
    }
    if (body.inputs !== undefined && (body.inputs === null || typeof body.inputs !== "object" || Array.isArray(body.inputs))) throw new AppError("EXECUTION_INPUT_REQUIRED", "执行输入必须是对象。", { status: 422 });
    const preview = registry.docker.preview(body.templateId, body.inputs as Record<string, unknown> | undefined);
    state.setExecutionPreview(preview);
    sendJson(response, 201, preview);
    return true;
  }
  if (pathname === "/api/executions/docker/run" && request.method === "POST") {
    const body = await readJsonObject(request);
    requestRuntime.activeCriticalOperations += 1;
    let record;
    try {
      record = await registry.docker.run(requiredString(body.previewId));
    } finally {
      requestRuntime.activeCriticalOperations -= 1;
    }
    state.setExecutionRecord(record);
    state.recordEvent(
      {
        id: `experiment_execution_delta:${eventIdPart(record.id, 120)}`,
        type: "toolResult",
        actor: "adapter:docker",
        sessionId: null,
        nodeIds: [],
        sourceRefs: [],
        payload: {
          adapter: "docker",
          status: record.status,
          templateId: record.templateId,
          executionId: record.id,
        },
      },
      { skipValidation: true },
    );
    curatorTriggerCoordinator.noteActivity();
    sendJson(response, 200, record);
    void sourceRefresh
      .refresh({ reason: "experiment-completed", force: true })
      .catch(() => {});
    void curatorTriggerCoordinator
      .consider("experiment_delta", {
        entryContext: { surface: "docker", action: "execution-completed" },
      })
      .catch(() => {});
    return true;
  }

  return false;
}
