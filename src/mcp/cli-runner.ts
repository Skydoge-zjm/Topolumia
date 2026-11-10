import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ResearchMcpBinding } from "../domain/agents/agent-types.js";
import { cliMessageSchema, wireErrorSchema, type ResearchClientError } from "../client/research-response.js";
import type * as z from "zod/v4";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { bundledRoot } from "../config.js";
import { CLI_CONTRACT } from "../domain/research/research-mcp-contract.js";
import { redactAgentSecrets } from "../agent/redact-secrets.js";

export interface CliExecution { pid?: number; durationMs: number; exitCode: number | null }
export interface CliRunResult { data: z.infer<typeof cliMessageSchema>; execution: CliExecution }
export interface CliRunnerOptions { entrypoint?: string; timeoutMs?: number; stdoutLimit?: number; stderrLimit?: number }
export function executionError(code: string, message: string, detail: Partial<ResearchClientError> = {}) {
  return Object.assign(new Error(message), { code, ...detail });
}
const allowedEnvironment =
  /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
export class ResearchCliRunner {
  binding: Pick<ResearchMcpBinding, "env" | "cwd">;
  entrypoint: string; timeoutMs: number; stdoutLimit: number; stderrLimit: number;
  children: Set<ChildProcessWithoutNullStreams>; closed: boolean;
  constructor(binding: Pick<ResearchMcpBinding, "env" | "cwd">, options: CliRunnerOptions = {}) {
    this.binding = binding;
    this.entrypoint =
      options.entrypoint ?? path.join(bundledRoot, "src/cli.js");
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.stdoutLimit = options.stdoutLimit ?? 131072;
    this.stderrLimit = options.stderrLimit ?? 16384;
    this.children = new Set();
    this.closed = false;
  }
  async checkContract() {
    const result = await this.run(["--contract"]);
    if (result.data.contract !== CLI_CONTRACT)
      throw executionError(
        "CLI_CONTRACT_MISMATCH",
        "科研 CLI 机器合同不兼容。",
      );
    return result.data;
  }
  async run(args: string[], input?: unknown, { signal, requestId = randomUUID(), timeoutMs = this.timeoutMs }: { signal?: AbortSignal; requestId?: string; timeoutMs?: number } = {}): Promise<CliRunResult> {
    if (this.closed || signal?.aborted)
      throw executionError("MCP_CANCELLED", "科研调用已取消。", {
        outcome: "cancelled",
      });
    const serialized = input === undefined ? "" : JSON.stringify(input);
    if (Buffer.byteLength(serialized) > 262144)
      throw executionError("CLI_INPUT_TOO_LARGE", "科研输入超过 256 KiB。");
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          allowedEnvironment.test(key),
        ),
      ),
      ...this.binding.env,
      TOPOLUMIA_REQUEST_ID: requestId,
    };
    return new Promise<CliRunResult>((resolve, reject) => {
      let stdout = Buffer.alloc(0),
        stderr = Buffer.alloc(0),
        failure: ResearchClientError | null = null;
      const started = Date.now();
      const child = spawn(process.execPath, [this.entrypoint, ...args], {
        cwd: this.binding.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.children.add(child);
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const stop = (error: ResearchClientError) => {
        if (failure) return;
        failure = error;
        child.kill();
        escalation = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 300);
        escalation.unref?.();
      };
      const onAbort = () =>
        stop(
          executionError("MCP_CANCELLED", "科研调用已取消。", {
            outcome: "cancelled",
          }),
        );
      const timer = setTimeout(
        () =>
          stop(executionError("CLI_EXECUTION_TIMEOUT", "科研 CLI 执行超时。")),
        timeoutMs,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk) => {
        if (stdout.length + chunk.length > this.stdoutLimit)
          stop(executionError("CLI_OUTPUT_LIMIT", "科研 CLI 输出超过限制。"));
        else stdout = Buffer.concat([stdout, chunk]);
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length + chunk.length > this.stderrLimit)
          stop(
            executionError("CLI_OUTPUT_LIMIT", "科研 CLI 诊断输出超过限制。"),
          );
        else stderr = Buffer.concat([stderr, chunk]);
      });
      child.stdin.on("error", () => {});
      child.once("error", () => {
        failure ??= executionError("CLI_START_FAILED", "无法启动科研 CLI。");
      });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        clearTimeout(escalation);
        signal?.removeEventListener("abort", onAbort);
        this.children.delete(child);
        const execution = {
          pid: child.pid,
          durationMs: Date.now() - started,
          exitCode,
        };
        if (failure) return reject(Object.assign(failure, { execution }));
        if (exitCode !== 0) {
          let error: z.infer<typeof wireErrorSchema> | undefined;
          try {
            const envelope: unknown = JSON.parse(stderr.toString("utf8"));
            const parsed = wireErrorSchema.safeParse(envelope && typeof envelope === "object" && "error" in envelope ? envelope.error : undefined);
            if (parsed.success) error = parsed.data;
          } catch {
            /* Do not expose raw diagnostics. */
          }
          return reject(
            executionError(
              error?.code ?? "CLI_EXECUTION_FAILED",
              redactAgentSecrets(
                String(error?.message ?? "科研 CLI 执行失败。"),
              ).slice(0, 400),
              {
                exitCode,
                execution,
                detail: redactAgentSecrets(error?.detail ?? null),
              },
            ),
          );
        }
        try {
          const data = cliMessageSchema.parse(JSON.parse(stdout.toString("utf8")));
          resolve({ data, execution });
        } catch {
          reject(
            executionError(
              "CLI_RESPONSE_INVALID",
              "科研 CLI 未返回完整、兼容的 JSON。",
              { execution },
            ),
          );
        }
      });
      child.stdin.end(serialized, "utf8");
      if (signal?.aborted) onAbort();
    });
  }
  async close() {
    this.closed = true;
    await Promise.all(
      [...this.children].map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null) return resolve();
            child.once("close", () => resolve());
            child.kill();
            const timer = setTimeout(() => {
              if (child.exitCode === null) child.kill("SIGKILL");
            }, 300);
            timer.unref?.();
            child.once("close", () => clearTimeout(timer));
          }),
      ),
    );
  }
}
