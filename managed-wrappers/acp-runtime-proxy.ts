import { spawn } from "node:child_process";
import process from "node:process";
import { resolveInvocation } from "../src/lib/command.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const runtime = option("--runtime");
const runtimeArgsJson = option("--runtime-args-json") ?? "[]";
const wrapperId = option("--wrapper-id") ?? "unknown";
let runtimeArgs;
try {
  runtimeArgs = JSON.parse(runtimeArgsJson);
  if (!Array.isArray(runtimeArgs)) throw new Error("runtime args must be an array");
} catch (error) {
  process.stderr.write(`[research-workbench:${wrapperId}] invalid runtime args: ${error.message}\n`);
  process.exitCode = 78;
  process.exit();
}

if (!runtime) {
  process.stderr.write(`[research-workbench:${wrapperId}] runtime command is missing\n`);
  process.exitCode = 78;
  process.exit();
}

let invocation;
try {
  invocation = await resolveInvocation(runtime, runtimeArgs, { allowCmdShim: true });
} catch (error) {
  process.stderr.write(`[research-workbench:${wrapperId}] cannot resolve runtime: ${error.message}\n`);
  process.exitCode = 78;
  process.exit();
}

const child = spawn(invocation.executable, invocation.args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RESEARCH_WORKBENCH_WRAPPER: wrapperId,
    RESEARCH_WORKBENCH_WRAPPER_VERSION: "0.1.0",
  },
  windowsHide: true,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

const forwardSignal = (signal) => {
  try { child.kill(signal); } catch { /* child may already be gone */ }
};
process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));

child.once("error", (error) => {
  process.stderr.write(`[research-workbench:${wrapperId}] runtime failed to start: ${error.message}\n`);
  process.exitCode = 78;
});
child.once("close", (code, signal) => {
  process.exitCode = typeof code === "number" ? code : 1;
  if (signal && process.exitCode === 0) process.exitCode = 1;
});
