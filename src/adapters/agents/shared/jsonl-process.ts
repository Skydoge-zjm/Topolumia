import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { resolveInvocation } from "../../../lib/command.js";
import { withoutResearchCredentials } from "../../../agent/research-mcp-binding.js";
import { errorFromMessage } from "./agent-driver.js";

export interface ProcessCloseDetail { code?: number | null; signal?: NodeJS.Signals | null; error?: unknown; expected?: boolean; stderr?: string }
export interface JsonlOptions<T> { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; label?: string; onMessage?: (message: T) => void; onClose?: (detail: ProcessCloseDetail) => void; requestTimeoutMs?: number }
interface PendingRequest { method: string; resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }
export class JsonlProcess<TMessage = Record<string, unknown>> {
  command: string; args: string[]; cwd?: string; env?: Record<string, string>; label: string;
  onMessage: (message: TMessage) => void; onClose: (detail: ProcessCloseDetail) => void;
  requestTimeoutMs: number; pending = new Map<number, PendingRequest>(); requestId = 0; stderr = "";
  closed = false; expectedClose = false; exited = false; inputBlocked = false; inputEnded = false;
  writeQueue: { text: string; end: boolean }[] = [];
  child!: ChildProcessWithoutNullStreams; reader?: readline.Interface;
  invocation?: Awaited<ReturnType<typeof resolveInvocation>>; stopPromise?: Promise<void>;
  constructor({ command, args = [], cwd, env, label, onMessage, onClose, requestTimeoutMs = 300_000 }: JsonlOptions<TMessage>) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.label = label ?? command;
    this.onMessage = onMessage ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.requestTimeoutMs = requestTimeoutMs;
    this.pending = new Map<number, PendingRequest>();
    this.requestId = 0;
    this.stderr = "";
    this.closed = false;
    this.expectedClose = false;
    this.exited = false;
    this.writeQueue = [];
    this.inputBlocked = false;
    this.inputEnded = false;
  }

  async start() {
    const invocation = await resolveInvocation(this.command, this.args, { allowCmdShim: true });
    this.invocation = invocation;
    try {
      this.child = spawn(invocation.executable, invocation.args, {
        cwd: this.cwd,
        env: { ...withoutResearchCredentials(), ...(this.env ?? {}) },
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw errorFromMessage("AGENT_PROCESS_START_FAILED", `无法启动 ${this.label}。`, {
        command: this.command,
        reason: error instanceof Error ? error.message : String(error),
      }, 503);
    }
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        this.child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        this.child.off("spawn", onSpawn);
        reject(errorFromMessage("AGENT_PROCESS_START_FAILED", `无法启动 ${this.label}。`, {
          command: this.command,
          reason: error instanceof Error ? error.message : String(error),
        }, 503));
      };
      this.child.once("spawn", onSpawn);
      this.child.once("error", onError);
    });
    this.reader = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.child.stdin.on("error", (error) => this.#inputFailed(error));
    this.child.stdin.on("drain", () => { this.inputBlocked = false; this.#flushInput(); });
    this.reader.on("line", (line) => this.#onLine(line));
    this.child.stderr.on("data", (chunk) => {
      if (this.stderr.length < 32_768) this.stderr += chunk.toString("utf8").slice(0, 32_768 - this.stderr.length);
    });
    this.child.on("error", (error) => this.#processEnded({ error }));
    this.child.on("close", (code, signal) => { this.exited = true; this.#processEnded({ code, signal }); });
    return this;
  }

  send(message: unknown) {
    this.sendText(`${JSON.stringify(message)}\n`);
  }

  sendText(text: string, { end = false } = {}) {
    if (this.closed || this.inputEnded || !this.child?.stdin?.writable) {
      throw errorFromMessage("AGENT_PROCESS_CLOSED", `${this.label} 进程已经关闭。`, {}, 409);
    }
    this.inputEnded = end;
    this.writeQueue.push({ text: String(text), end });
    this.#flushInput();
  }

  #flushInput() {
    while (!this.closed && !this.inputBlocked && this.writeQueue.length) {
      const { text, end } = this.writeQueue.shift()!;
      try {
        this.inputBlocked = !this.child.stdin.write(text, "utf8", (error) => { if (error) this.#inputFailed(error); });
        if (end) this.child.stdin.end();
      } catch (error) { this.#inputFailed(error); }
    }
  }

  #inputFailed(error: unknown) {
    this.#processEnded({ error });
    void this.kill();
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(errorFromMessage("AGENT_PROCESS_CLOSED", `${this.label} 进程已经关闭。`, {}, 409));
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(errorFromMessage("AGENT_REQUEST_TIMEOUT", `${this.label} 请求 ${method} 超时。`, { method }, 504));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve: value => resolve(value as T), reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    this.send({ method, params });
  }

  kill(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.child?.pid || this.exited) return Promise.resolve();
    this.expectedClose = true;
    const child = this.child;
    this.stopPromise = new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => { if (finished) return; finished = true; clearTimeout(timer); resolve(); };
      // Escalation must still wait for close; resolving here can leave the
      // process streams open after callers start removing the workspace.
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 2000);
      child.once("close", finish);
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => child.kill());
      } else child.kill();
    });
    return this.stopPromise;
  }

  #onLine(line: string) {
    if (!line.trim() || this.closed) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.onMessage({ type: "provider.event", payload: { kind: "protocol-error", detail: error instanceof Error ? error.message : String(error), line: line.slice(0, 500) } } as TMessage);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (!message.method && typeof message.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = typeof message.error === "object" ? message.error as Record<string, unknown> : {};
        pending.reject(errorFromMessage("AGENT_REMOTE_ERROR", typeof error.message === "string" ? error.message : `${this.label} request failed.`, {
          method: pending.method,
          code: error.code,
          data: error.data,
        }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    this.onMessage(message as TMessage);
  }

  #processEnded(detail: ProcessCloseDetail) {
    if (this.closed) return;
    this.closed = true;
    this.writeQueue.length = 0;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(errorFromMessage("AGENT_PROCESS_CLOSED", `${this.label} 进程已结束。`, {
        ...detail,
        stderr: this.stderr,
      }));
    }
    this.pending.clear();
    this.reader?.close();
    this.onClose({ ...detail, expected: this.expectedClose, stderr: this.stderr.slice(-2_000) });
  }
}
