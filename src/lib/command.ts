import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

const executableCache = new Map();

function spawnCaptured(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;

  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;

    let child;
    const terminate = () => {
      if (options.killTree && process.platform === "win32" && child?.pid) {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => child.kill());
      } else child.kill();
    };
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        command,
        args,
        stdout: "",
        stderr: "",
        timedOut: false,
        outputLimitExceeded: false,
        ok: false,
        code: null,
        signal: null,
        error,
      });
      return;
    }

    const append = (target, chunk) => {
      const next = Buffer.concat([target, chunk]);
      if (next.length <= maxOutputBytes) return next;
      outputLimitExceeded = true;
      terminate();
      return next.subarray(0, maxOutputBytes);
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref?.();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        args,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        outputLimitExceeded,
        ...result,
      });
    };

    child.on("error", (error) => finish({ ok: false, code: null, signal: null, error }));
    child.on("close", (code, signal) => {
      finish({
        ok: code === 0 && !timedOut && !outputLimitExceeded,
        code,
        signal,
        error: null,
      });
    });
  });
}

export async function resolveExecutable(command) {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return command;
  }
  if (command === "node") return process.execPath;
  if (executableCache.has(command)) return executableCache.get(command);

  const locator = process.platform === "win32" ? "where.exe" : "which";
  const located = await spawnCaptured(locator, [command], { timeoutMs: 2_000, maxOutputBytes: 32_768 });
  const candidates = located.ok
    ? located.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];

  let resolved = candidates[0] ?? command;
  if (process.platform === "win32") {
    resolved = candidates.find((candidate) => candidate.toLowerCase().endsWith(".cmd"))
      ?? candidates.find((candidate) => candidate.toLowerCase().endsWith(".exe"))
      ?? resolved;
  }
  executableCache.set(command, resolved);
  return resolved;
}

export async function resolveInvocation(command, args = [], options = {}) {
  const executable = await resolveExecutable(command);
  if (process.platform === "win32" && executable.toLowerCase().endsWith("\\codex.cmd")) {
    const script = path.join(path.dirname(executable), "node_modules", "@openai", "codex", "bin", "codex.js");
    try {
      await access(script);
      return { executable: process.execPath, args: [script, ...args.map(String)] };
    } catch {
      // Fall through to the resolved executable for non-standard installations.
    }
  }
  // Windows npm-installed Agent shims are .cmd files and cannot be spawned
  // with shell:false directly (Node reports EINVAL). The executable and argv
  // here come from an allowlisted server-side Agent profile, never from the
  // browser. Keep the generic command runner shell-free by opting into this
  // bridge only for ACP profile launches.
  if (process.platform === "win32" && options.allowCmdShim && executable.toLowerCase().endsWith(".cmd")) {
    return {
      executable: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "call", executable, ...args.map(String)],
    };
  }
  return { executable, args: args.map(String) };
}

export async function runCommand(command, args = [], options = {}) {
  const invocation = await resolveInvocation(command, args, { allowCmdShim: options.allowCmdShim === true });
  return spawnCaptured(invocation.executable, invocation.args, options);
}

export function summarizeCommandFailure(result) {
  if (result.timedOut) return "command timed out";
  if (result.outputLimitExceeded) return "command output exceeded limit";
  if (result.error) return result.error.message;
  return result.stderr.trim() || `command exited with code ${result.code}`;
}
