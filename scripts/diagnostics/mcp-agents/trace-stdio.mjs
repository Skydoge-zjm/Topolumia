import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Transparent stdio tap. Validation failures can happen before the CLI audit row exists.
const [file, entry] = process.argv.slice(2);
const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
const pending = new Map();
createInterface({ input: process.stdin }).on("line", line => {
  let packet;
  try { packet = JSON.parse(line); } catch { return; }
  if (packet.method === "tools/call") pending.set(packet.id, { tool: packet.params.name, args: packet.params.arguments ?? {}, at: Date.now() });
});
createInterface({ input: child.stdout }).on("line", line => {
  let packet;
  try { packet = JSON.parse(line); } catch { return; }
  const call = pending.get(packet.id);
  if (!call) return;
  pending.delete(packet.id);
  const result = packet.result?.structuredContent ?? packet.result?.content ?? packet.error;
  appendFileSync(file, JSON.stringify({ ...call, ms: Date.now() - call.at, failed: Boolean(packet.error || packet.result?.isError), result }) + "\n");
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stdin.on("error", () => {});
process.on("exit", () => child.kill());
child.on("exit", code => process.exit(code ?? 1));
