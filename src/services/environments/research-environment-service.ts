import path from "node:path";
import { readFile, mkdir, rename, writeFile, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { AppError } from "../../lib/errors.js";
import {
  ResearchEnvironmentProbes,
  parseNvccVersion,
} from "./research-environment-probes.js";

const selectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("default") }),
  z.strictObject({
    kind: z.literal("custom"),
    pythonCommand: z.string().trim().min(1).max(500),
  }),
  z.strictObject({
    kind: z.literal("conda"),
    prefix: z.string().trim().min(1).max(500),
  }),
]);
const ids = [
  "python",
  "jupyter",
  "tensorboard",
  "wandb",
  "mlflow",
  "torch",
  "jax",
  "tensorflow",
  "cuda",
  "nvidia",
];
const samePath = (a, b) =>
  process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

export class ResearchEnvironmentService {
  constructor({ config, settings, applySettings, commandRunner, includeHost = true }) {
    Object.assign(this, { config, settings, applySettings, commandRunner });
    this.includeHost = includeHost;
    this.revision = 0;
    this.pending = null;
    this.tasks = new Set();
    this.persistence = Promise.resolve();
    this.file = path.join(
      path.dirname(settings.filePath),
      "research-environment.json",
    );
    this.reset();
  }

  fingerprint() {
    return hash([
      this.config.project.root,
      this.config.researchEnvironment,
      this.config.toolCommands,
    ]);
  }

  reset() {
    this.revision++;
    this.key = this.fingerprint();
    this.state = {
      status: "idle",
      checkedAt: null,
      startedAt: null,
      components: [],
    };
  }

  synchronize() {
    if (this.key !== this.fingerprint()) this.reset();
  }

  async initialize() {
    try {
      const raw = await readFile(this.file, "utf8");
      if (raw.length > 262144) return;
      const saved = JSON.parse(raw);
      if (
        saved.schemaVersion === "research-environment.v1" &&
        saved.fingerprint === this.key &&
        saved.status === "completed" &&
        Array.isArray(saved.components) &&
        saved.components.every((c) => ids.includes(c.id))
      ) {
        this.state = {
          status: saved.status,
          checkedAt: saved.checkedAt,
          startedAt: saved.startedAt,
          components: saved.components,
        };
      }
    } catch {
      /* A missing or obsolete diagnostic cache is safe to regenerate. */
    }
  }

  view() {
    this.synchronize();
    return {
      schemaVersion: "research-environment.v1",
      fingerprint: this.key,
      selection: { ...this.config.researchEnvironment },
      name:
        this.config.researchEnvironment.kind === "conda"
          ? path.basename(this.config.researchEnvironment.prefix)
          : this.config.researchEnvironment.kind,
      ...structuredClone(this.state),
      stale: Boolean(
        this.state.checkedAt &&
        Date.now() - Date.parse(this.state.checkedAt) > 15 * 60 * 1000,
      ),
    };
  }

  probes(config = this.config) {
    return new ResearchEnvironmentProbes(config, (...args) =>
      this.commandRunner(...args),
    );
  }

  async close() {
    this.revision++;
    await Promise.allSettled([...this.tasks, this.persistence]);
  }

  async adopt(report) {
    if (!report || report.status !== "completed" || report.fingerprint !== this.fingerprint() || report.stale) return false;
    this.revision++;
    this.key = this.fingerprint();
    const host = this.state.components.filter(component => component.scope === "host" && component.checkedAt);
    const components = this.includeHost ? report.components.map(component => component.scope === "host" ? host.find(previous => previous.id === component.id) ?? component : component)
      : report.components.filter(component => component.scope !== "host");
    for (const previous of this.includeHost ? host : []) if (!components.some(component => component.id === previous.id)) components.push(previous);
    this.state = structuredClone({ status: report.status, checkedAt: report.checkedAt, startedAt: report.startedAt, components });
    await this.persistState();
    return true;
  }

  async persistState() {
    const key = this.key;
    const snapshot = this.view();
    this.persistence = this.persistence.catch(() => {}).then(async () => {
      if (key !== this.fingerprint()) return;
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(temporary, JSON.stringify(snapshot) + "\n");
      await rename(temporary, this.file);
    });
    await this.persistence;
  }

  async select(input, { report = null } = {}) {
    const parsed = selectionSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        "RESEARCH_ENVIRONMENT_INVALID",
        "请选择有效环境，不接受脚本或额外参数。",
        { status: 422 },
      );
    const selection = {
      kind: parsed.data.kind,
      prefix: "",
      pythonCommand: "python",
      ...parsed.data,
    };
    const config = structuredClone(this.config);
    config.researchEnvironment = selection;
    const probes = this.probes(config);
    if (selection.kind === "conda") {
      if (!path.isAbsolute(selection.prefix))
        throw new AppError(
          "RESEARCH_ENVIRONMENT_INVALID",
          "Conda 环境需要完整目录路径。",
          { status: 422 },
        );
      let inventory;
      try {
        inventory = await probes.condaEnvironments();
      } catch {
        throw new AppError(
          "CONDA_UNAVAILABLE",
          "无法发现 Conda 环境，请先检查 Conda 配置。",
          { status: 422 },
        );
      }
      if (
        !inventory.environments.some(
          (e) => samePath(e.prefix, selection.prefix) && e.hasPython,
        )
      ) {
        throw new AppError(
          "CONDA_ENVIRONMENT_UNAVAILABLE",
          "此 Conda 环境不存在或未安装 Python，请刷新环境列表。",
          { status: 422 },
        );
      }
    }
    let python;
    try {
      python = await probes.identity();
      if (selection.kind === "conda") {
        const [actual, expected] = await Promise.all([
          realpath(python.prefix),
          realpath(selection.prefix),
        ]);
        if (!samePath(actual, expected))
          throw new Error("Interpreter prefix mismatch");
      }
    } catch {
      throw new AppError(
        "RESEARCH_PYTHON_UNAVAILABLE",
        "目标 Python 无法运行或不属于所选环境，原配置已保留。",
        { status: 422 },
      );
    }
    if (selection.kind === "custom")
      selection.pythonCommand = python.executable;
    const updated = await this.settings.update({
      researchEnvironment: selection,
    });
    await this.applySettings(updated.settings);
    const host = this.state.components.filter(component => component.scope === "host" && component.checkedAt);
    this.reset();
    this.state.components = [
      {
        id: "python",
        scope: "research",
        status: "ready",
        version: python.version,
        location: python.executable,
        python,
        checkedAt: new Date().toISOString(),
      },
      ...host,
    ];
    if (!(await this.adopt(report))) this.start();
  }

  start(componentId = null) {
    this.synchronize();
    if (componentId && (!ids.includes(componentId) || (!this.includeHost && componentId === "nvidia")))
      throw new AppError("RESEARCH_COMPONENT_INVALID", "未知的科研组件。", {
        status: 422,
      });
    if (this.state.status === "running") return;
    const revision = ++this.revision;
    const config = structuredClone(this.config);
    const probes = this.probes(config);
    const requested = componentId ? [componentId] : this.includeHost ? ids : ids.filter(id => id !== "nvidia");
    const previous = this.state.components;
    this.state = {
      status: "running",
      startedAt: new Date().toISOString(),
      checkedAt: this.state.checkedAt,
      components: ids.map((id) =>
        requested.includes(id)
          ? {
              id,
              scope: id === "nvidia" ? "host" : "research",
              status: "pending",
              checkedAt: null,
            }
          : (previous.find((c) => c.id === id) ?? {
              id,
              scope: id === "nvidia" ? "host" : "research",
              status: "unchecked",
              checkedAt: null,
            }),
      ),
    };
    const current = () =>
      this.revision === revision && this.key === this.fingerprint();
    const update = (id, result) => {
      if (!current()) return;
      const index = this.state.components.findIndex((c) => c.id === id);
      this.state.components[index] = {
        ...this.state.components[index],
        ...result,
        checkedAt: new Date().toISOString(),
      };
    };
    const execute = async () => {
      let metadata;
      try {
        metadata = await probes.python("packages", 20000);
        if (metadata.status !== "ready" || !metadata.python?.executable)
          throw new Error("Python metadata unavailable");
        if (requested.includes("python"))
          update("python", {
            status: "ready",
            version: metadata.python.version,
            location: metadata.python.executable,
            python: metadata.python,
          });
        for (const id of [
          "jupyter",
          "tensorboard",
          "wandb",
          "mlflow",
          "torch",
          "jax",
          "tensorflow",
        ]) {
          if (!requested.includes(id)) continue;
          const packageName =
            id === "jupyter"
              ? metadata.packages?.jupyterlab
                ? "jupyterlab"
                : "notebook"
              : id;
          const version = metadata.packages?.[packageName] ?? null;
          update(id, {
            status: version ? "installed" : "not_installed",
            version,
            location: metadata.python.executable,
            packageName,
          });
        }
      } catch {
        for (const id of requested.filter((id) => id !== "nvidia"))
          update(id, {
            status: "error",
            detail: "所选环境无法完成 Python 组件检测。",
          });
      }
      const jobs = [];
      if (requested.includes("nvidia"))
        jobs.push(async () => {
          update("nvidia", { status: "checking" });
          try {
            update("nvidia", await probes.probe("nvidia"));
          } catch {
            update("nvidia", {
              status: "unavailable",
              detail: "未检测到可访问的 NVIDIA GPU 或驱动。",
            });
          }
        });
      if (metadata?.status === "ready" && requested.includes("cuda"))
        jobs.push(async () => {
          update("cuda", { status: "checking" });
          const executable =
            config.toolCommands?.cuda !== "nvcc"
              ? config.toolCommands?.cuda
              : metadata.executables?.nvcc;
          if (!executable) {
            update("cuda", {
              status: "not_installed",
              version: null,
              detail: "此环境未发现 nvcc。",
            });
            return;
          }
          try {
            const result = await probes.environmentCommand(
              executable,
              ["--version"],
              {
                cwd: config.project.root,
                timeoutMs: 12000,
                maxOutputBytes: 8192,
              },
            );
            if (!result.ok) {
              update("cuda", {
                status: result.timedOut ? "timeout" : "error",
                detail: "nvcc 无法返回版本。",
              });
              return;
            }
            const prefix = metadata.python.prefix;
            const paths = this.config.remoteExecution ? path.posix : path;
            const relative = paths.relative(prefix, executable);
            update("cuda", {
              status: "ready",
              ...parseNvccVersion(result.stdout),
              location: executable,
              origin:
                ["conda", "venv"].includes(metadata.python.kind) &&
                relative &&
                !relative.startsWith("..") &&
                !paths.isAbsolute(relative)
                  ? "environment"
                  : "host",
            });
          } catch {
            update("cuda", {
              status: "error",
              detail: "无法解析 CUDA Toolkit 版本。",
            });
          }
        });
      for (const id of ["torch", "jax", "tensorflow"]) {
        if (requested.includes(id) && metadata?.packages?.[id])
          jobs.push(async () => {
            update(id, { status: "checking" });
            try {
              const result = await probes.python(id, 20000);
              update(id, {
                ...result,
                version: result.version ?? metadata.packages[id],
              });
            } catch {
              update(id, {
                status: "error",
                detail: "框架未返回有效检测结果。",
              });
            }
          });
      }
      // Bound simultaneous framework imports and GPU initialization.
      await Promise.all(
        [0, 1].map(async () => {
          while (jobs.length && current()) await jobs.shift()();
        }),
      );
      if (!current()) return;
      this.state.status = "completed";
      this.state.checkedAt = new Date().toISOString();
      const saved = this.view();
      this.persistence = this.persistence
        .catch(() => {})
        .then(async () => {
          if (!current()) return;
          const temporary = `${this.file}.${randomUUID()}.tmp`;
          await mkdir(path.dirname(this.file), { recursive: true });
          await writeFile(temporary, JSON.stringify(saved) + "\n");
          await rename(temporary, this.file);
        });
      await this.persistence;
    };
    this.pending = execute().catch(() => {
      if (current()) {
        this.state.status = "completed";
        for (const c of this.state.components)
          if (["pending", "checking"].includes(c.status))
            Object.assign(c, {
              status: "error",
              detail: "检测未完成，可重试。",
            });
      }
    });
    const task = this.pending;
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }
}
