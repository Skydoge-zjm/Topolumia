import * as z from "zod/v4";
import { AppError } from "../../../lib/errors.js";
import type { AppConfig } from "../../../config.js";

const pair = z.object({
  key: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
});
const metric = z.object({
  key: z.string(),
  value: z.number(),
  step: z.number().optional(),
  timestamp: z.number().optional(),
});
const run = z
  .object({
    info: z
      .object({
        run_id: z.string(),
        experiment_id: z.string(),
        run_name: z.string().optional(),
        status: z.string().optional(),
        start_time: z.number().optional(),
        end_time: z.number().optional(),
        artifact_uri: z.string().optional(),
      })
      .passthrough(),
    data: z
      .object({
        metrics: z.array(metric).default([]),
        params: z.array(pair).default([]),
        tags: z.array(pair).default([]),
      })
      .passthrough(),
  })
  .passthrough();
const experiment = z
  .object({ experiment_id: z.string(), name: z.string() })
  .passthrough();
const runPage = z.object({
  runs: z.array(run).default([]),
  next_page_token: z.string().nullish(),
});
const experimentPage = z.object({
  experiments: z.array(experiment).default([]),
  next_page_token: z.string().nullish(),
});
const metricPage = z.object({
  metrics: z.array(metric).default([]),
  next_page_token: z.string().nullish(),
});
const artifact = z
  .object({
    path: z.string(),
    is_dir: z.boolean(),
    file_size: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();
const artifactPage = z.object({
  files: z.array(artifact).default([]),
  next_page_token: z.string().nullish(),
});
export type MlflowRun = z.infer<typeof run>;
export type MlflowExperiment = z.infer<typeof experiment>;
export type MlflowMetric = z.infer<typeof metric>;
export type MlflowArtifact = z.infer<typeof artifact>;
export type MlflowRunRecords = {
  run: MlflowRun;
  history: Record<string, MlflowMetric[]>;
  artifacts: MlflowArtifact[];
};

/** Reads complete native REST records. Rendering and sampling belong to the record store. */
export class MlflowReader {
  constructor(readonly config: AppConfig) {}
  get baseUrl(): string {
    return this.config.mlflow.baseUrl.replace(/\/+$/, "");
  }
  async request(pathname: string, options: RequestInit = {}): Promise<unknown> {
    if (!this.baseUrl)
      throw new AppError("MLFLOW_NOT_CONFIGURED", "请先配置 MLflow 服务。", {
        status: 422,
      });
    const headers = new Headers(options.headers);
    headers.set("accept", "application/json");
    if (options.body) headers.set("content-type", "application/json");
    const token = process.env[this.config.mlflow.tokenEnv];
    if (token) headers.set("authorization", `Bearer ${token}`);
    try {
      const response = await fetch(this.baseUrl + pathname, {
        ...options,
        headers,
        signal: AbortSignal.timeout(this.config.mlflow.timeoutMs),
      });
      if (!response.ok)
        throw new AppError(
          "MLFLOW_HTTP_ERROR",
          `MLflow 请求失败：HTTP ${response.status}`,
          {
            status: 503,
            retryable: response.status === 429 || response.status >= 500,
          },
        );
      return (await response.json()) as unknown;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("MLFLOW_UNREACHABLE", "无法读取 MLflow 服务。", {
        status: 503,
        cause: error,
        retryable: true,
      });
    }
  }
  async health() {
    const checkedAt = new Date().toISOString();
    try {
      experimentPage.parse(
        await this.request("/api/2.0/mlflow/experiments/search?max_results=1"),
      );
      return { status: "ready", checkedAt };
    } catch (error) {
      return {
        status: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
        checkedAt,
      };
    }
  }
  async listExperiments(): Promise<MlflowExperiment[]> {
    const values: MlflowExperiment[] = [],
      cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({
        max_results: String(this.config.mlflow.pageSize),
      });
      if (cursor) query.set("page_token", cursor);
      const page = experimentPage.parse(
        await this.request("/api/2.0/mlflow/experiments/search?" + query),
      );
      values.push(...page.experiments);
      cursor = this.nextCursor(page.next_page_token, cursors);
    } while (cursor);
    return values;
  }
  async listRuns(experimentId: string): Promise<MlflowRun[]> {
    const values: MlflowRun[] = [],
      cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = runPage.parse(
        await this.request("/api/2.0/mlflow/runs/search", {
          method: "POST",
          body: JSON.stringify({
            experiment_ids: [experimentId],
            max_results: this.config.mlflow.pageSize,
            ...(cursor ? { page_token: cursor } : {}),
          }),
        }),
      );
      values.push(...page.runs);
      if (values.length > this.config.mlflow.maxRuns)
        throw new AppError(
          "MLFLOW_RUN_LIMIT",
          "MLflow 运行目录超过配置的读取上限，请选择更小的实验。",
          { status: 422 },
        );
      cursor = this.nextCursor(page.next_page_token, cursors);
    } while (cursor);
    return values;
  }
  private nextCursor(
    cursor: string | null | undefined,
    seen: Set<string>,
  ): string | undefined {
    if (!cursor) return;
    if (seen.has(cursor))
      throw new AppError(
        "MLFLOW_PAGINATION_INVALID",
        "MLflow 返回了重复分页游标。",
        { status: 502 },
      );
    seen.add(cursor);
    return cursor;
  }
  async readRun(runId: string): Promise<MlflowRunRecords> {
    const query = new URLSearchParams({ run_id: runId });
    const selected = z
      .object({ run })
      .parse(await this.request("/api/2.0/mlflow/runs/get?" + query)).run;
    const history: Record<string, MlflowMetric[]> = {};
    for (const key of new Set(selected.data.metrics.map((item) => item.key))) {
      const points: MlflowMetric[] = [],
        cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const params = new URLSearchParams({
          run_id: runId,
          metric_key: key,
          max_results: "10000",
        });
        if (cursor) params.set("page_token", cursor);
        const page = metricPage.parse(
          await this.request("/api/2.0/mlflow/metrics/get-history?" + params),
        );
        points.push(...page.metrics);
        cursor = this.nextCursor(page.next_page_token, cursors);
      } while (cursor);
      // Keep native observation order, including duplicate and reset steps.
      history[key] = points;
    }
    return {
      run: selected,
      history,
      artifacts: await this.listArtifacts(runId),
    };
  }
  async listArtifacts(runId: string): Promise<MlflowArtifact[]> {
    const values: MlflowArtifact[] = [],
      pending = [""],
      visited = new Set<string>();
    while (pending.length) {
      const path = pending.shift()!;
      if (visited.has(path))
        throw new AppError(
          "MLFLOW_ARTIFACT_TREE_INVALID",
          "MLflow 返回了重复的产物目录。",
          { status: 502 },
        );
      visited.add(path);
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({ run_id: runId, path });
        if (cursor) query.set("page_token", cursor);
        const page = artifactPage.parse(
          await this.request("/api/2.0/mlflow/artifacts/list?" + query),
        );
        for (const item of page.files) {
          values.push(item);
          if (item.is_dir) pending.push(item.path);
        }
        if (values.length > 50_000)
          throw new AppError(
            "MLFLOW_ARTIFACT_LIMIT",
            "MLflow 产物目录超过读取上限。",
            { status: 422 },
          );
        cursor = this.nextCursor(page.next_page_token, cursors);
      } while (cursor);
    }
    return values;
  }
}
