import { hostname } from "node:os";
import * as z from "zod/v4";
import { AppError } from "../../../lib/errors.js";
import { versionHash } from "../../../lib/hash.js";
import type { AppConfig } from "../../../config.js";
import type { ResearchCommandService } from "../research-command-service.js";
import type { ResearchActor } from "../../../domain/research/types.js";
import { normalizeRunStatus } from "../../../domain/research/experiment-records.js";
import type { RecordEvent } from "../../../domain/research/record-ingestion.js";
import { MlflowReader, type MlflowRunRecords } from "./mlflow-reader.js";

export const mlflowImportSchema = z.strictObject({
  runIds: z.array(z.string().min(1).max(500)).min(1).max(100),
});
/** A selected import is immutable. New upstream data creates a new selectable version. */
export class MlflowRecordImporter {
  readonly reader: MlflowReader;
  constructor(
    readonly c: ResearchCommandService,
    readonly config: AppConfig,
  ) {
    this.reader = new MlflowReader(config);
  }
  async catalog(actor: ResearchActor) {
    this.c.check(actor, "project.manageSettings");
    this.requireManager(actor);
    const experiments = await this.reader.listExperiments();
    const selected = this.config.mlflow.experimentId
      ? experiments.filter(
          (item) => item.experiment_id === this.config.mlflow.experimentId,
        )
      : this.config.mlflow.experimentName
        ? experiments.filter(
            (item) => item.name === this.config.mlflow.experimentName,
          )
        : experiments;
    const runs = [];
    for (const experiment of selected)
      for (const run of await this.reader.listRuns(experiment.experiment_id))
        runs.push({
          runId: run.info.run_id,
          label: run.info.run_name ?? run.info.run_id,
          status: normalizeRunStatus(run.info.status),
          experimentId: experiment.experiment_id,
          experimentName: experiment.name,
        });
    return { experiments: selected, runs };
  }
  async import(input: unknown, actor: ResearchActor) {
    this.c.check(actor, "project.manageSettings");
    this.requireManager(actor);
    const parsed = mlflowImportSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError("INPUT_INVALID", "请选择 1–100 条 MLflow 运行。", {
        status: 422,
      });
    const { runIds } = parsed.data;
    const selectedExperimentIds = this.config.mlflow.experimentId
      ? [this.config.mlflow.experimentId]
      : this.config.mlflow.experimentName
        ? (await this.reader.listExperiments())
            .filter((item) => item.name === this.config.mlflow.experimentName)
            .map((item) => item.experiment_id)
        : null;
    const records: { runId: string; native: MlflowRunRecords }[] = [];
    for (const runId of new Set(runIds)) {
      const native = await this.reader.readRun(runId);
      if (
        native.run.info.run_id !== runId ||
        (selectedExperimentIds &&
          !selectedExperimentIds.includes(native.run.info.experiment_id))
      )
        throw new AppError(
          "MLFLOW_RUN_SCOPE_MISMATCH",
          "运行不属于所选 MLflow 实验。",
          { status: 422 },
        );
      records.push({ runId, native });
    }
    // Fetch the complete selection before writing. A failed page or run leaves no partial import.
    return this.c.store.transaction(() => {
      const imported = [];
      for (const { runId, native } of records) {
        const digest = versionHash(native),
          sourceId =
            "record-source:mlflow:" +
            versionHash([
              this.reader.baseUrl,
              native.run.info.experiment_id,
              runId,
              digest,
            ]).slice(7);
        const label = native.run.info.run_name ?? runId,
          now = new Date().toISOString();
        const events: RecordEvent[] = [
          {
            seq: 0,
            sourceRunId: runId,
            kind: "run",
            label,
            status: normalizeRunStatus(native.run.info.status),
          },
          {
            seq: 1,
            sourceRunId: runId,
            kind: "config",
            data: {
              parameters: native.run.data.params,
              tags: native.run.data.tags,
            },
          },
          {
            seq: 2,
            sourceRunId: runId,
            kind: "summary",
            data: { metrics: native.run.data.metrics },
          },
          {
            seq: 3,
            sourceRunId: runId,
            kind: "extension",
            key: "mlflow/run",
            data: { native: z.json().parse(native.run) },
          },
        ];
        for (const [key, points] of Object.entries(native.history))
          for (const point of points)
            events.push({
              seq: events.length,
              sourceRunId: runId,
              kind: "scalar",
              key,
              xKey: "step",
              x: point.step ?? 0,
              value: point.value,
              ...(point.timestamp === undefined
                ? {}
                : { timestamp: point.timestamp }),
            });
        for (const artifact of native.artifacts)
          events.push({
            seq: events.length,
            sourceRunId: runId,
            kind: "file",
            key: "mlflow/artifact",
            data: { native: z.json().parse(artifact), external: true },
          });
        if (!this.c.projectRecords.get(sourceId))
          this.c.projectRecords.save({
            id: sourceId,
            userId: actor.user!.id,
            hostId: "local",
            hostLabel: hostname(),
            provider: "mlflow",
            directory: `mlflow/${native.run.info.experiment_id}/${runId}`,
            enabled: false,
            mode: "import",
            contentVersion: digest,
            createdAt: now,
            updatedAt: now,
          });
        for (let offset = 0; offset < events.length; offset += 128)
          this.c.ingestion.receive(
            sourceId,
            {
              version: 1,
              provider: "mlflow",
              streamId: runId,
              writerId: "mlflow-rest-import",
              generation: digest,
              sourceInfo: { adapterVersion: "1", sdkVersion: "REST-v2" },
              events: events.slice(offset, offset + 128),
            },
            actor,
          );
        imported.push({
          sourceId,
          runId: this.c.ingestion.runId(sourceId, "mlflow", runId, runId),
          contentVersion: digest,
          label,
        });
      }
      return { imported };
    });
  }
  private requireManager(actor: ResearchActor) {
    if (actor.isAgent || actor.collectorGrant || !actor.user)
      throw new AppError("FORBIDDEN", "MLflow 导入需要项目管理者操作。", {
        status: 403,
      });
  }
}
