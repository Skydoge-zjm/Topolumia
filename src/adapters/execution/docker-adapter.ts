import { AppError } from "../../lib/errors.js";
import { runCommand, summarizeCommandFailure } from "../../lib/command.js";
import { sha256, stableStringify } from "../../lib/hash.js";
import type { AppConfig } from "../../config.js";

function assertEnum(value: unknown, allowed: string[], field: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new AppError("INVALID_EXECUTION_INPUT", `${field} 不在允许范围内。`, {
      status: 422,
      detail: { field, allowed },
    });
  }
  return value;
}

function assertInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new AppError("INVALID_EXECUTION_INPUT", `${field} 必须是 ${min}-${max} 的整数。`, {
      status: 422,
      detail: { field, min, max },
    });
  }
  return value;
}

function assertSeeds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new AppError("INVALID_EXECUTION_INPUT", "seeds 必须包含 1-8 个整数。", { status: 422 });
  }
  return value.map((seed) => assertInteger(seed, "seed", 0, 2_147_483_647));
}

type Limits = { network: string; cpus: number; memory: string; pids: number; gpus: string | null; timeoutMs: number };
type TemplateInputs = { dataset?: string; steps?: number; seeds?: number[] };
type Template = { id: string; previewOnly: boolean; image: string; limits: Limits; normalize: (input?: Record<string, unknown>) => TemplateInputs; build: (input: TemplateInputs) => string[] };
export type ExecutionPreview = { schemaVersion: string; id: string; adapter: string; templateId: string; image: string; argv: string[]; inputs: TemplateInputs; limits: Limits; previewOnly: boolean; imageLockedByDigest: boolean; createdAt: string };
export type ExecutionRecord = Awaited<ReturnType<DockerAdapter["run"]>>;
function commonFlags(limits: Limits) {
  const flags = [
    "run",
    "--rm",
    "--network", limits.network,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--cpus", String(limits.cpus),
    "--memory", limits.memory,
    "--pids-limit", String(limits.pids),
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
  ];
  if (limits.gpus) flags.push("--gpus", limits.gpus);
  return flags;
}

export class DockerAdapter {
  readonly id = "docker-local";
  previews = new Map<string, ExecutionPreview>();
  templates: Map<string, Template>;
  constructor(public config: AppConfig) {
    this.templates = new Map<string, Template>([
      ["diffusion-sr-factorial-preview", {
        id: "diffusion-sr-factorial-preview",
        previewOnly: true,
        image: "nvidia/cuda:12.8.1-base-ubuntu24.04",
        limits: { network: "none", cpus: 4, memory: "8g", pids: 256, gpus: "all", timeoutMs: 7_200_000 },
        normalize: (inputs = {}) => ({
          dataset: assertEnum(inputs.dataset ?? "DIV2K-valid-x4", ["DIV2K-valid-x4", "Urban100-x4"], "dataset"),
          steps: assertInteger(inputs.steps ?? 50, "steps", 10, 200),
          seeds: assertSeeds(inputs.seeds ?? [13, 42, 73]),
        }),
        build: (inputs) => [
          "--mount", `type=bind,src=${this.config.project.root},dst=/workspace,readonly`,
          "--workdir", "/workspace",
          "nvidia/cuda:12.8.1-base-ubuntu24.04",
          "python", "scripts/run_factorial.py",
          "--dataset", inputs.dataset!,
          "--conditioning", "off,on",
          "--schedule", "baseline,corrected",
          "--steps", String(inputs.steps),
          "--seeds", inputs.seeds!.join(","),
          "--output", "/workspace/artifacts/G3",
        ],
      }],
      ["adapter-smoke", {
        id: "adapter-smoke",
        previewOnly: false,
        image: "node:22-alpine",
        limits: { network: "none", cpus: 0.5, memory: "128m", pids: 64, gpus: null, timeoutMs: this.config.docker.runTimeoutMs },
        normalize: () => ({}),
        build: () => [
          "node:22-alpine",
          "node",
          "-e",
          "console.log(JSON.stringify({adapter:'docker-local',status:'ok',runtime:process.version}))",
        ],
      }],
    ]);
  }

  templateIds() {
    return [...this.templates.keys()];
  }

  async health() {
    const checkedAt = new Date().toISOString();
    const result = await runCommand(this.config.docker.command, ["version", "--format", "{{json .Server.Version}}"], {
      timeoutMs: this.config.docker.healthTimeoutMs,
      maxOutputBytes: 65_536,
    });
    if (!result.ok) {
      return { status: "unavailable", detail: summarizeCommandFailure(result), checkedAt };
    }
    const version = result.stdout.trim().replace(/^"|"$/g, "");
    return { status: "ready", detail: `Docker Engine ${version}`, checkedAt };
  }

  async descriptor() {
    return {
      id: this.id,
      kind: "execution",
      provider: "docker",
      label: "Docker / local runner",
      mode: this.config.docker.executionEnabled ? "execute-enabled" : "preview",
      capabilities: ["health", "preview", ...(this.config.docker.executionEnabled ? ["run-registered-template"] : [])],
      templates: this.templateIds(),
      health: await this.health(),
    };
  }

  preview(templateId: string, rawInputs: Record<string, unknown> = {}) {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new AppError("EXECUTION_TEMPLATE_NOT_FOUND", "未找到已登记的执行模板。", {
        status: 404,
        detail: { templateId, available: this.templateIds() },
      });
    }
    const inputs = template.normalize(rawInputs);
    const args = [...commonFlags(template.limits), ...template.build(inputs)];
    const signature = stableStringify({ templateId, inputs, args });
    const id = `exec_preview_${sha256(signature).slice(0, 16)}`;
    const preview = {
      schemaVersion: "execution-preview.v1",
      id,
      adapter: this.id,
      templateId,
      image: template.image,
      argv: [this.config.docker.command, ...args],
      inputs,
      limits: { ...template.limits },
      previewOnly: template.previewOnly,
      imageLockedByDigest: template.image.includes("@sha256:"),
      createdAt: new Date().toISOString(),
    };
    this.previews.set(id, preview);
    return preview;
  }

  async run(previewId: string) {
    const preview = this.previews.get(previewId);
    if (!preview) {
      throw new AppError("EXECUTION_PREVIEW_NOT_FOUND", "执行前必须先生成有效 preview。", {
        status: 404,
        detail: { previewId },
      });
    }
    if (preview.previewOnly || preview.templateId !== "adapter-smoke") {
      throw new AppError("EXECUTION_PREVIEW_ONLY", "该实验模板只允许预览，不能从 MVP 启动。", { status: 409 });
    }
    if (!this.config.docker.executionEnabled) {
      throw new AppError("DOCKER_RUN_DISABLED", "Docker smoke run 未启用。", {
        status: 403,
        detail: { enableWith: "MVP_ENABLE_DOCKER_RUN=1" },
      });
    }

    const startedAt = new Date().toISOString();
    const result = await runCommand(preview.argv[0], preview.argv.slice(1), {
      timeoutMs: preview.limits.timeoutMs,
      maxOutputBytes: 262_144,
    });
    const completedAt = new Date().toISOString();
    let output: unknown = result.stdout.trim();
    try {
      output = output ? JSON.parse(String(output)) as unknown : null;
    } catch {
      // Preserve provider text when it is not JSON.
    }
    return {
      schemaVersion: "execution-record.v1",
      id: preview.id.replace("exec_preview_", "exec_"),
      previewId,
      adapter: this.id,
      templateId: preview.templateId,
      status: result.ok ? "succeeded" : result.timedOut ? "timed_out" : "failed",
      startedAt,
      completedAt,
      exitCode: result.code,
      output,
      error: result.ok ? null : summarizeCommandFailure(result),
    };
  }
}
