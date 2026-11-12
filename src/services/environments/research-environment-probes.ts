import { access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { bundledRoot, type AppConfig } from "../../config.js";
import { resolveExecutable, runCommand, type CommandRunner, type CommandOptions } from "../../lib/command.js";
import { probeResultSchema, type PythonIdentity, type ProbeResult, type ComponentResult } from "./environment-types.js";

const defaults = {
  conda: "conda",
  uv: "uv",
  nvidia: "nvidia-smi",
  cuda: "nvcc",
};
const marker = "TOPOLUMIA_PYTHON_PROBE:";
const clip = (value: unknown, limit = 500) => String(value ?? "").slice(0, limit);
const fact = (label: string, labelEn: string, value: unknown, valueEn: string | undefined = undefined) => ({
  label,
  labelEn,
  value: clip(value),
  ...(valueEn ? { valueEn } : {}),
});
const exists = async (value: string | undefined) =>
  value &&
  (await access(value).then(
    () => true,
    () => false,
  ));

export function parseNvidiaGpuCsv(output: string) {
  return output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 16)
    .map((line) => {
      const fields = line
        .match(/(?:"(?:[^"]|"")*"|[^,])+/g)
        ?.map((value) =>
          value.trim().replace(/^"|"$/g, "").replace(/""/g, '"'),
        );
      if (
        !fields ||
        fields.length !== 5 ||
        !/^\d+$/.test(fields[0]) ||
        !fields[1] ||
        !fields[2]
      )
        throw new Error("无法解析 NVIDIA GPU 信息。");
      const memory = (value: string) =>
        /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
      return {
        index: Number(fields[0]),
        name: clip(fields[1], 160),
        driverVersion: clip(fields[2], 80),
        totalMiB: memory(fields[3]),
        freeMiB: memory(fields[4]),
      };
    });
}

export function parseNvccVersion(output: string) {
  const release = output.match(/release\s+(\d+\.\d+)/i)?.[1];
  const version = output.match(/\bV(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? release;
  if (!release || !version)
    throw new Error("配置的命令未返回 CUDA Toolkit 版本。");
  return { version, release };
}

export class ResearchEnvironmentProbes {
  identities = new Map<string, Promise<PythonIdentity>>();
  constructor(public config: AppConfig, public run: CommandRunner = runCommand) {}

  async executable(id: keyof typeof defaults): Promise<string> {
    const command = this.config.toolCommands?.[id] ?? defaults[id];
    if (this.config.remoteExecution) return command;
    const resolved = await resolveExecutable(command);
    if (command !== defaults[id]) {
      if (id === "conda" && /conda\.bat$/i.test(resolved)) {
        const native = path.resolve(
          path.dirname(resolved),
          "../Scripts/conda.exe",
        );
        if (await exists(native)) return native;
      }
      return resolved;
    }
    const candidates = [];
    if (id === "conda") {
      candidates.push(process.env.CONDA_EXE);
      if (process.platform === "win32") {
        if (/conda\.bat$/i.test(resolved))
          candidates.push(
            path.resolve(path.dirname(resolved), "../Scripts/conda.exe"),
          );
        for (const name of [
          "miniconda3",
          "anaconda3",
          "miniforge3",
          "mambaforge",
        ])
          candidates.push(
            path.join(os.homedir(), name, "Scripts", "conda.exe"),
          );
      }
    }
    if (id === "cuda" && process.env.CUDA_PATH)
      candidates.push(
        path.join(
          process.env.CUDA_PATH,
          "bin",
          process.platform === "win32" ? "nvcc.exe" : "nvcc",
        ),
      );
    if (id === "nvidia" && process.platform === "win32") {
      if (process.env.SystemRoot)
        candidates.push(
          path.join(process.env.SystemRoot, "System32", "nvidia-smi.exe"),
        );
      if (process.env.ProgramFiles)
        candidates.push(
          path.join(
            process.env.ProgramFiles,
            "NVIDIA Corporation",
            "NVSMI",
            "nvidia-smi.exe",
          ),
        );
    }
    if (path.isAbsolute(resolved) && !/\.bat$/i.test(resolved)) return resolved;
    for (const candidate of candidates)
      if (candidate && await exists(candidate)) return candidate;
    return resolved;
  }

  async python(mode: string, timeoutMs = 8000): Promise<ProbeResult> {
    const selection = this.config.researchEnvironment ?? { kind: "default", pythonCommand: "python" };
    const result = await this.environmentCommand(
      selection.kind === "conda" ? "python" : selection.pythonCommand,
      [
        "-u",
        path.join(bundledRoot, "scripts", "runtime", "probe-research-python.py"),
        mode,
      ],
      {
        cwd: this.config.project.root,
        timeoutMs,
        maxOutputBytes: mode === "package_inventory" ? 2097152 : 32768,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
          TF_CPP_MIN_LOG_LEVEL: "3",
          XLA_PYTHON_CLIENT_PREALLOCATE: "false",
          CUDA_MODULE_LOADING: "LAZY",
        },
      },
    );
    if (!result.ok)
      return {
        status: result.timedOut ? "timeout" : "error",
        detail: result.timedOut
          ? "检测超时，可稍后重试。"
          : "所选 Python 或其依赖无法完成检测。",
      };
    const line = result.stdout
      .split(/\r?\n/)
      .findLast((line) => line.startsWith(marker));
    if (!line) throw new Error("Python 检测未返回有效结果。");
    const payload = probeResultSchema.parse(JSON.parse(line.slice(marker.length)));
    if (
      !payload ||
      !["ready", "error", "not_installed"].includes(payload.status)
    )
      throw new Error("Python 检测结果格式无效。");
    return payload;
  }

  identity(): Promise<PythonIdentity> {
    const key = `${JSON.stringify(this.config.researchEnvironment)}\0${this.config.project.root}`;
    if (this.identities.has(key)) return this.identities.get(key)!;
    const pending = this.python("identity")
      .then((result) => {
        if (
          result.status !== "ready" ||
          !result.python?.executable ||
          !result.python?.version ||
          !result.python?.prefix
        )
          throw new Error(
            "所选 Python 无法运行环境检测，请检查可执行文件路径。",
          );
        return result.python;
      })
      .finally(() => {
        if (this.identities.get(key) === pending) this.identities.delete(key);
      });
    this.identities.set(key, pending);
    return pending;
  }

  async environmentCommand(command: string, args: string[], options: CommandOptions = {}) {
    const selection = this.config.researchEnvironment;
    if (selection?.kind === "conda") {
      return this.run(await this.executable("conda"),
        ["run", "--no-capture-output", "--prefix", selection.prefix, command, ...args], { ...options, killTree: true });
    }
    return this.run(command, args, options);
  }

  async condaEnvironments() {
    const command = await this.executable("conda");
    const result = await this.run(command, ["info", "--json"], {
      cwd: this.config.project.root, timeoutMs: 12000, maxOutputBytes: 262144,
    });
    if (!result.ok) throw new Error("Conda 无法运行，请检查 Conda 可执行文件配置。");
    let info: { root_prefix: string; envs: unknown[]; conda_version?: unknown };
    try { info = JSON.parse(result.stdout); } catch { throw new Error("Conda 未返回有效环境列表。"); }
    if (typeof info.root_prefix !== "string" || !Array.isArray(info.envs)) throw new Error("Conda 环境列表无效。");
    const prefixes = [...new Set([info.root_prefix, ...info.envs].filter((p): p is string => typeof p === "string" && path.isAbsolute(p)))];
    const environments = await Promise.all(prefixes.slice(0, 200).map(async prefix => ({
      name: prefix === info.root_prefix ? "base" : path.basename(prefix), prefix,
      hasPython: Boolean(await exists(path.join(prefix, process.platform === "win32" ? "python.exe" : "bin/python"))),
    })));
    return { command, version: clip(info.conda_version, 80), environments, total: prefixes.length };
  }

  async probe(id: string): Promise<ComponentResult> {
    if (id === "python") {
      const python = await this.identity();
      return this.describePython(python);
    }
    if (id === "jupyter") {
      const result = await this.python("jupyter");
      const facts = [
        fact(
          "使用的解释器",
          "Selected interpreter",
          result.python?.executable ?? this.config.tensorboard.pythonCommand,
        ),
        ...Object.entries(result.packages ?? {}).map(([name, version]) =>
          fact(name, name, version || "未安装"),
        ),
      ];
      if (result.status !== "ready")
        return {
          status: "unavailable",
          location: clip(
            result.python?.executable ?? this.config.tensorboard.pythonCommand,
          ),
          detail: result.detail ?? "Jupyter 无法导入。",
          recovery:
            "在所选 Python 环境安装 JupyterLab 或 Notebook 后重新检查。",
          facts,
        };
      return {
        status: "ready",
        version: clip(result.version, 80),
        location: clip(result.python?.executable),
        detail: `${result.frontend} ${result.version}`,
        recovery: null,
        facts,
      };
    }
    if (!(id in defaults)) throw new Error("Unknown environment diagnostic");
    const command = await this.executable(id as keyof typeof defaults);
    const options = {
      cwd: this.config.project.root,
      timeoutMs: 8000,
      maxOutputBytes: 65536,
    };
    if (id === "conda") {
      const result = await this.run(
        command,
        ["info", "--json"],
        options,
      );
      if (!result.ok)
        throw new Error("Conda 无法运行，请配置其可执行文件路径。");
      let info: { conda_version: string; root_prefix: string; envs?: unknown[]; active_prefix?: string };
      try {
        info = JSON.parse(result.stdout);
      } catch {
        throw new Error(
          "Conda 未返回有效 JSON，请选择实际的 Conda 可执行文件。",
        );
      }
      if (
        typeof info.conda_version !== "string" ||
        !/^\d+\.\d+/.test(info.conda_version) ||
        typeof info.root_prefix !== "string" ||
        !info.root_prefix
      )
        throw new Error("配置的命令未返回 Conda 环境信息。");
      const environments = (Array.isArray(info.envs) ? info.envs : [])
        .filter((directory) => typeof directory === "string")
        .slice(0, 32)
        .map((directory) => clip(directory));
      return {
        status: "ready",
        version: clip(info.conda_version, 80),
        location: command,
        detail: `Conda ${info.conda_version}`,
        recovery: null,
        facts: [
          fact("基础环境", "Base environment", info.root_prefix),
          fact(
            "服务启动环境",
            "Server startup environment",
            info.active_prefix || "未激活",
          ),
          ...environments.map((directory, index) =>
            fact(`环境 ${index + 1}`, `Environment ${index + 1}`, directory),
          ),
          ...((info.envs?.length ?? 0) > environments.length ? [fact("其余环境数", "Additional environment count", (info.envs?.length ?? 0) - environments.length)] : []),
        ],
      };
    }
    if (id === "uv") {
      const result = await this.run(command, ["--version"], options);
      const version =
        result.ok && result.stdout.match(/^uv\s+(\d+\.\d+\.\d+[^\s]*)/i)?.[1];
      if (!version)
        throw new Error("uv 未安装或无法执行，请检查可执行文件路径。");
      return {
        status: "ready",
        version,
        location: command,
        detail: `uv ${version}`,
        recovery: null,
        facts: [
          fact("命令位置", "Executable", command),
          fact(
            "用途",
            "Purpose",
            "Python 项目依赖与虚拟环境管理",
            "Python dependency and environment management",
          ),
        ],
      };
    }
    if (id === "cuda") {
      const result = await this.run(command, ["--version"], options);
      if (!result.ok)
        throw new Error("未找到可运行的 CUDA Toolkit 编译工具 nvcc。");
      const version = parseNvccVersion(result.stdout);
      return {
        status: "ready",
        version: version.version,
        location: command,
        detail: `CUDA Toolkit ${version.version}`,
        recovery: null,
        facts: [
          fact("Toolkit release", "Toolkit release", version.release),
          fact("nvcc", "nvcc", command),
          fact(
            "检测范围",
            "Scope",
            "系统 CUDA 编译工具；框架运行库在 Python 详情中检测。",
            "System CUDA compiler; inspect framework runtimes in Python details.",
          ),
        ],
      };
    }
    if (id === "nvidia") {
      const result = await this.run(
        command,
        [
          "--query-gpu=index,name,driver_version,memory.total,memory.free",
          "--format=csv,noheader,nounits",
        ],
        options,
      );
      if (!result.ok)
        throw new Error(
          "无法访问 NVIDIA GPU 或驱动，请检查驱动安装与设备状态。",
        );
      const gpus = parseNvidiaGpuCsv(result.stdout);
      if (!gpus.length) throw new Error("未检测到可用的 NVIDIA GPU。");
      const banner = await this.run(command, [], {
        ...options,
        maxOutputBytes: 32768,
      });
      const driverCudaMax = banner.ok
        ? (banner.stdout.match(/CUDA(?: UMD)? Version:\s*([\d.]+)/)?.[1] ?? null)
        : null;
      return {
        status: "ready",
        version: gpus[0].driverVersion,
        summary: `${gpus[0].name}${gpus.length > 1 ? ` +${gpus.length - 1}` : ""} · ${gpus[0].driverVersion}`,
        location: command,
        detail: `${gpus.length} 个 NVIDIA GPU，驱动 ${gpus[0].driverVersion}`,
        recovery: null,
        gpus,
        driverCudaMax,
        facts: [
          fact("驱动版本", "Driver version", gpus[0].driverVersion),
          ...(driverCudaMax
            ? [
                fact(
                  "驱动支持的 CUDA 上限",
                  "Driver CUDA compatibility",
                  driverCudaMax,
                ),
              ]
            : []),
          ...gpus.map((gpu) =>
            fact(
              `GPU ${gpu.index}`,
              `GPU ${gpu.index}`,
              `${gpu.name} · ${gpu.freeMiB ?? "?"}/${gpu.totalMiB ?? "?"} MiB free`,
            ),
          ),
        ],
      };
    }
    throw new Error("Unknown environment diagnostic");
  }

  async inspectPython() {
    const python = await this.identity();
    const frameworks = [];
    for (const id of ["torch", "jax", "tensorflow"]) {
      try {
        frameworks.push({ id, ...(await this.python(id, 15000)) });
      } catch {
        frameworks.push({
          id,
          status: "error",
          detail: "此框架未能返回有效检测结果。",
        });
      }
    }
    return { python, frameworks, checkedAt: new Date().toISOString() };
  }

  describePython(python: PythonIdentity): ComponentResult {
    return {
      status: "ready",
      version: clip(python.version, 80),
      location: clip(python.executable),
      python,
      detail: `Python ${python.version}`,
      recovery: null,
      facts: [
        fact("解释器", "Interpreter", python.executable),
        fact("环境类型", "Environment type", python.kind),
        fact("环境目录", "Environment directory", python.prefix),
        ...(python.projectVenv
          ? [fact("项目 .venv", "Project .venv", python.projectVenv)]
          : []),
      ],
    };
  }
}
