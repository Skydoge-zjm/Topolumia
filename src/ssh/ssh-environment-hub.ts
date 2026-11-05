import path from "node:path";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { bundledRoot } from "../config.js";
import { AppError } from "../lib/errors.js";
import { EnvironmentCatalogService } from "../services/environments/environment-catalog-service.js";
import { ResearchEnvironmentProbes } from "../services/environments/research-environment-probes.js";
import { cachedEnvironmentInspection } from "../services/environments/research-environment-context.js";

const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const command = z
  .string()
  .trim()
  .max(500)
  .regex(/^[^\x00-\x1f\x7f]*$/);
const projectSchema = z.strictObject({
  directory: command.optional(),
  pythonCommand: command.optional(),
  condaCommand: command.optional(),
  cudaCommand: command.optional(),
  nvidiaCommand: command.optional(),
  uvCommand: command.optional(),
});

function remoteConfig(runtime, settings, info) {
  const config = structuredClone(runtime.config);
  config.project.root = settings.directory || info.home;
  config.remoteExecution = true;
  config.researchEnvironment = { kind: "default", prefix: "", pythonCommand: settings.pythonCommand || info.python };
  config.toolCommands = Object.fromEntries(
    ["conda", "cuda", "nvidia", "uv"].map(tool => [tool, settings[`${tool}Command`] || info.tools?.[tool] ||
      { conda: "conda", cuda: "nvcc", nvidia: "nvidia-smi", uv: "uv" }[tool]]),
  );
  return config;
}

export class SshEnvironmentHub {
  constructor(ssh) {
    this.ssh = ssh;
    this.views = new Map();
    this.pendingViews = new Map();
    this.tasks = new Set();
    this.unsubscribe = ssh.onChange((owner, id, kind) => {
      if (["updated", "removed"].includes(kind)) {
        for (const [key, view] of this.views)
          if (view.owner === owner && view.id === id) {
            this.track(view.catalog.close());
            this.views.delete(key);
          }
      }
    });
  }
  track(task) {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
  settingsFile(runtime, owner, id) {
    return path.join(
      path.dirname(runtime.userSettings.filePath),
      "ssh-projects",
      this.ssh.userKey(owner),
      id,
      "project.json",
    );
  }
  async projectSettings(runtime, owner, id) {
    await this.ssh.profile(owner, id);
    try {
      const raw = await readFile(this.settingsFile(runtime, owner, id), "utf8");
      if (raw.length < 16384) return projectSchema.parse(JSON.parse(raw));
    } catch {}
    return {};
  }
  async remoteProbe(owner, id, mode, options = {}) {
    const session = await this.ssh.connected(owner, id);
    if (session.infoTask) await session.infoTask;
    let python = options.pythonCommand || session.info?.python;
    if (python?.startsWith("~/") && session.info?.home)
      python = path.posix.join(session.info.home, python.slice(2));
    if (!python)
      throw new AppError(
        "SSH_PYTHON_UNAVAILABLE",
        "SSH 已连接，但远程没有可运行的 Python，请设置远程解释器路径。",
        { status: 422 },
      );
    const script = await readFile(
      path.join(bundledRoot, "scripts", "runtime", "probe-remote-environment.py"),
      "utf8",
    );
    const result = await this.ssh.run(
      owner,
      id,
      python,
      ["-u", "-", mode, JSON.stringify(options)],
      { input: script, timeoutMs: 30000, maxOutputBytes: 1048576 },
    );
    const line = result.stdout
      .split(/\r?\n/)
      .findLast((line) => line.startsWith("TOPOLUMIA_REMOTE_PROBE:"));
    if (!result.ok || !line)
      throw new AppError(
        "SSH_REMOTE_PROBE_FAILED",
        "远程环境检测没有完成，请检查解释器和工具路径。",
        { status: 422 },
      );
    const value = JSON.parse(line.slice("TOPOLUMIA_REMOTE_PROBE:".length));
    if (value.status !== "ready")
      throw new AppError(
        "SSH_REMOTE_PROBE_FAILED",
        "远程目录不可访问，或所需环境管理器未找到。",
        { status: 422 },
      );
    return value;
  }
  async info(owner, id, pythonCommand = undefined) {
    const profile = await this.ssh.profile(owner, id);
    const session = this.ssh.sessions.get(this.ssh.sessionKey(owner, id));
    if (session?.status !== "connected") {
      if (profile.lastInfo?.tools && profile.lastInfo?.home)
        return profile.lastInfo;
      throw new AppError(
        "SSH_NOT_CONNECTED",
        "先连接 SSH 主机，才能发现远程环境。",
        { status: 409 },
      );
    }
    if (!session.remoteInfoTask)
      session.remoteInfoTask = this.remoteProbe(owner, id, "info", {
        pythonCommand,
      })
        .then(async (info) => {
          session.info = { ...info, status: "ready" };
          profile.lastInfo = session.info;
          await this.ssh.persist(owner);
          return session.info;
        })
        .catch((error) => {
          session.remoteInfoTask = null;
          throw error;
        });
    return session.remoteInfoTask;
  }
  updateProject(runtime, owner, id, input) {
    return runtime.toolEnvironment.queueConfiguration(() =>
      this.writeProject(runtime, owner, id, input),
    );
  }
  async writeProject(runtime, owner, id, input) {
    const parsed = projectSchema.safeParse(input);
    if (!parsed.success || !Object.keys(parsed.data).length)
      throw new AppError(
        "SSH_PROJECT_SETTINGS_INVALID",
        "远程目录或工具路径配置无效。",
        { status: 422 },
      );
    const previous = await this.projectSettings(runtime, owner, id),
      settings = { ...previous, ...parsed.data };
    if (parsed.data.pythonCommand)
      await this.remoteProbe(owner, id, "info", {
        pythonCommand: parsed.data.pythonCommand,
      });
    if (parsed.data.directory) {
      const value = await this.remoteProbe(owner, id, "directory", {
        directory: parsed.data.directory,
        pythonCommand: settings.pythonCommand,
      });
      settings.directory = value.directory;
    }
    const file = this.settingsFile(runtime, owner, id),
      temporary = `${file}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(settings), { mode: 0o600 });
    await rename(temporary, file);
    for (const [key, view] of this.views)
      if (view.runtime === runtime && view.owner === owner && view.id === id) {
        await view.catalog.close();
        this.views.delete(key);
      }
    return settings;
  }
  async currentBinding(runtime, owner) {
    const settings = runtime.userSettings.settings;
    if (settings.researchLocation === "ssh" && settings.remoteEnvironment) {
      const ref = settings.remoteEnvironment;
      let profile = null;
      if (ref.ownerId === owner) {
        try {
          profile = await this.ssh.profile(owner, ref.connectionId);
        } catch {}
      }
      const session = profile
        ? this.ssh.sessions.get(this.ssh.sessionKey(owner, profile.id))
        : null;
      return {
        kind: "ssh",
        name: ref.name,
        hostLabel: profile?.name ?? ref.hostLabel,
        connectionId: ref.ownerId === owner ? ref.connectionId : null,
        source: ref.source,
        accessible: Boolean(profile),
        connected: session?.status === "connected",
        needsReview: !profile || profile.revision !== ref.revision,
      };
    }
    const selected = runtime.config.researchEnvironment;
    return {
      kind: "local",
      name:
        selected.kind === "conda"
          ? path.basename(selected.prefix)
          : selected.kind,
      source: selected.kind === "conda" ? "conda" : "python",
      hostLabel: "本机",
      connected: true,
      accessible: true,
      needsReview: false,
    };
  }
  // Unlike get(), this only reads configuration and existing cache files.
  // A briefing must never open SSH, discover environments, or run diagnostics.
  async contextSnapshot(runtime, owner) {
    const ref = runtime.userSettings.settings.remoteEnvironment;
    if (!ref || ref.ownerId !== owner)
      throw new AppError("SSH_ENVIRONMENT_OWNER_MISMATCH", "此远程环境属于其他用户，请在工具与环境中选择你可用的连接。", { status: 403 });
    const profile = await this.ssh.profile(owner, ref.connectionId);
    if (profile.revision !== ref.revision)
      throw new AppError("SSH_CONFIGURATION_CHANGED", "SSH 配置已变化，请在工具与环境中重新确认所选环境。", { status: 409 });
    if (!/^[a-f0-9]{24}$/.test(ref.environmentId))
      throw new AppError("ENVIRONMENT_NOT_FOUND", "所选远程环境标识无效，请重新选择环境。", { status: 409 });
    const settings = await this.projectSettings(runtime, owner, ref.connectionId);
    const session = this.ssh.sessions.get(this.ssh.sessionKey(owner, ref.connectionId));
    const info = { ...profile.lastInfo, ...session?.info,
      tools: { ...profile.lastInfo?.tools, ...session?.info?.tools } };
    const identity = hash([runtime.config.project.id, owner, ref.connectionId, profile.revision, settings]);
    const view = this.views.get(identity);
    const config = remoteConfig(runtime, settings, info);
    const selection = ref.source === "conda" ? { kind: "conda", prefix: ref.prefix } : { kind: "custom", pythonCommand: ref.pythonCommand };
    const inspectedConfig = { ...config, researchEnvironment: { kind: "default", prefix: "", pythonCommand: "python", ...selection } };
    const fingerprint = hash([config.project.root, inspectedConfig.researchEnvironment, config.toolCommands]);
    const cache = path.join(path.dirname(this.settingsFile(runtime, owner, ref.connectionId)),
      `cache-${profile.revision}-${identity}`, "environment-catalog", ref.environmentId, "research-environment.json");
    const inspection = view?.catalog.workers.get(ref.environmentId)?.worker.view() ?? await cachedEnvironmentInspection(cache, fingerprint);
    return {
      host: { kind: "ssh", label: profile.name, platform: info.platform ?? null,
        connected: session?.status === "connected",
        ...(profile.mode === "alias" ? { alias: profile.alias } : { hostname: profile.host, user: profile.user, port: profile.port }) },
      directory: config.project.root ?? null, name: ref.name, selection, toolCommands: config.toolCommands,
      inspection, tools: [...(view?.results ?? [])].map(([id, item]) => ({ id, ...item })),
    };
  }
  async get(runtime, owner, id) {
    const profile = await this.ssh.profile(owner, id);
    const settings = await this.projectSettings(runtime, owner, id);
    const identity = hash([
      runtime.config.project.id,
      owner,
      id,
      profile.revision,
      settings,
    ]);
    if (this.views.has(identity)) return this.views.get(identity);
    if (this.pendingViews.has(identity)) return this.pendingViews.get(identity);
    const pending = this.createView(
      runtime,
      owner,
      id,
      profile,
      settings,
      identity,
    );
    this.pendingViews.set(identity, pending);
    try {
      return await pending;
    } finally {
      this.pendingViews.delete(identity);
    }
  }
  async createView(runtime, owner, id, profile, settings, identity) {
    const info = await this.info(owner, id, settings.pythonCommand);
    if (!["Linux", "Darwin"].includes(info.platform))
      throw new AppError(
        "SSH_PLATFORM_UNSUPPORTED",
        "SSH 登录可用；远程环境检测目前支持 Linux、WSL 和 macOS。",
        { status: 422 },
      );
    const config = remoteConfig(runtime, settings, info);
    const expand = (value) =>
      typeof value === "string" && value.startsWith("~/")
        ? path.posix.join(info.home, value.slice(2))
        : value;
    const runner = (command, args, options = {}) =>
      this.ssh.run(owner, id, expand(command), args.map(expand), {
        ...options,
        cwd: expand(options.cwd ?? config.project.root),
      });
    const view = {
      runtime,
      owner,
      id,
      profile,
      settings,
      config,
      info,
      runner,
      results: new Map(),
      catalog: null,
    };
    const file = path.join(
      path.dirname(this.settingsFile(runtime, owner, id)),
      `cache-${profile.revision}-${identity}`,
      "settings.json",
    );
    const remote = {
      id: `${owner}:${id}:${profile.revision}`,
      available: () =>
        this.ssh.sessions.get(this.ssh.sessionKey(owner, id))?.status ===
        "connected",
      isCurrent: (entry) => {
        const current = runtime.userSettings.settings.remoteEnvironment;
        return (
          runtime.userSettings.settings.researchLocation === "ssh" &&
          current?.ownerId === owner &&
          current.connectionId === id &&
          current.environmentId === entry.id &&
          current.revision === profile.revision
        );
      },
      discover: (source) =>
        this.remoteProbe(owner, id, "discover", { ...settings, source }),
    };
    view.catalog = new EnvironmentCatalogService({
      config,
      remote,
      settings: { filePath: file },
      commandRunner: runner,
      currentReport: () => null,
      activate: (selection) =>
        runtime.toolEnvironment.queueConfiguration(async () => {
          await this.ssh.connected(owner, id);
          const latest = await this.ssh.profile(owner, id);
          if (latest.revision !== profile.revision)
            throw new AppError(
              "SSH_CONFIGURATION_CHANGED",
              "SSH 配置已变化，请刷新环境。",
              { status: 409 },
            );
          const candidate = [...view.catalog.entries.values()].find(
            (entry) =>
              JSON.stringify(entry.selection) === JSON.stringify(selection),
          );
          if (!candidate)
            throw new AppError(
              "ENVIRONMENT_NOT_FOUND",
              "环境已变化，请刷新后重试。",
              { status: 404 },
            );
          const probeConfig = structuredClone(config);
          probeConfig.researchEnvironment = {
            kind: "default",
            prefix: "",
            pythonCommand: info.python,
            ...selection,
          };
          const python = await new ResearchEnvironmentProbes(
            probeConfig,
            runner,
          )
            .identity()
            .catch(() => {
              throw new AppError(
                "SSH_ENVIRONMENT_UNAVAILABLE",
                "远程 Python 无法验证，原项目环境已保留。",
                { status: 422 },
              );
            });
          if (
            candidate.source !== "python" &&
            path.posix.normalize(python.prefix) !==
              path.posix.normalize(candidate.prefix)
          )
            throw new AppError(
              "SSH_ENVIRONMENT_MISMATCH",
              "实际解释器与所选远程环境不一致。",
              { status: 422 },
            );
          await runtime.userSettings.update({
            researchLocation: "ssh",
            remoteEnvironment: {
              ownerId: owner,
              connectionId: id,
              environmentId: candidate.id,
              name: candidate.name,
              source: candidate.source,
              prefix: candidate.prefix,
              pythonCommand: candidate.pythonCommand,
              hostLabel: profile.name,
              revision: profile.revision,
            },
          });
        }),
    });
    await view.catalog.initialize();
    this.views.set(identity, view);
    return view;
  }
  async catalog(runtime, owner, id) {
    return (await this.get(runtime, owner, id)).catalog;
  }
  async inventory(runtime, owner, id) {
    const view = await this.get(runtime, owner, id);
    const local = runtime.toolEnvironment.inventory();
    const remoteItem = (item) => {
      if (
        item.id === "node" ||
        ["mlflow", "wandb", "tensorboard"].includes(item.id)
      )
        return item;
      if (!["nvidia", "git", "docker", "uv", "cuda", "conda"].includes(item.id))
        return item;
      const command =
        view.config.toolCommands[item.id] ||
        view.info.tools[item.id] ||
        item.id;
      return {
        ...item,
        component: undefined,
        facts: [],
        summary: undefined,
        version: undefined,
        status: "unchecked",
        checkedAt: null,
        detail: "尚未检查远程工具",
        location: command,
        configuration: item.configurable ? { command } : null,
        ...view.results.get(item.id),
      };
    };
    return {
      ...local,
      researchEnvironment: undefined,
      location: "ssh",
      platform: view.info.platform,
      locationName: view.profile.name,
      project: { ...local.project, directory: view.config.project.root },
      environment: local.environment.map(remoteItem),
      tools: local.tools.map(remoteItem),
    };
  }
  async checkTool(runtime, owner, id, toolId) {
    const view = await this.get(runtime, owner, id);
    if (["mlflow", "wandb", "tensorboard"].includes(toolId)) {
      await runtime.toolEnvironment.check(toolId);
      return this.inventory(runtime, owner, id);
    }
    try {
      let result;
      if (["nvidia", "uv", "conda"].includes(toolId))
        result = await new ResearchEnvironmentProbes(
          view.config,
          view.runner,
        ).probe(toolId);
      else if (["git", "docker"].includes(toolId)) {
        const command = view.info.tools[toolId] || toolId;
        const checked = await view.runner(command, ["--version"], {
          timeoutMs: 8000,
          maxOutputBytes: 8192,
        });
        if (!checked.ok) throw new Error("Remote tool unavailable");
        result = {
          status: "ready",
          location: command,
          version: checked.stdout.match(/\d+\.\d+(?:\.\d+)?/)?.[0],
          detail: checked.stdout.trim().slice(0, 200),
        };
      } else if (toolId === "node") return this.inventory(runtime, owner, id);
      else
        throw new AppError(
          "SSH_TOOL_UNSUPPORTED",
          "此远程工具请在具体环境中检测。",
          { status: 422 },
        );
      view.results.set(toolId, {
        ...result,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      view.results.set(toolId, {
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        detail: "远程工具不可用，请检查安装和路径。",
      });
    }
    return this.inventory(runtime, owner, id);
  }
  async configureTool(runtime, owner, id, toolId, input) {
    if (["conda", "cuda", "nvidia", "uv"].includes(toolId)) {
      if (
        !input ||
        Object.keys(input).length !== 1 ||
        typeof input.command !== "string"
      )
        throw new AppError(
          "SSH_TOOL_CONFIGURATION_INVALID",
          "请输入远程工具可执行文件路径。",
          { status: 422 },
        );
      await this.updateProject(runtime, owner, id, {
        [`${toolId}Command`]: input.command,
      });
      return this.inventory(runtime, owner, id);
    }
    if (!["mlflow", "wandb", "tensorboard"].includes(toolId))
      throw new AppError(
        "SSH_TOOL_UNSUPPORTED",
        "请选择具体远程环境，或配置远程工具路径。",
        { status: 422 },
      );
    await runtime.toolEnvironment.configure(toolId, input);
    return this.inventory(runtime, owner, id);
  }
  async close() {
    this.unsubscribe();
    await Promise.allSettled([...this.pendingViews.values()]);
    await Promise.allSettled([
      ...this.tasks,
      ...[...this.views.values()].map((view) => view.catalog.close()),
    ]);
    this.views.clear();
  }
}
