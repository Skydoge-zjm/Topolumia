import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentProfile, NativeConfig } from "../../../../domain/agents/agent-types.js";
import { resolveExecutable, resolveInvocation } from "../../../../lib/command.js";
import { AppError } from "../../../../lib/errors.js";
import { withoutResearchCredentials } from "../../../../agent/research-mcp-binding.js";
import { mergeNativeConfig } from "../../shared/native-config.js";

export function openCodeV2Error(error: unknown, code = "OPENCODE_V2_REQUEST_FAILED"): AppError {
  if (error instanceof AppError) return error;
  const detail = error as { _tag?: string; message?: string; status?: number; cause?: { status?: number } };
  const status = /NotFound/.test(detail?._tag ?? "") ? 404 : detail?.status ?? detail?.cause?.status ?? 502;
  return new AppError(status === 404 ? "AGENT_SESSION_SOURCE_NOT_FOUND" : code,
    `OpenCode 2：${(detail?.message || "请求失败，请检查运行时、Provider 和网络配置。").slice(0, 500)}`, { status });
}

async function availablePort(): Promise<number> {
  const socket = createServer();
  try {
    await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
    return (socket.address() as { port: number }).port;
  } finally { await new Promise<void>(resolve => socket.close(() => resolve())); }
}

export class OpenCodeV2Server {
  private process?: ChildProcess;
  private stopping = false;
  private exitHandler?: () => void;
  client!: OpenCodeClient;
  url = "";
  version = "";

  async start(profile: AgentProfile, cwd: string, config: NativeConfig = {}, onExit: () => void = () => {}, environment: Record<string, string> = {}): Promise<OpenCodeClient> {
    if (this.stopping) throw new AppError("OPENCODE_V2_CLOSED", "OpenCode 2 服务已关闭。", { status: 409 });
    const port = await availablePort();
    const args = [...(profile.args ?? ["serve"]), "--hostname=127.0.0.1", `--port=${port}`];
    const executable = await resolveExecutable(profile.command);
    let invocation = await resolveInvocation(profile.command, args, { allowCmdShim: true });
    if (process.platform === "win32" && /opencode(?:2)?\.(cmd|ps1)$/i.test(executable)) {
      const bin = path.join(path.dirname(executable), "node_modules", "@opencode", "cli", "bin");
      const native = path.join(bin, "opencode.exe");
      try { await access(native); invocation = { executable: native, args }; }
      catch {
        const script = path.join(bin, "opencode.cjs");
        try { await access(script); invocation = { executable: process.execPath, args: [script, ...args] }; } catch { /* Other installers use the resolved command. */ }
      }
    }
    const password = randomBytes(32).toString("hex");
    const runtimeRoot = profile.nativeConfigRoot ?? path.join(os.tmpdir(), "topolumia-opencode-v2", createHash("sha256").update(path.resolve(cwd)).digest("hex"));
    const database = path.join(runtimeRoot, "opencode-v2", "opencode.db");
    await mkdir(path.dirname(database), { recursive: true });
    if (this.stopping) throw new AppError("OPENCODE_V2_CLOSED", "OpenCode 2 服务已关闭。", { status: 409 });
    this.url = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
    const child = spawn(invocation.executable, invocation.args, { cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
      env: { ...withoutResearchCredentials(), ...profile.env, ...environment,
        OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password, OPENCODE_DB: database,
        ...(profile.nativeConfigFile ? { OPENCODE_CONFIG: profile.nativeConfigFile } : {}),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(mergeNativeConfig(profile.nativeConfig, config)) } });
    this.process = child;
    let exited = false;
    child.on("error", () => { exited = true; });
    child.once("exit", () => { exited = true; if (!this.stopping) onExit(); });
    child.stdout?.resume(); child.stderr?.resume();
    this.exitHandler = () => { child.kill(); };
    process.once("exit", this.exitHandler);
    this.client = OpenCode.make({ baseUrl: this.url, headers, fetch: (input, init) => {
      const request = new Request(input, init);
      const stream = new URL(request.url).pathname === "/api/event" || /\/log$/.test(new URL(request.url).pathname);
      return fetch(request, stream ? {} : { signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]) });
    } });
    try {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !exited) {
        try {
          const info = await this.client.server.info({ signal: AbortSignal.timeout(800) });
          const version = /^2\.(\d+)\.(\d+)$/.exec(info.version);
          if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && Number(version[2]) < 7) throw new AppError("OPENCODE_VERSION_INCOMPATIBLE", "该入口要求 OpenCode 2.2.7 至 2.x。", { status: 503 });
          this.version = info.version;
          return this.client;
        } catch (error) { if (error instanceof AppError) throw error; }
        await delay(100);
      }
      throw new Error("server did not become ready");
    } catch (error) {
      await this.close();
      if (error instanceof AppError) throw error;
      throw new AppError("OPENCODE_V2_SERVER_START_FAILED", "OpenCode 2 服务启动失败，请检查版本、安装和原生配置。", { status: 503 });
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    if (this.exitHandler) process.removeListener("exit", this.exitHandler);
    const child = this.process; this.process = undefined;
    if (!child || child.exitCode !== null || !child.pid) return;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => child.kill());
    } else child.kill("SIGTERM");
    await Promise.race([exited, delay(2_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
