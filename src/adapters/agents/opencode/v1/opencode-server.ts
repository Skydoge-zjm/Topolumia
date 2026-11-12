import type { AgentProfile } from "../../../../domain/agents/agent-types.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createOpencodeClient, type Config, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { resolveInvocation, resolveExecutable } from "../../../../lib/command.js";
import { AppError } from "../../../../lib/errors.js";
import { withoutResearchCredentials } from "../../../../agent/research-mcp-binding.js";
import { mergeNativeConfig } from "../../shared/native-config.js";

export type OpenCodeProfile = AgentProfile;

export interface OpenCodeModelOption { id: string; label: string; reasoningEfforts: string[] }
export interface OpenCodeCatalog { models: OpenCodeModelOption[]; model: string | null; reasoningEfforts: string[] }

async function availablePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

// Prefer the npm package's native executable to a Windows cmd.exe wrapper:
// the process we own must also be the process we terminate.
async function serverInvocation(profile: OpenCodeProfile, port: number) {
  const args = [...(profile.args ?? ["serve"]), "--hostname=127.0.0.1", `--port=${port}`];
  const executable = await resolveExecutable(profile.command);
  if (process.platform === "win32" && /opencode\.(cmd|ps1)$/i.test(executable)) {
    const native = path.join(path.dirname(executable), "node_modules", "opencode-ai", "bin", "opencode.exe");
    try { await access(native); return { executable: native, args }; } catch { /* Non-npm install. */ }
  }
  return resolveInvocation(profile.command, args, { allowCmdShim: true });
}

export class OpenCodeServer {
  private process?: ChildProcess;
  private stopping = false;
  private exitHandler?: () => void;
  client!: OpencodeClient;
  url = "";

  async start(profile: OpenCodeProfile, cwd: string, config: Config = {}, onExit: () => void = () => {}, environment: Record<string, string> = {}): Promise<OpencodeClient> {
    const port = await availablePort();
    const invocation = await serverInvocation(profile, port);
    const password = randomBytes(24).toString("hex");
    this.url = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
    const child = spawn(invocation.executable, invocation.args, {
      cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
      env: { ...withoutResearchCredentials(), ...environment, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password,
        ...(profile.nativeConfigFile ? { OPENCODE_CONFIG: profile.nativeConfigFile } : {}),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(mergeNativeConfig(profile.nativeConfig, config)) },
    });
    this.process = child;
    let exited = false;
    child.on("error", () => { exited = true; });
    child.once("exit", () => { exited = true; if (!this.stopping) onExit(); });
    // Drain diagnostics without forwarding local credentials/configuration to clients.
    child.stdout?.resume();
    child.stderr?.resume();
    this.exitHandler = () => { child.kill(); };
    process.once("exit", this.exitHandler);
    try {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (exited) throw new Error("exited");
        try {
          const response = await fetch(`${this.url}/global/health`, { headers, signal: AbortSignal.timeout(700) });
          const health: unknown = response.ok ? await response.json() : null;
          if (health && typeof health === "object" && "healthy" in health && health.healthy) break;
        } catch { /* Server is still booting. */ }
        await delay(100);
      }
      if (Date.now() >= deadline) throw new Error("timeout");
      this.client = createOpencodeClient({ baseUrl: this.url, directory: cwd, headers, throwOnError: true,
        fetch: (input, init) => {
          const request = new Request(input, init);
          // SSE owns its abort signal; ordinary requests have a bounded deadline.
          const isStream = new URL(request.url).pathname === "/event";
          return fetch(request, isStream ? {} : { signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]) });
        },
      });
      return this.client;
    } catch {
      await this.close();
      throw new AppError("OPENCODE_SERVER_START_FAILED", "OpenCode 原生服务启动失败，请检查本机 OpenCode 配置。", { status: 503 });
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    if (this.exitHandler) process.removeListener("exit", this.exitHandler);
    const child = this.process;
    this.process = undefined;
    if (!child || child.exitCode !== null || !child.pid) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => child.kill());
    } else child.kill("SIGTERM");
    await Promise.race([exited, delay(2_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

export function resolveOpenCodeModelId(models: OpenCodeModelOption[], requested: string): string {
  const exact = models.find(model => model.id === requested);
  if (exact) return exact.id;
  const matches = models.filter(model => model.id.slice(model.id.indexOf("/") + 1) === requested);
  if (matches.length === 1) return matches[0].id;
  throw new AppError(matches.length > 1 ? "OPENCODE_MODEL_AMBIGUOUS" : "OPENCODE_MODEL_UNAVAILABLE",
    matches.length > 1 ? "多个 OpenCode Provider 配置了同名模型，请选择完整的 provider/model。" : "所选模型不在 OpenCode 已配置的模型列表中。", { status: 422 });
}

export async function readOpenCodeCatalog(client: OpencodeClient, preferred?: string): Promise<OpenCodeCatalog> {
  const [{ data }, { data: config }] = await Promise.all([client.config.providers(), client.config.get()]);
  if (!data || !config) throw new AppError("OPENCODE_CONFIG_UNAVAILABLE", "OpenCode 未返回有效的 Provider 或模型配置。", { status: 502 });
  const models: OpenCodeModelOption[] = data.providers.flatMap((provider) => Object.values(provider.models)
    .filter((model) => model.status !== "deprecated" && model.capabilities?.input?.text !== false)
    .map((model) => ({ id: `${provider.id}/${model.id}`, label: `${model.name} · ${provider.name}`,
      reasoningEfforts: Object.keys(model.variants ?? {}).filter((name) => model.variants?.[name]?.disabled !== true) })));
  const configured = preferred ? resolveOpenCodeModelId(models, preferred) : config.model;
  const fallback = data.providers.map((p) => `${p.id}/${data.default[p.id]}`).find((id) => models.some((m) => m.id === id));
  return { models, model: models.find((m) => m.id === configured)?.id ?? fallback ?? models[0]?.id ?? null, reasoningEfforts: [] };
}

export async function discoverOpenCodeModels(profile: OpenCodeProfile, cwd: string): Promise<OpenCodeCatalog> {
  const server = new OpenCodeServer();
  try { return await readOpenCodeCatalog(await server.start(profile, cwd), profile.model ?? undefined); }
  finally { await server.close(); }
}
