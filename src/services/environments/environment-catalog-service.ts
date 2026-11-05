import path from "node:path";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors.js";
import { ResearchEnvironmentProbes } from "./research-environment-probes.js";
import { ResearchEnvironmentService } from "./research-environment-service.js";
import { withEnvironmentCapacity } from "./environment-capacity.js";

const sourceIds = ["python", "conda", "venv"];
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );
const keyPath = (value) =>
  process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const canonical = async (value) =>
  realpath(value).catch(() => path.resolve(value));
const pythonAt = (prefix, source = "conda") =>
  path.join(
    prefix,
    process.platform === "win32"
      ? source === "venv"
        ? "Scripts/python.exe"
        : "python.exe"
      : "bin/python",
  );
const emptyPackages = () => ({
  status: "unchecked",
  checkedAt: null,
  items: [],
  detail: null,
});

export class EnvironmentCatalogService {
  constructor({ config, settings, commandRunner, activate, currentReport, remote = null }) {
    Object.assign(this, {
      config,
      settings,
      commandRunner,
      onActivate: activate,
      currentReport,
      remote,
    });
    this.root = path.join(
      path.dirname(settings.filePath),
      "environment-catalog",
    );
    this.entries = new Map();
    this.workers = new Map();
    this.pendingWorkers = new Map();
    this.discoveries = new Map();
    this.sources = new Map(
      sourceIds.map((id) => [
        id,
        { id, status: "unloaded", count: null, detail: null },
      ]),
    );
    this.signature = this.fingerprint();
    this.closed = false;
    this.persistence = Promise.resolve();
    this.registered = [];
    this.tasks = new Set();
  }
  fingerprint() {
    return digest(this.remote ? [this.remote.id, this.config.project.root, this.config.toolCommands] : [this.config.project.root, this.config.toolCommands]);
  }
  track(task) {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
  async initialize() {
    try {
      const raw = await readFile(path.join(this.root, "catalog.json"), "utf8");
      if (raw.length > 524288) return;
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved.entries)) return;
      const registered = new Set(saved.registered ?? []);
      for (const entry of saved.entries.slice(0, 250))
        if (
          /^[a-f0-9]{24}$/.test(entry.id) &&
          sourceIds.includes(entry.source) &&
          (saved.signature === this.signature || registered.has(entry.id))
        )
          this.entries.set(entry.id, entry);
      this.registered = Array.isArray(saved.registered)
        ? saved.registered.filter((id) => this.entries.has(id))
        : [];
      if (saved.signature === this.signature)
        for (const id of saved.readySources ?? [])
          if (sourceIds.includes(id))
            this.sources.set(id, {
              id,
              status: "ready",
              count: this.list(id).length,
              detail: null,
            });
    } catch {
      /* Discovery and inspection are lazy when no cache is available. */
    }
  }
  synchronize() {
    if (this.signature === this.fingerprint()) return;
    this.signature = this.fingerprint();
    const registeredEntries = this.registered
      .map((id) => this.entries.get(id))
      .filter(Boolean);
    for (const slot of this.workers.values()) {
      slot.closed = true;
      this.track(slot.worker.close());
    }
    this.workers.clear();
    this.pendingWorkers.clear();
    this.entries.clear();
    for (const entry of registeredEntries) this.entries.set(entry.id, entry);
    this.discoveries.clear();
    this.sources = new Map(
      sourceIds.map((id) => [
        id,
        { id, status: "unloaded", count: null, detail: null },
      ]),
    );
    void this.persist().catch(() => {});
  }
  async persist() {
    const snapshot = {
      signature: this.signature,
      entries: [...this.entries.values()],
      registered: this.registered,
      readySources: [...this.sources.values()]
        .filter((s) => s.status === "ready")
        .map((s) => s.id),
    };
    this.persistence = this.persistence
      .catch(() => {})
      .then(async () => {
        if (this.closed || snapshot.signature !== this.signature) return;
        await mkdir(this.root, { recursive: true });
        const temporary = path.join(this.root, `catalog.${randomUUID()}.tmp`);
        await writeFile(temporary, JSON.stringify(snapshot));
        await rename(temporary, path.join(this.root, "catalog.json"));
      });
    await this.persistence;
  }
  isCurrent(entry) {
    if (this.remote) return this.remote.isCurrent(entry);
    if (this.settings.settings?.researchLocation === "ssh") return false;
    const selected = this.config.researchEnvironment;
    if (selected.kind === "conda")
      return (
        entry.source === "conda" &&
        keyPath(selected.prefix) === keyPath(entry.prefix)
      );
    if (selected.kind !== "custom") return false;
    if (keyPath(selected.pythonCommand) === keyPath(entry.pythonCommand))
      return true;
    const python = this.currentReport()?.components.find(
      (c) => c.id === "python",
    )?.python;
    return Boolean(
      entry.source !== "python" &&
      python?.prefix &&
      keyPath(python.prefix) === keyPath(entry.prefix),
    );
  }
  descriptor(entry) {
    const report =
      this.workers.get(entry.id)?.worker.view() ??
      (this.isCurrent(entry) ? this.currentReport() : null);
    const python = report?.components.find((c) => c.id === "python");
    return {
      ...entry,
      cacheKey: digest([this.signature, entry.id]),
      current: this.isCurrent(entry),
      version: python?.version ?? entry.version ?? null,
      inspectionStatus: report?.status ?? "idle",
      checkedAt: report?.checkedAt ?? null,
    };
  }
  list(source) {
    return [...this.entries.values()]
      .filter((e) => e.source === source)
      .sort(
        (a, b) =>
          Number(this.isCurrent(b)) - Number(this.isCurrent(a)) ||
          a.name.localeCompare(b.name),
      );
  }
  view() {
    this.synchronize();
    const selected = [...this.entries.values()].find((e) => this.isCurrent(e));
    return {
      schemaVersion: "environment-catalog.v1",
      fingerprint: this.signature,
      current: selected
        ? this.descriptor(selected)
        : {
            id: null,
            name:
              this.config.researchEnvironment.kind === "conda"
                ? path.basename(this.config.researchEnvironment.prefix)
                : this.config.researchEnvironment.kind,
            selection: this.config.researchEnvironment,
          },
      sources: [...this.sources.values()].map((source) => ({
        ...source,
        environments: this.list(source.id).map((e) => this.descriptor(e)),
      })),
    };
  }
  runner(slot = null) {
    return (...args) =>
      withEnvironmentCapacity(async () => {
        if (this.closed || slot?.closed)
          throw new Error("Environment inspection closed");
        return this.commandRunner(...args);
      });
  }
  async add({
    source,
    prefix,
    pythonCommand,
    name,
    manager,
    registered = false,
    commit = true,
    identityPath = null,
  }) {
    const directory = this.remote ? path.posix.normalize(prefix) : await canonical(prefix);
    const identity =
      source === "python" ? this.remote ? path.posix.normalize(identityPath ?? pythonCommand) : await canonical(pythonCommand) : directory;
    const id = digest(this.remote ? [this.remote.id, source, identity] : [source, keyPath(identity)]);
    const entry = {
      id,
      source,
      name,
      prefix: directory,
      pythonCommand,
      manager: manager ?? source,
      hasPython: this.remote ? true : await exists(pythonCommand),
      selection:
        source === "conda"
          ? { kind: "conda", prefix: directory }
          : { kind: "custom", pythonCommand },
    };
    if (commit) this.entries.set(id, entry);
    if (registered && !this.registered.includes(id)) this.registered.push(id);
    return entry;
  }
  async discover(source, refresh = false) {
    this.synchronize();
    if (this.remote?.available && !this.remote.available()) return this.view();
    if (!sourceIds.includes(source))
      throw new AppError("ENVIRONMENT_SOURCE_INVALID", "未知的环境来源。", {
        status: 422,
      });
    if (this.discoveries.has(source)) return this.discoveries.get(source);
    if (!refresh && this.sources.get(source).status === "ready")
      return this.view();
    const signature = this.signature;
    this.sources.set(source, {
      id: source,
      status: "loading",
      count: null,
      detail: null,
    });
    const job = (async () => {
      const previous = this.list(source);
      const discovered = [];
      try {
        const config = structuredClone(this.config);
        config.researchEnvironment = {
          kind: "default",
          prefix: "",
          pythonCommand: "python",
        };
        const probes = new ResearchEnvironmentProbes(config, this.runner());
        if (this.remote) {
          const result = await this.remote.discover(source);
          for (const value of result.entries) {
            const entry = await this.add({ ...value, source, commit: false });
            entry.hasPython = value.hasPython; discovered.push(entry);
          }
        } else if (source === "conda") {
          const inventory = await probes.condaEnvironments();
          for (const env of inventory.environments)
            discovered.push(
              await this.add({
                source,
                prefix: env.prefix,
                pythonCommand: pythonAt(env.prefix),
                name: env.name,
                commit: false,
              }),
            );
        } else if (source === "venv") {
          for (const name of [".venv", "venv", "env"]) {
            const prefix = path.join(config.project.root, name);
            let cfg;
            try {
              cfg = await readFile(path.join(prefix, "pyvenv.cfg"), "utf8");
            } catch {
              continue;
            }
            discovered.push(
              await this.add({
                source,
                prefix,
                pythonCommand: pythonAt(prefix, "venv"),
                name,
                manager: /^uv\s*=|^command\s*=.*\buv\b/im.test(cfg)
                  ? "uv"
                  : "venv",
                commit: false,
              }),
            );
          }
        } else {
          const candidates = new Set(["python", "python3"]);
          if (process.platform === "win32") {
            const launcher = await this.runner()("py", ["--list-paths"], {
              timeoutMs: 3000,
              maxOutputBytes: 32768,
            });
            if (launcher.ok)
              for (const line of launcher.stdout.split(/\r?\n/)) {
                const found = line.match(
                  /([A-Za-z]:\\.*python(?:\d+(?:\.\d+)?)?\.exe)\s*$/i,
                );
                if (found) candidates.add(found[1]);
              }
          }
          for (const command of [...candidates].slice(0, 8)) {
            const candidateConfig = structuredClone(config);
            candidateConfig.researchEnvironment = {
              kind: "custom",
              pythonCommand: command,
              prefix: "",
            };
            let python;
            try {
              python = await new ResearchEnvironmentProbes(
                candidateConfig,
                this.runner(),
              ).identity();
            } catch {
              continue;
            }
            const kind =
              python.kind === "venv"
                ? "venv"
                : python.kind === "conda"
                  ? "conda"
                  : "python";
            // Conda/venv interpreters are listed under their owning provider.
            if (kind !== "python") continue;
            discovered.push(
              await this.add({
                source,
                prefix: python.prefix,
                pythonCommand: python.executable,
                name: `Python ${python.version}`,
                commit: false,
              }),
            );
          }
        }
        if (signature !== this.signature || this.closed) return this.view();
        for (const entry of discovered) this.entries.set(entry.id, entry);
        const keep = new Set([
          ...discovered.map((e) => e.id),
          ...this.registered,
        ]);
        for (const old of previous)
          if (!keep.has(old.id)) this.entries.delete(old.id);
        this.sources.set(source, {
          id: source,
          status: "ready",
          count: this.list(source).length,
          detail: null,
        });
        await this.persist();
      } catch {
        if (signature === this.signature)
          this.sources.set(source, {
            id: source,
            status: "error",
            count: previous.length,
            detail:
              source === "conda"
                ? "无法发现 Conda 环境，请检查管理器路径。"
                : "环境发现失败，可重新检查或手动添加解释器。",
          });
      }
      return this.view();
    })();
    this.discoveries.set(source, job);
    this.track(job);
    try {
      return await job;
    } finally {
      if (this.discoveries.get(source) === job) this.discoveries.delete(source);
    }
  }
  require(id) {
    this.synchronize();
    const entry = this.entries.get(id);
    if (!entry)
      throw new AppError(
        "ENVIRONMENT_NOT_FOUND",
        "环境不存在，请刷新来源列表。",
        { status: 404 },
      );
    return entry;
  }
  async register(pythonCommand) {
    if (
      typeof pythonCommand !== "string" ||
      !pythonCommand.trim() ||
      pythonCommand.length > 500
    )
      throw new AppError(
        "ENVIRONMENT_INTERPRETER_INVALID",
        "请输入 Python 可执行文件路径。",
        { status: 422 },
      );
    const config = structuredClone(this.config);
    config.researchEnvironment = {
      kind: "custom",
      prefix: "",
      pythonCommand: pythonCommand.trim(),
    };
    let python;
    try {
      python = await new ResearchEnvironmentProbes(
        config,
        this.runner(),
      ).identity();
    } catch {
      throw new AppError(
        "ENVIRONMENT_INTERPRETER_INVALID",
        "此解释器无法运行 Python 检测，项目当前环境未改变。",
        { status: 422 },
      );
    }
    const source =
      python.kind === "conda"
        ? "conda"
        : python.kind === "venv"
          ? "venv"
          : "python";
    let manager = this.remote && python.manager === "uv" ? "uv" : source;
    if (source === "venv" && !this.remote) {
      try {
        const cfg = await readFile(
          path.join(python.prefix, "pyvenv.cfg"),
          "utf8",
        );
        if (/^uv\s*=|^command\s*=.*\buv\b/im.test(cfg)) manager = "uv";
      } catch {
        /* The interpreter identity remains authoritative. */
      }
    }
    const entry = await this.add({
      source,
      prefix: python.prefix,
      pythonCommand: python.executable,
      name:
        source === "python"
          ? `Python ${python.version}`
          : path.basename(python.prefix),
      manager,
      identityPath: this.remote ? python.realExecutable : null,
      registered: true,
    });
    await this.persist();
    return { catalog: this.view(), environment: this.descriptor(entry) };
  }
  async worker(id) {
    const entry = this.require(id);
    if (this.workers.has(id)) return this.workers.get(id);
    if (this.pendingWorkers.has(id)) return this.pendingWorkers.get(id);
    const signature = this.signature;
    const loading = (async () => {
      if (this.workers.size >= 40) {
        const candidate = [...this.workers].find(
          ([, slot]) =>
            slot.worker.view().status !== "running" &&
            slot.packages.status !== "running",
        );
        if (!candidate)
          throw new AppError(
            "ENVIRONMENT_BUSY",
            "检测任务较多，请稍后展开其它环境。",
            { status: 429 },
          );
        candidate[1].closed = true;
        await candidate[1].worker.close();
        this.workers.delete(candidate[0]);
      }
      const config = structuredClone(this.config);
      config.researchEnvironment = {
        kind: "default",
        prefix: "",
        pythonCommand: "python",
        ...entry.selection,
      };
      const slot = {
        closed: false,
        worker: null,
        packages: emptyPackages(),
        packageTask: null,
        config,
      };
      slot.worker = new ResearchEnvironmentService({
        config,
        includeHost: false,
        settings: {
          filePath: path.join(this.root, id, "settings.json"),
          update: async () => {
            throw new Error("Inspection cannot change project settings");
          },
        },
        applySettings: async () => {
          throw new Error("Inspection cannot activate an environment");
        },
        commandRunner: this.runner(slot),
      });
      await slot.worker.initialize();
      if (slot.worker.view().status === "idle" && this.isCurrent(entry))
        await slot.worker.adopt(this.currentReport());
      try {
        const raw = await readFile(
          path.join(this.root, id, "packages.json"),
          "utf8",
        );
        if (raw.length < 4194304) {
          const saved = JSON.parse(raw);
          if (
            saved.fingerprint === slot.worker.fingerprint() &&
            saved.status === "completed" &&
            Array.isArray(saved.items) &&
            saved.items.length <= 10000 &&
            saved.items.every(
              (item) =>
                typeof item.name === "string" &&
                typeof item.version === "string" &&
                ["conda", "pip", "python"].includes(item.source),
            )
          )
            slot.packages = saved;
        }
      } catch {
        /* Package inventory is fetched on demand. */
      }
      if (this.closed || signature !== this.signature) {
        slot.closed = true;
        await slot.worker.close();
        throw new AppError("ENVIRONMENT_CHANGED", "环境配置已更新，请重试。", {
          status: 409,
        });
      }
      this.workers.set(id, slot);
      return slot;
    })();
    this.pendingWorkers.set(id, loading);
    this.track(loading);
    try {
      return await loading;
    } finally {
      if (this.pendingWorkers.get(id) === loading)
        this.pendingWorkers.delete(id);
    }
  }
  async report(id) {
    const slot = await this.worker(id);
    return {
      environment: this.descriptor(this.require(id)),
      inspection: slot.worker.view(),
    };
  }
  async check(id, { componentId = null, refresh = false } = {}) {
    const entry = this.require(id),
      slot = await this.worker(id);
    if (!entry.hasPython)
      throw new AppError(
        "ENVIRONMENT_PYTHON_MISSING",
        "此环境未安装 Python，仍可查看 Conda 包清单。",
        { status: 422 },
      );
    const view = slot.worker.view();
    if (refresh || componentId || view.status === "idle" || view.stale)
      slot.worker.start(componentId);
    return this.report(id);
  }
  async activate(id) {
    const entry = this.require(id),
      slot = await this.worker(id);
    await this.onActivate(entry.selection, { report: slot.worker.view() });
    return this.view();
  }
  async packagePage(id, { query = "", offset = 0, limit = 50 } = {}) {
    if (
      typeof query !== "string" ||
      query.length > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new AppError(
        "PACKAGE_QUERY_INVALID",
        "包清单查询或分页参数无效。",
        { status: 422 },
      );
    const entry = this.require(id),
      slot = await this.worker(id),
      state = slot.packages;
    const items = state.items.filter((item) =>
      item.name.toLowerCase().includes(query.toLowerCase()),
    );
    return {
      schemaVersion: "environment-packages.v1",
      environment: this.descriptor(entry),
      status: state.status,
      kind: entry.source === "conda" ? "conda-and-pip" : "python-distributions",
      checkedAt: state.checkedAt,
      detail: state.detail,
      total: state.items.length,
      matched: items.length,
      items: items.slice(offset, offset + limit),
      offset,
      limit,
      nextOffset: offset + limit < items.length ? offset + limit : null,
    };
  }
  async refreshPackages(id) {
    const entry = this.require(id),
      slot = await this.worker(id);
    if (slot.packages.status === "running") return this.packagePage(id);
    slot.packages = {
      status: "running",
      checkedAt: null,
      items: [],
      detail: null,
    };
    slot.packageTask = (async () => {
      try {
        const probes = new ResearchEnvironmentProbes(
          slot.config,
          this.runner(slot),
        );
        let items;
        if (entry.source === "conda") {
          const result = await this.runner(slot)(
            await probes.executable("conda"),
            ["list", "--prefix", entry.prefix, "--json"],
            {
              cwd: this.config.project.root,
              timeoutMs: 20000,
              maxOutputBytes: 4194304,
              killTree: true,
            },
          );
          if (!result.ok) throw new Error("Conda package inventory failed");
          const records = JSON.parse(result.stdout);
          if (!Array.isArray(records))
            throw new Error("Invalid package inventory");
          items = records.map((record) => ({
            name: record.name,
            version: record.version,
            source:
              record.channel === "pypi" || record.build_string === "pypi_0"
                ? "pip"
                : "conda",
          }));
        } else {
          const result = await probes.python("package_inventory", 20000);
          if (result.status !== "ready" || !Array.isArray(result.items))
            throw new Error("Python package inventory failed");
          items = result.items.map((item) => ({
            name: item.name,
            version: item.version,
            source: "python",
          }));
        }
        if (
          items.length > 10000 ||
          items.some(
            (item) =>
              typeof item.name !== "string" ||
              typeof item.version !== "string" ||
              !item.name ||
              !item.version ||
              item.name.length > 2000 ||
              item.version.length > 2000,
          )
        )
          throw new Error("Invalid package inventory");
        items.sort((a, b) => a.name.localeCompare(b.name));
        if (slot.closed || this.closed) return;
        slot.packages = {
          status: "completed",
          checkedAt: new Date().toISOString(),
          items,
          detail: null,
          fingerprint: slot.worker.fingerprint(),
        };
        const destination = path.join(this.root, id, "packages.json"),
          temporary = `${destination}.${randomUUID()}.tmp`;
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(temporary, JSON.stringify(slot.packages));
        await rename(temporary, destination);
      } catch {
        if (!slot.closed && !this.closed)
          slot.packages = {
            status: "error",
            checkedAt: null,
            items: [],
            detail:
              "无法读取此环境的完整包清单，可检查解释器或 Conda 路径后重试。",
          };
      }
    })();
    this.track(slot.packageTask);
    return this.packagePage(id);
  }
  async close() {
    this.closed = true;
    for (const slot of this.workers.values()) slot.closed = true;
    await Promise.allSettled([
      ...this.tasks,
      ...[...this.workers.values()].flatMap((slot) => [
        slot.worker.close(),
        slot.packageTask,
      ]),
      this.persistence,
    ]);
  }
}
