import { access, stat } from "node:fs/promises";
import * as z from "zod/v4";
import { AppError } from "../../lib/errors.js";
import { runCommand } from "../../lib/command.js";
import { ResearchEnvironmentProbes } from "./research-environment-probes.js";
import { ResearchEnvironmentService } from "./research-environment-service.js";
import { EnvironmentCatalogService } from "./environment-catalog-service.js";
import { withEnvironmentCapacity } from "./environment-capacity.js";

const value = z.string().max(500);
const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(120);
const schemas = {
  python: z.strictObject({ command: value.min(1) }),
  conda: z.strictObject({ command: value.min(1) }),
  uv: z.strictObject({ command: value.min(1) }),
  nvidia: z.strictObject({ command: value.min(1) }),
  cuda: z.strictObject({ command: value.min(1) }),
  mlflow: z.strictObject({
    baseUrl: value,
    experimentName: value.min(1),
    experimentId: value.max(120),
    tokenEnv: envName,
  }),
  wandb: z.strictObject({
    baseUrl: value,
    entity: value.min(1),
    project: value.min(1),
    tokenEnv: envName,
  }),
  tensorboard: z.strictObject({ logdir: value, pythonCommand: value.min(1).optional() }),
};

const definitions = [
  {
    id: "workspace",
    label: "项目目录",
    description: "当前项目的工作目录",
    group: "environment",
  },
  {
    id: "node",
    label: "Node.js",
    description: "Topolumia 自身的运行时，独立于项目科研环境",
    group: "environment",
    category: "application",
  },
  {
    id: "python",
    label: "Python",
    description: "当前项目的科研 Python 环境与组件检测",
    group: "environment",
  },
  {
    id: "conda",
    label: "Conda",
    description: "Python 与原生依赖的环境管理器",
    group: "environment",
  },
  {
    id: "uv",
    label: "uv",
    description: "Python 项目依赖与虚拟环境管理器",
    group: "environment",
  },
  {
    id: "nvidia",
    label: "NVIDIA GPU / 驱动",
    description: "显卡、驱动与驱动支持的 CUDA 上限",
    group: "environment",
    category: "acceleration",
  },
  {
    id: "cuda",
    label: "CUDA Toolkit",
    description: "当前科研环境可见的 CUDA Toolkit 编译工具，与框架运行库分别检测",
    group: "environment",
    category: "acceleration",
  },
  {
    id: "git",
    label: "Git",
    description: "当前项目的代码仓库与工作区",
    group: "tools",
  },
  {
    id: "docker",
    label: "Docker",
    description: "本机容器运行引擎",
    group: "tools",
  },
  {
    id: "jupyter",
    label: "Jupyter",
    description: "在所选 Python 解释器中检查 JupyterLab / Notebook",
    group: "tools",
    category: "experiments",
  },
  {
    id: "mlflow",
    label: "MLflow",
    description: "实验跟踪服务",
    group: "tools",
  },
  {
    id: "wandb",
    label: "Weights & Biases",
    description: "实验跟踪服务",
    group: "tools",
  },
  {
    id: "tensorboard",
    label: "TensorBoard",
    description: "本地实验事件日志",
    group: "tools",
  },
];
for (const [id, label] of [["torch", "PyTorch"], ["jax", "JAX"], ["tensorflow", "TensorFlow"]]) {
  definitions.push({ id, label, description: "所选科研环境中的框架与 GPU 能力", group: "tools", category: "acceleration" });
}

export class ToolEnvironmentService {
  constructor({
    config,
    registry,
    userSettings,
    applySettings,
    commandRunner = runCommand,
  }) {
    Object.assign(this, {
      config,
      registry,
      userSettings,
      applySettings,
      commandRunner,
    });
    this.results = new Map();
    this.inFlight = new Map();
    this.generation = 0;
    this.configurationQueue = Promise.resolve();
    this.researchEnvironment = new ResearchEnvironmentProbes(
      config,
      (...args) => this.commandRunner(...args),
    );
    this.pythonInspection = null;
    this.runtimeCheckedAt = new Date().toISOString();
    this.research = new ResearchEnvironmentService({ config, settings: userSettings, applySettings,
      commandRunner: (...args) => withEnvironmentCapacity(() => this.commandRunner(...args)) });
    this.catalog = new EnvironmentCatalogService({ config, settings: userSettings,
      commandRunner: (...args) => this.commandRunner(...args),
      activate: (selection, options) => this.selectEnvironment(selection, options),
      currentReport: () => this.research.view() });
  }

  async initialize() { await this.research.initialize(); await this.catalog.initialize(); }

  queueConfiguration(operation) {
    const pending = this.configurationQueue.then(operation);
    this.configurationQueue = pending.catch(() => {});
    return pending;
  }

  selectEnvironment(input, options = {}) {
    return this.queueConfiguration(async () => {
    await this.research.select(input, options);
    if (this.userSettings.settings.researchLocation === "ssh") {
      const updated = await this.userSettings.update({ researchLocation: "local" });
      await this.applySettings(updated.settings);
    }
    this.generation++;
    this.pythonInspection = null;
    for (const id of ["python", "cuda", "jupyter", "torch", "jax", "tensorflow"]) this.results.delete(id);
    this.research.synchronize();
    return this.inventory();
    });
  }

  entries() {
    return definitions;
  }

  configuration(id) {
    const settings = this.userSettings.settings.sources;
    if (id === "python") return { command: this.config.researchEnvironment.pythonCommand };
    if (["conda", "uv", "nvidia", "cuda"].includes(id))
      return { command: this.userSettings.settings.tools[id].command };
    if (id === "mlflow") {
      const { baseUrl, experimentName, experimentId, tokenEnv } =
        settings.mlflow;
      return { baseUrl, experimentName, experimentId, tokenEnv };
    }
    if (id === "wandb") {
      const { baseUrl, entity, project, tokenEnv } = settings.wandb;
      return { baseUrl, entity, project, tokenEnv };
    }
    if (id === "tensorboard") return { logdir: settings.tensorboard.logdir, pythonCommand: settings.tensorboard.pythonCommand };
    return null;
  }

  configured(id) {
    if (id === "mlflow" || id === "wandb")
      return Boolean(this.config[id].baseUrl);
    if (id === "tensorboard") return Boolean(this.config.tensorboard.logdir);
    return true;
  }

  inventory() {
    const researchEnvironment = this.research.view();
    const items = this.entries().map((entry) => {
      const configuration = this.configuration(entry.id);
      const configured = this.configured(entry.id);
      const result = this.results.get(entry.id);
      const env = configuration?.tokenEnv;
      let component = researchEnvironment.components.find(c => c.id === entry.id);
      if (entry.id === "nvidia" && result?.checkedAt && (!component?.checkedAt || result.checkedAt > component.checkedAt)) component = { ...result, id: "nvidia", scope: "host" };
      const runtime = entry.id === "node" ? { status: "ready", version: process.versions.node, location: process.execPath,
        detail: "Topolumia 运行时", scope: "application", checkedAt: this.runtimeCheckedAt } : {};
      return {
        ...entry,
        category:
          entry.category ??
          (entry.group === "environment"
            ? "environment"
            : ["git", "docker"].includes(entry.id)
              ? "development"
              : "experiments"),
        configurable: Object.hasOwn(schemas, entry.id),
        configuration,
        credential: env
          ? { environmentVariable: env, available: Boolean(process.env[env]) }
          : null,
        status: configured ? "unchecked" : "not_configured",
        detail: configured ? "尚未检查" : "请先配置连接",
        checkedAt: null,
        recovery: null,
        ...result,
        ...runtime,
        ...(component ? { component, status: component.status, checkedAt: component.checkedAt,
          detail: component.detail, facts: component.facts ?? [], location: component.location,
          summary: component.summary, version: component.version,
          ...(entry.id === "python" && component.python ? { location: component.location, summary: `${researchEnvironment.name} · Python ${component.version}` } : {}) } : {}),
        ...(["tensorboard", "wandb", "mlflow"].includes(entry.id) ? {
          connection: { status: configured ? result?.status ?? "unchecked" : "not_configured", detail: result?.detail, checkedAt: result?.checkedAt ?? null },
        } : {}),
        ...(entry.id === "python"
          ? { pythonInspection: this.pythonInspection }
          : {}),
      };
    });
    return {
      schemaVersion: "tools-environment.v3",
      project: {
        id: this.config.project.id,
        name: this.config.project.name,
        directory: this.config.project.root,
      },
      location: "local",
      platform: process.platform,
      researchEnvironment,
      environment: items.filter((item) => item.group === "environment"),
      tools: items.filter((item) => item.group === "tools"),
    };
  }

  async configure(id, input) {
    if (!Object.hasOwn(schemas, id))
      throw new AppError(
        "TOOL_NOT_CONFIGURABLE",
        "此工具的运行位置由当前项目或本机安装决定。",
        { status: 404 },
      );
    const parsed = schemas[id].safeParse(input);
    if (!parsed.success)
      throw new AppError("TOOL_CONFIGURATION_INVALID", "工具配置格式不正确。", {
        status: 422,
        detail: {
          fields: parsed.error.issues.map((issue) => issue.path.join(".")),
        },
      });
    if (id === "python") return this.selectEnvironment({ kind: "custom", pythonCommand: parsed.data.command });
    const update = async () => {
      const settings = { [id]: parsed.data };
      const updated = await this.userSettings.update(
        ["conda", "uv", "nvidia", "cuda"].includes(id)
          ? { tools: { [id]: parsed.data } }
          : { sources: settings },
      );
      await this.applySettings(updated.settings);
      this.invalidate();
      return this.inventory();
    };
    const pending = this.configurationQueue.then(update);
    this.configurationQueue = pending.catch(() => {});
    return pending;
  }

  invalidate() {
    this.generation++;
    this.results.clear();
    this.pythonInspection = null;
    this.research?.synchronize();
    this.catalog?.synchronize();
  }

  async inspectPython() {
    const generation = this.generation;
    const key = `${generation}:python-inspect`;
    if (!this.inFlight.has(key)) {
      const pending = this.researchEnvironment
        .inspectPython()
        .then((result) => {
          if (this.generation === generation) {
            this.pythonInspection = result;
            this.results.set("python", {
              ...this.researchEnvironment.describePython(result.python),
              checkedAt: result.checkedAt,
            });
          }
        })
        .catch((error) => {
          if (this.generation === generation)
            this.pythonInspection = {
              status: "error",
              detail: this.safeDetail(error.message),
              frameworks: [],
              checkedAt: new Date().toISOString(),
            };
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    await this.inFlight.get(key);
    return this.inventory();
  }

  async check(id = null) {
    if (!id || ["cuda", "torch", "jax", "tensorflow"].includes(id)) this.research.start(id ?? null);
    const entries = this.entries();
    const selected = id ? entries.filter((entry) => entry.id === id) : entries;
    if (!selected.length)
      throw new AppError("TOOL_NOT_FOUND", "没有找到指定工具。", {
        status: 404,
      });
    const generation = this.generation;
    await Promise.all(
      selected.map((entry) => {
        const key = `${generation}:${entry.id}`;
        if (this.inFlight.has(key)) return this.inFlight.get(key);
        const pending = this.probe(entry)
          .then((result) => {
            if (this.generation === generation)
              this.results.set(entry.id, {
                ...result,
                checkedAt: new Date().toISOString(),
              });
          })
          .finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, pending);
        return pending;
      }),
    );
    return this.inventory();
  }

  safeDetail(raw) {
    let detail = String(raw ?? "检查失败").replace(
      /; fixture fallback available/gi,
      "",
    );
    for (const key of [
      this.config.mlflow.tokenEnv,
      this.config.wandb.tokenEnv,
    ]) {
      const secret = process.env[key];
      if (secret) detail = detail.split(secret).join("[redacted]");
    }
    const lines = detail
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return (
      lines.find((line) =>
        /error:|failed|cannot|unable|fatal|not found|ENOENT/i.test(line),
      ) ??
      lines[0] ??
      "检查失败"
    ).slice(0, 260);
  }

  async probe(entry) {
    const ready = (detail) => ({ status: "ready", detail, recovery: null });
    const failure = (detail, recovery) => ({
      status: "unavailable",
      detail: this.safeDetail(detail),
      recovery,
    });
    try {
      if (!this.configured(entry.id))
        return {
          status: "not_configured",
          detail: "尚未配置真实连接",
          recovery: "配置服务地址或本地日志目录后测试连接。",
        };
      if (entry.id === "workspace") {
        const directory = await stat(this.config.project.root);
        if (!directory.isDirectory())
          return failure(
            "项目路径不是目录",
            "检查项目工作目录是否存在且可访问。",
          );
        await access(this.config.project.root);
        return ready(this.config.project.root);
      }
      if (entry.id === "node") return ready(`Node.js ${process.version}`);
      if (["torch", "jax", "tensorflow"].includes(entry.id)) return ready("科研环境检测中");
      if (entry.id === "python") {
        return await this.researchEnvironment.probe("python");
      }
      if (["conda", "uv", "nvidia", "cuda", "jupyter"].includes(entry.id))
        return await this.researchEnvironment.probe(entry.id);
      if (entry.id === "mlflow") {
        const config = this.config.mlflow;
        const query = config.experimentId
          ? `get?experiment_id=${encodeURIComponent(config.experimentId)}`
          : `get-by-name?experiment_name=${encodeURIComponent(config.experimentName)}`;
        const { experiment } = await this.registry.mlflow.request(
          `/api/2.0/mlflow/experiments/${query}`,
        );
        if (
          !experiment ||
          (config.experimentId
            ? experiment.experiment_id !== config.experimentId
            : experiment.name !== config.experimentName)
        )
          return failure(
            "服务可访问，但找不到指定实验或当前凭据无权读取。",
            "检查实验名称、ID 和访问权限。",
          );
        return ready(
          `实验连接可用 · ${experiment.name ?? experiment.experiment_id}`,
        );
      }
      if (entry.id === "wandb") {
        const config = this.config.wandb;
        const result = await this.registry.wandb.requestGraphql(
          "query ToolConnection($entity: String!, $project: String!) { project(name: $project, entityName: $entity) { id name } }",
          { entity: config.entity, project: config.project },
        );
        if (!result.project?.id)
          return failure(
            "服务可访问，但找不到指定 W&B 项目或当前凭据无权读取。",
            "检查组织、项目名称和访问权限。",
          );
        return ready(`项目连接可用 · ${config.entity}/${config.project}`);
      }
      const health = await this.registry[entry.id].health();
      if (health.status !== "ready")
        return failure(
          health.detail,
          entry.id === "git"
            ? "确认项目目录属于 Git 仓库。"
            : entry.id === "docker"
              ? "启动 Docker Engine 后重试。"
              : "检查配置、访问权限和运行依赖后重试。",
        );
      return ready(health.detail);
    } catch (error) {
      return failure(error.message, "检查配置、访问权限和运行依赖后重试。");
    }
  }
}
