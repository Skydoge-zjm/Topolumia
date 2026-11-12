import { spawn } from "node:child_process";
import { readFile, stat, access } from "node:fs/promises";
import path from "node:path";
import { bundledRoot } from "../../config.js";
import { AppError } from "../../lib/errors.js";
import { collectorPackage } from "../research/experiments/collector-package.js";
import * as z from "zod/v4";
import type { ProjectRuntime } from "../../application/project-runtime.js";
import type { CollaborationStore } from "../platform/collaboration-store.js";
import type { SshConnectionService } from "../../ssh/ssh-connection-service.js";
import type { SshEnvironmentHub } from "../../ssh/ssh-environment-hub.js";
import type { ProjectRecordSource, RecordProvider } from "../../domain/research/record-types.js";
import type { ResearchActor, AuthenticatedResearchActor } from "../../domain/research/types.js";
import type { ResearchCommandService } from "../research/research-command-service.js";
import type { CommandResult } from "../../lib/command.js";
const collectorStateSchema = z.looseObject({status:z.string(),phase:z.string().optional(),error:z.string().optional(),checkedAt:z.union([z.string(),z.number()]).optional()});
type CollectorState = z.infer<typeof collectorStateSchema>;
type CollectorOptions = { collaboration:CollaborationStore;sshEnvironments:SshEnvironmentHub;sshConnections:SshConnectionService;address:()=>{host:string;port:number}|null;runtimes:Map<string,ProjectRuntime>;dataDirectory?:string };
const errorCode = (value:unknown) => value && typeof value === "object" && "code" in value ? value.code : undefined;
const errorText = (value:unknown) => value instanceof Error ? value.message : String(value);

/** Owns reader processes, not training. Persistent source identities survive relays. */
export class ManagedRecordCollectors {
  states = new Map<string, CollectorState>();
  tasks = new Map<string, Promise<void>>();
  forwards = new Map<string, Awaited<ReturnType<SshConnectionService["reverseForward"]>>>();
  installs = new Map<string, Promise<CollectorState>>();
  closed = false;
  timer;
  constructor(public options: CollectorOptions) {
    this.timer = setInterval(() => void this.reconcile(), 8000);
    this.timer.unref?.();
  }
  key(runtime: ProjectRuntime, source: ProjectRecordSource) { return runtime.config.project.id + ":" + source.id; }
  actor(runtime: ProjectRuntime, source: ProjectRecordSource) { return this.options.collaboration.actorForUser(source.userId, runtime.config.project.id); }
  async context(runtime: ProjectRuntime, actor: AuthenticatedResearchActor, hostId: string) {
    if (runtime.config.project.workspace?.kind === "unassigned") throw new AppError("PROJECT_DIRECTORY_REQUIRED", "请先关联项目工作目录，再启用实验记录采集。", { status: 422 });
    if (hostId === "local") return { directory: runtime.config.project.root, hostLabel: "本机", python: runtime.config.experimentRecords.pythonCommand || "python" };
    const info = await this.options.sshEnvironments.info(actor.user.id, hostId);
    await this.options.sshConnections.connected(actor.user.id, hostId);
    const settings = await this.options.sshEnvironments.projectSettings(runtime, actor.user.id, hostId);
    if (!settings.directory) throw new AppError("PROJECT_DIRECTORY_REQUIRED", "请先保存该主机上的项目目录。", { status: 422 });
    const profile = await this.options.sshConnections.profile(actor.user.id, hostId);
    return { directory: settings.directory, hostLabel: profile.name, python: settings.pythonCommand || info.python };
  }
  view(runtime: ProjectRuntime, actor: ResearchActor, hostId = "local") {
    runtime.researchCommands.check(actor, "research.view");
    const c: ResearchCommandService = runtime.researchCommands;
    return { hostId, adapters: ["wandb", "tensorboard"].map(provider => {
      const sources = c.projectRecords.all().filter(source => source.userId === actor.user.id && source.hostId === hostId && source.provider === provider);
      return { provider, sources: sources.map(source => ({ id: source.id, directory: source.directory, enabled: source.enabled, ...this.publicState(runtime, source), runCount: c.ingestion.sql("SELECT count(*) AS count FROM record_live_runs WHERE project=? AND block=?").get(c.projectId, source.id)?.count ?? 0, updatedAt: c.ingestion.version(source.id, actor).updatedAt })) };
    }) };
  }
  publicState(runtime: ProjectRuntime, source: ProjectRecordSource) {
    const state = this.states.get(this.key(runtime, source));
    if (!source.enabled) return { status: "paused", ...(state?.error ? { error: state.error } : {}) };
    if (source.hostId !== "local") {
      const session = this.options.sshConnections.sessions.get(this.options.sshConnections.sessionKey(source.userId, source.hostId));
      if (session?.status !== "connected") return { status: "waiting", error: "SSH 主机尚未连接" };
    }
    return state ?? { status: "waiting" };
  }
  async enable(runtime: ProjectRuntime, actor: ResearchActor, hostId: string, provider: RecordProvider, directories: unknown = undefined) {
    runtime.researchCommands.check(actor, "project.manageSettings");
    const context = await this.context(runtime, actor, hostId);
    if (directories !== undefined && (!Array.isArray(directories) || !directories.length || directories.length > 8 || new Set(directories).size !== directories.length)) throw new AppError("COLLECTION_CONFIG_INVALID", "请选择 1–8 个不同的采集目录。", { status: 422 });
    let targets = directories === undefined ? [context.directory] : z.array(z.string()).parse(directories);
    const c: ResearchCommandService = runtime.researchCommands;
    // Validate the entire configuration before persisting or launching anything.
    if (targets.some(directory => typeof directory !== "string" || directory.length > 4096 || [...directory].some(char => char.charCodeAt(0) < 32) || !(hostId === "local" ? path.isAbsolute(directory) : path.posix.isAbsolute(directory)))) throw new AppError("COLLECTION_CONFIG_INVALID", "记录目录需要是所选机器上的绝对路径。", { status: 422 });
    const normalize = (directory: string) => hostId === "local" ? path.resolve(directory) : path.posix.normalize(directory);
    const normalized = targets.map(normalize);
    for (let i = 0; i < normalized.length; i++) for (let j = i + 1; j < normalized.length; j++) {
      const relative = hostId === "local" ? path.relative(normalized[i], normalized[j]) : path.posix.relative(normalized[i], normalized[j]);
      const reverse = hostId === "local" ? path.relative(normalized[j], normalized[i]) : path.posix.relative(normalized[j], normalized[i]);
      if (!relative || !relative.startsWith("..") && !path.isAbsolute(relative) || !reverse.startsWith("..") && !path.isAbsolute(reverse)) throw new AppError("COLLECTION_CONFIG_INVALID", "采集目录不能重复或互相包含，请保留范围更大的目录。", { status: 422 });
    }
    targets = normalized;
    for (const directory of targets) {
      if (hostId === "local") {
        try { if (!(await stat(directory)).isDirectory()) throw new Error(); await access(directory); }
        catch { throw new AppError("COLLECTION_CONFIG_INVALID", "采集目录不存在或不可访问。", { status: 422 }); }
      } else if (directories) await this.options.sshEnvironments.remoteProbe(actor.user.id, hostId, "directory", { directory, pythonCommand: context.python });
    }
    if (directories) for (const source of c.projectRecords.all()) if (source.userId === actor.user.id && source.hostId === hostId && source.provider === provider && source.enabled && !targets.includes(source.directory)) await this.pause(runtime, actor, source.id);
    for (const directory of targets) {
      const source = c.projectRecords.configure({ hostId, hostLabel: context.hostLabel, provider, directory }, actor);
      this.launch(runtime, source, "deploy", context.python);
    }
    return this.view(runtime, actor, hostId);
  }
  async resume(runtime: ProjectRuntime, actor: ResearchActor, id: string) {
    const c: ResearchCommandService = runtime.researchCommands;
    c.check(actor, "project.manageSettings");
    const source = c.projectRecords.get(id);
    if (!source || source.userId !== actor.user.id) throw new AppError("COLLECTION_NOT_FOUND", "采集来源不存在。", { status: 404 });
    if (source.mode === "import") throw new AppError("RECORD_SOURCE_IMMUTABLE", "导入版本不可追加采集，请重新导入上游记录。", { status: 409 });
    const context = await this.context(runtime, actor, source.hostId);
    const value = c.projectRecords.save({ ...source, enabled: true });
    this.launch(runtime, value, "deploy", context.python);
    return this.view(runtime, actor, source.hostId);
  }
  async pause(runtime: ProjectRuntime, actor: ResearchActor, id: string) {
    const c: ResearchCommandService = runtime.researchCommands;
    c.check(actor, "project.manageSettings");
    const source = c.projectRecords.get(id);
    if (!source || source.userId !== actor.user.id) throw new AppError("COLLECTION_NOT_FOUND", "采集来源不存在。", { status: 404 });
    if (source.mode === "import") throw new AppError("RECORD_SOURCE_IMMUTABLE", "导入版本不使用持续采集。", { status: 409 });
    c.projectRecords.save({ ...source, enabled: false });
    const key = this.key(runtime, source);
    await this.tasks.get(key)?.catch(() => {});
    try { await this.control(runtime, source, "stop"); this.states.set(key, { status: "paused" }); }
    catch (error) { this.states.set(key, { status: "waiting", error: "已暂停接收，连接主机后完成读取器停止。" }); if (errorCode(error) !== "SSH_NOT_CONNECTED") throw error; }
    finally { this.forwards.get(key)?.close(); this.forwards.delete(key); }
    return this.view(runtime, actor, source.hostId);
  }
  launch(runtime: ProjectRuntime, source: ProjectRecordSource, action = "start", python: string|undefined = undefined) {
    const key = this.key(runtime, source);
    if (this.closed || this.tasks.has(key)) return;
    this.states.set(key, { status: "deploying", phase: action === "deploy" ? "preparing" : "starting" });
    const task = this.start(runtime, source, action, python).catch(error => { this.states.set(key, { status: errorCode(error) === "SSH_NOT_CONNECTED" ? "waiting" : "error", error: errorText(error).slice(0, 500), checkedAt: new Date().toISOString() }); }).finally(() => this.tasks.delete(key));
    this.tasks.set(key, task);
  }
  async start(runtime: ProjectRuntime, source: ProjectRecordSource, action: string, python: string | undefined) {
    const key = this.key(runtime, source), c: ResearchCommandService = runtime.researchCommands, actor = this.actor(runtime, source);
    c.check(actor, "project.manageSettings");
    if (!c.projectRecords.get(source.id)?.enabled || this.closed) return;
    const address = this.options.address();
    if (!address?.port) throw new AppError("COLLECTION_NOT_READY", "工作台服务尚未启动。", { status: 409 });
    let url = `http://${address.host.includes(":") ? "[" + address.host + "]" : address.host}:${address.port}`;
    if (source.hostId !== "local") {
      this.forwards.get(key)?.close();
      const forward = await this.options.sshConnections.reverseForward(source.userId, source.hostId, address.port, address.host);
      this.forwards.set(key, forward);
      url = "http://127.0.0.1:" + forward.port;
    }
    const grant = c.ingestion.grant(source.id, actor, 30 * 86400, { label: source.hostLabel + " · " + source.provider, provider: source.provider, sourcePath: source.directory });
    if (source.grantId) c.ingestion.changeGrant(source.id, source.grantId, "revoke", actor);
    const current = c.projectRecords.get(source.id);
    if (!current) throw new AppError("COLLECTION_NOT_FOUND", "采集来源不存在。", {status:404});
    c.projectRecords.save({ ...current, grantId: grant.id });
    const installKey = [source.userId, source.hostId, source.provider].join(":");
    const previous = this.installs.get(installKey);
    const operation = Promise.resolve(previous).catch(() => {}).then(() => this.control(runtime, source, action, { python, token: grant.token, url }));
    this.installs.set(installKey, operation);
    try {
      const result = await operation;
      if (this.closed || !c.projectRecords.get(source.id)?.enabled) { await this.control(runtime, source, "stop"); return; }
      this.states.set(key, { ...result, status: "starting", checkedAt: new Date().toISOString() });
    } finally { if (this.installs.get(installKey) === operation) this.installs.delete(installKey); }
  }
  async control(runtime: ProjectRuntime, source: ProjectRecordSource, action: string, extra: {python?:string;token?:string;url?:string} = {}): Promise<CollectorState> {
    const actor = this.actor(runtime, source);
    runtime.researchCommands.check(actor, "project.manageSettings");
    const context = await this.context(runtime, actor, source.hostId);
    const script = await readFile(path.join(bundledRoot, "scripts/runtime/manage-record-collector.py"), "utf8");
    const input = JSON.stringify({ action, id: source.id, provider: source.provider, projectId: runtime.config.project.id, directory: source.directory, ...(this.options.dataDirectory ? { dataDirectory: this.options.dataDirectory } : {}), ...extra, ...(action === "deploy" ? { package: await collectorPackage() } : {}) });
    const phase = (chunk: string) => { const match = chunk.match(/TOPOLUMIA_PHASE:(\w+)/); if (match) this.states.set(this.key(runtime, source), { status: "deploying", phase: match[1] }); };
    const python = extra.python || context.python;
    const result = source.hostId === "local" ? await this.local(python, script, input, phase) : await this.options.sshConnections.run(source.userId, source.hostId, python, ["-u", "-c", script], { input, timeoutMs: action === "deploy" ? 240000 : action === "stop" ? 45000 : 20000, maxOutputBytes: 65536, onStdout: phase });
    const last = result.stdout?.trim().split(/\r?\n/).findLast(line => line.startsWith("{"));
    let value;
    try { value = last ? collectorStateSchema.parse(JSON.parse(last)) : undefined; } catch { /* Malformed reader output is reported as a control failure below. */ }
    if (!result.ok || !value || value.status === "error" && action !== "status") throw new AppError("COLLECTION_CONTROL_FAILED", value?.error || (result.timedOut ? "适配器操作超时，请重试。" : "适配器操作失败，请检查 Python 或依赖安装条件。"), { status: 422 });
    return value;
  }
  local(python: string, script: string, input: string, phase: (chunk:string)=>void): Promise<CommandResult> {
    return new Promise<CommandResult>(resolve => {
      const child = spawn(python, ["-u", "-c", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => child.kill(), 240000); timer.unref?.();
      child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-65536); phase(chunk.toString()); });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
      child.once("error", () => { clearTimeout(timer); resolve({ ok: false, stdout, stderr }); });
      child.once("close", code => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr }); });
      child.stdin.on("error", () => {}); child.stdin.end(input);
    });
  }
  async reconcile() {
    if (this.closed || !this.options.address()?.port) return;
    for (const runtime of this.options.runtimes.values()) for (const source of runtime.researchCommands.projectRecords.all()) {
      const key = this.key(runtime, source);
      if (this.tasks.has(key)) continue;
      const state = this.states.get(key);
      if (!source.enabled && state?.status === "paused") continue;
      if (state?.status === "error") continue;
      const task = (async () => {
        try {
          if (!source.enabled) { await this.control(runtime, source, "stop"); this.states.set(key, { status: "paused" }); return; }
          if (!state || source.hostId !== "local" && !this.forwards.get(key)?.active) { this.tasks.delete(key); this.launch(runtime, source, "start"); return; }
          if (source.grantId) {
            const row = runtime.researchCommands.ingestion.sql("SELECT body FROM record_grants WHERE project=? AND id=?").get(runtime.config.project.id, source.grantId);
            const grant = row && z.object({revoked:z.boolean(),expiresAt:z.string()}).parse(JSON.parse(row.body));
            if (grant && !grant.revoked && Date.parse(grant.expiresAt) - Date.now() < 86400000) { const actor = this.actor(runtime, source); const c: ResearchCommandService = runtime.researchCommands; c.check(actor,"project.manageSettings"); c.ingestion.changeGrant(source.id, source.grantId, "renew", actor); }
          }
          const report = await this.control(runtime, source, "status");
          this.states.set(key, report);
          if (report.status === "stopped") { this.tasks.delete(key); this.launch(runtime, source, "start"); }
        } catch (error) { this.states.set(key, { status: "waiting", error: errorText(error), checkedAt: new Date().toISOString() }); this.forwards.get(key)?.close(); this.forwards.delete(key); }
      })().finally(() => { if (this.tasks.get(key) === task) this.tasks.delete(key); });
      this.tasks.set(key, task);
    }
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    await Promise.allSettled([...this.tasks.values()]);
    for (const forward of this.forwards.values()) forward.close();
    this.forwards.clear();
  }
}
