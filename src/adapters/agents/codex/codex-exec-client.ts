import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { resolveInvocation } from "../../../lib/command.js";
type CommandInvocation = Awaited<ReturnType<typeof resolveInvocation>>;
import type { CuratorMaterialization, CuratorTrace } from "../../../services/topology/curator-types.js";
import * as z from "zod/v4";
const execEventSchema = z.looseObject({ type: z.string(), thread_id: z.string().optional(), message: z.string().optional(), error: z.looseObject({ message: z.string().optional() }).optional(), usage: z.unknown().optional(), item: z.looseObject({ id: z.string().optional(), type: z.string(), text: z.string().optional(), command: z.string().optional(), aggregated_output: z.string().optional(), exit_code: z.number().optional(), status: z.string().optional() }).optional() });
export interface CommandExecution { id: string | null; command: string; output: string; exitCode?: number; status?: string }
export interface CodexExecution { threadId: string | null; usage: unknown; agentMessages: string[]; commandExecutions: CommandExecution[]; protocolEvents: unknown[]; stderr: string }
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { AppError } from "../../../lib/errors.js";

export function extractJsonObject(text: string): unknown {
  let candidate = String(text ?? "").trim();
  if (candidate.startsWith("```")) {
    candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new AppError("CODEX_OUTPUT_NOT_JSON", "Codex 没有返回可解析的 JSON 对象。", {
      status: 422,
      detail: { outputPreview: candidate.slice(0, 240) },
    });
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw new AppError("CODEX_OUTPUT_NOT_JSON", "Codex 返回的 JSON 无效。", {
      status: 422,
      detail: { reason: error instanceof Error ? error.message : String(error), outputPreview: candidate.slice(0, 240) },
    });
  }
}

export class CodexExecClient {
  invocation: CommandInvocation; cwd?: string; timeoutMs: number; maxOutputBytes: number;
  protocolEvents: unknown[]; agentMessages: string[]; commandExecutions: CommandExecution[];
  stderr: string; rawBytes: number; threadId: string | null; usage: unknown; settled: boolean;
  child?: ChildProcessWithoutNullStreams; reader?: readline.Interface; timer?: ReturnType<typeof setTimeout>;
  resolve!: (result: CodexExecution) => void; reject!: (error: unknown) => void; failureDetail?: string;
  constructor(invocation: CommandInvocation, options: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number } = {}) {
    this.invocation = invocation;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
    this.protocolEvents = [];
    this.agentMessages = [];
    this.commandExecutions = [];
    this.stderr = "";
    this.rawBytes = 0;
    this.threadId = null;
    this.usage = null;
    this.settled = false;
  }

  run(prompt: string): Promise<CodexExecution> {
    return new Promise<CodexExecution>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      try {
        this.child = spawn(this.invocation.executable, this.invocation.args, {
          cwd: this.cwd,
          env: process.env,
          windowsHide: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(new AppError("CODEX_PROCESS_ERROR", "无法启动 codex exec。", {
          status: 503,
          detail: { reason: error instanceof Error ? error.message : String(error) },
          retryable: true,
        }));
        return;
      }

      this.reader = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
      this.reader.on("line", (line) => this.#onLine(line));
      this.child.stderr.on("data", (chunk) => {
        if (this.stderr.length < this.maxOutputBytes) {
          this.stderr += chunk.toString("utf8").slice(0, this.maxOutputBytes - this.stderr.length);
        }
      });
      this.child.on("error", (error) => this.#fail(new AppError("CODEX_PROCESS_ERROR", "codex exec 进程错误。", {
        status: 503,
        detail: { reason: error instanceof Error ? error.message : String(error) },
        retryable: true,
      })));
      this.child.on("close", (code, signal) => {
        if (this.settled) return;
        if (code !== 0) {
          this.#fail(new AppError("CODEX_EXEC_FAILED", "codex exec 未完成拓扑探索。", {
            status: 502,
            detail: { code, signal, protocolError: this.failureDetail ?? null, stderr: this.stderr.slice(-2_000) },
            retryable: true,
          }));
          return;
        }
        this.#finish();
      });
      this.timer = setTimeout(() => {
        this.child?.kill();
        this.#fail(new AppError("CODEX_TURN_TIMEOUT", "codex exec 拓扑探索超时。", { status: 504, retryable: true }));
      }, this.timeoutMs);
      this.timer.unref?.();
      this.child.stdin.end(prompt, "utf8");
    });
  }

  #onLine(line: string) {
    if (!line.trim() || this.settled) return;
    this.rawBytes += Buffer.byteLength(line) + 1;
    if (this.rawBytes > this.maxOutputBytes) {
      this.child?.kill();
      this.#fail(new AppError("CODEX_OUTPUT_TOO_LARGE", "codex exec 事件流超过 MVP 上限。", { status: 502 }));
      return;
    }
    let event;
    try {
      event = execEventSchema.parse(JSON.parse(line));
    } catch (error) {
      this.child?.kill();
      this.#fail(new AppError("CODEX_PROTOCOL_ERROR", "codex exec 输出了无效 JSONL。", {
        status: 502,
        detail: { reason: error instanceof Error ? error.message : String(error), line: line.slice(0, 240) },
      }));
      return;
    }
    this.protocolEvents.push(event);
    if (event.type === "error" || event.type === "turn.failed") {
      this.failureDetail = event.error?.message ?? event.message ?? JSON.stringify(event);
    }
    if (event.type === "thread.started") this.threadId = event.thread_id ?? null;
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      this.agentMessages.push(event.item.text ?? "");
    }
    if (event.type === "item.completed" && event.item?.type === "command_execution") {
      this.commandExecutions.push({
        id: event.item.id ?? null,
        command: event.item.command ?? "",
        output: event.item.aggregated_output ?? "",
        exitCode: event.item.exit_code,
        status: event.item.status,
      });
    }
    if (event.type === "turn.completed") this.usage = event.usage ?? null;
  }

  #finish() {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.reader?.close();
    this.resolve({
      threadId: this.threadId,
      usage: this.usage,
      agentMessages: this.agentMessages,
      commandExecutions: this.commandExecutions,
      protocolEvents: this.protocolEvents,
      stderr: this.stderr,
    });
  }

  #fail(error: unknown) {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.reader?.close();
    this.reject(error);
  }

  interrupt() {
    if (this.child && !this.child.killed) this.child.kill();
  }
}

function includesRelative(text: string, relativePath: string) {
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
  const candidate = String(text).replaceAll("\\", "/").toLowerCase();
  return candidate.includes(normalized) || candidate.includes(path.posix.basename(normalized));
}

function displayCommand(command: string) {
  const value = String(command ?? "");
  const match = value.match(/-Command\s+'([\s\S]*)'$/);
  return (match?.[1] ?? value).replaceAll("'\"'", "'").slice(0, 900);
}

export function deriveExplorationTrace(materialization: Pick<CuratorMaterialization, "nodeFileById" | "edgeIds">, result: Pick<CodexExecution, "commandExecutions" | "stderr">, { maxCommands = 24 } = {}): CuratorTrace {
  const observedNodeIds = new Set<string>();
  const observedEdgeIds = new Set<string>();
  for (const execution of result.commandExecutions) {
    const combined = `${execution.command}\n${execution.output}`;
    const readsNodeArea = /topology[\\/]nodes/i.test(execution.command);
    for (const [nodeId, relativeFile] of Object.entries(materialization.nodeFileById)) {
      if (includesRelative(execution.command, relativeFile)
        || (readsNodeArea && combined.includes(`"id": "${nodeId}"`))
        || (readsNodeArea && combined.includes(`"id":"${nodeId}"`))) {
        observedNodeIds.add(nodeId);
      }
    }
    if (/edges\.jsonl/i.test(execution.command)) {
      for (const edgeId of materialization.edgeIds) {
        if (combined.includes(`"id":"${edgeId}"`) || combined.includes(`"id": "${edgeId}"`) || combined.includes(edgeId)) {
          observedEdgeIds.add(edgeId);
        }
      }
    }
  }
  return {
    commands: result.commandExecutions.slice(0, maxCommands).map((item) => displayCommand(item.command)),
    observedNodeIds: [...observedNodeIds],
    observedEdgeIds: [...observedEdgeIds],
    commandExecutions: result.commandExecutions.slice(0, maxCommands).map((item) => ({
      id: item.id,
      command: displayCommand(item.command),
      exitCode: item.exitCode,
      status: item.status,
      outputPreview: item.output.slice(0, 360),
    })),
    stderrPreview: result.stderr.slice(-1_000),
  };
}
