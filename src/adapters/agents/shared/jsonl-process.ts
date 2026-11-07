import { spawn } from "node:child_process";
import readline from "node:readline";
import { resolveInvocation } from "../../../lib/command.js";
import { withoutResearchCredentials } from "../../../agent/research-mcp-binding.js";
import { errorFromMessage } from "./agent-driver.js";

export class JsonlProcess {
  constructor({ command, args = [], cwd, env, label, onMessage, onClose, requestTimeoutMs = 300_000 } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.label = label ?? command;
    this.onMessage = onMessage ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.requestTimeoutMs = requestTimeoutMs;
    this.pending = new Map();
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
        reason: error.message,
      }, 503);
    }
    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        this.child.off("error", onError);
        resolve();
      };
      const onError = (error) => {
        this.child.off("spawn", onSpawn);
        reject(errorFromMessage("AGENT_PROCESS_START_FAILED", `无法启动 ${this.label}。`, {
          command: this.command,
          reason: error.message,
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

  send(message) {
    this.sendText(`${JSON.stringify(message)}\n`);
  }

  sendText(text, { end = false } = {}) {
    if (this.closed || this.inputEnded || !this.child?.stdin?.writable) {
      throw errorFromMessage("AGENT_PROCESS_CLOSED", `${this.label} 进程已经关闭。`, {}, 409);
    }
    this.inputEnded = end;
    this.writeQueue.push({ text: String(text), end });
    this.#flushInput();
  }

  #flushInput() {
    while (!this.closed && !this.inputBlocked && this.writeQueue.length) {
      const { text, end } = this.writeQueue.shift();
      try {
        this.inputBlocked = !this.child.stdin.write(text, "utf8", (error) => { if (error) this.#inputFailed(error); });
        if (end) this.child.stdin.end();
      } catch (error) { this.#inputFailed(error); }
    }
  }

  #inputFailed(error) {
    this.#processEnded({ error });
    void this.kill();
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (this.closed) return Promise.reject(errorFromMessage("AGENT_PROCESS_CLOSED", `${this.label} 进程已经关闭。`, {}, 409));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(errorFromMessage("AGENT_REQUEST_TIMEOUT", `${this.label} 请求 ${method} 超时。`, { method }, 504));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  kill() {
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

  #onLine(line) {
    if (!line.trim() || this.closed) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.onMessage({
        type: "provider.event",
        payload: { kind: "protocol-error", detail: error.message, line: line.slice(0, 500) },
      });
      return;
    }
    if (!message?.method && message?.id !== undefined && message?.id !== null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(errorFromMessage("AGENT_REMOTE_ERROR", message.error.message ?? `${this.label} request failed.`, {
          method: pending.method,
          code: message.error.code,
          data: message.error.data,
        }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    this.onMessage(message);
  }

  #processEnded(detail) {
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
