import { GitAdapter } from "../../adapters/sources/git-adapter.js";
import { FilesystemAdapter } from "../../adapters/sources/filesystem-adapter.js";
import { MlflowAdapter } from "../../adapters/experiments/mlflow-adapter.js";
import { WandbAdapter } from "../../adapters/experiments/wandb-adapter.js";
import { TensorboardAdapter } from "../../adapters/experiments/tensorboard-adapter.js";
import { DockerAdapter } from "../../adapters/execution/docker-adapter.js";
import { ExperimentTrackingGateway } from "../experiments/experiment-tracking-gateway.js";
import { versionHash } from "../../lib/hash.js";

function settledError(result, source) {
  if (result.status === "fulfilled") return null;
  return {
    source,
    code: result.reason?.code ?? "SOURCE_SYNC_FAILED",
    message: result.reason?.message ?? String(result.reason),
  };
}

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["observedAt", "checkedAt", "createdAt", "startedAt", "completedAt", "durationMs"].includes(key))
      .map(([key, item]) => [key, stripVolatile(item)]),
  );
}

export class AdapterRegistry {
  constructor(config) {
    this.config = config;
    this.git = new GitAdapter(config);
    this.filesystem = new FilesystemAdapter(config);
    this.mlflow = new MlflowAdapter(config);
    this.wandb = new WandbAdapter(config);
    this.tensorboard = new TensorboardAdapter(config);
    this.experiments = new ExperimentTrackingGateway(config, {
      providers: {
        mlflow: this.mlflow,
        wandb: this.wandb,
        tensorboard: this.tensorboard,
      },
    });
    this.docker = new DockerAdapter(config);
  }

  async syncSources() {
    const observedAt = new Date().toISOString();
    const [git, files, experimentSync] = await Promise.allSettled([
      this.git.snapshot(),
      this.filesystem.snapshot(),
      this.experiments.sync({ reason: "source-refresh", force: true }),
    ]);
    const experimentSnapshots = experimentSync.status === "fulfilled" ? experimentSync.value.snapshots ?? {} : {};
    const experimentWarnings = experimentSync.status === "fulfilled"
      ? (experimentSync.value.warnings ?? []).map((item) => ({ source: item.provider, code: item.code, message: item.message }))
      : [settledError(experimentSync, "experiment-gateway")].filter(Boolean);
    const sourceErrors = [
      settledError(git, this.git.id),
      settledError(files, this.filesystem.id),
      ...experimentWarnings,
    ].filter(Boolean);
    const snapshotBody = {
      git: git.status === "fulfilled" ? git.value : null,
      files: files.status === "fulfilled" ? files.value : null,
      mlflow: experimentSnapshots.mlflow ?? null,
      experiments: {
        wandb: experimentSnapshots.wandb ?? null,
        tensorboard: experimentSnapshots.tensorboard ?? null,
        simulation: experimentSnapshots.simulation ?? this.experiments.simulationSnapshot(),
      },
      sourceErrors,
      experimentGateway: experimentSync.status === "fulfilled" ? {
        schemaVersion: experimentSync.value.schemaVersion,
        sourceStatus: experimentSync.value.sourceStatus,
        providers: experimentSync.value.providers,
        warnings: experimentSync.value.warnings,
        completedAt: experimentSync.value.completedAt,
      } : null,
    };
    return {
      schemaVersion: "source-snapshot.v1",
      stateVersion: versionHash(stripVolatile(snapshotBody)),
      observedAt,
      ...snapshotBody,
    };
  }
}
