import { GitAdapter } from "../../adapters/sources/git-adapter.js";
import { FilesystemAdapter } from "../../adapters/sources/filesystem-adapter.js";
import { MlflowReader } from "../research/experiments/mlflow-reader.js";
import { WandbConnectionProbe } from "./source-connections.js";
import { DockerAdapter } from "../../adapters/execution/docker-adapter.js";
import type { AppConfig } from "../../config.js";
import { versionHash } from "../../lib/hash.js";

function settledError(result: PromiseSettledResult<unknown>, source: string) {
  if (result.status === "fulfilled") return null;
  return {
    source,
    code: result.reason?.code ?? "SOURCE_SYNC_FAILED",
    message: result.reason?.message ?? String(result.reason),
  };
}

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["observedAt", "checkedAt", "createdAt", "startedAt", "completedAt", "durationMs"].includes(key))
      .map(([key, item]) => [key, stripVolatile(item)]),
  );
}

export class AdapterRegistry {
  git: GitAdapter; filesystem: FilesystemAdapter; mlflow: MlflowReader; wandb: WandbConnectionProbe; docker: DockerAdapter;
  constructor(public config: AppConfig) {
    this.config = config;
    this.git = new GitAdapter(config);
    this.filesystem = new FilesystemAdapter(config);
    this.mlflow = new MlflowReader(config);
    this.wandb = new WandbConnectionProbe(config);
    this.docker = new DockerAdapter(config);
  }

  async syncSources() {
    const observedAt = new Date().toISOString();
    const [git, files] = await Promise.allSettled([
      this.git.snapshot(),
      this.filesystem.snapshot(),
    ]);
    const sourceErrors = [
      settledError(git, this.git.id),
      settledError(files, this.filesystem.id),
    ].filter((error): error is NonNullable<typeof error> => error !== null);
    const snapshotBody = {
      git: git.status === "fulfilled" ? git.value : null,
      files: files.status === "fulfilled" ? files.value : null,
      sourceErrors,
    };
    return {
      schemaVersion: "source-snapshot.v1",
      stateVersion: versionHash(stripVolatile(snapshotBody)),
      observedAt,
      ...snapshotBody,
    };
  }
}
