import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cases, grade } from "./cases.mjs";

const directory = path.resolve(process.argv[2] || "artifacts/mcp-optimization");
const rounds = (await readdir(directory, { withFileTypes: true })).filter(d => d.isDirectory() &&
  (/^round-\d+$/.test(d.name) || ["control-main", "control-repeat", "confirm-final", "confirm-release", "holdout-paper", "retest-paper"].includes(d.name))).map(d => d.name).sort();
const rows = [];
for (const round of rounds) {
  const dir = path.join(directory, round);
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  for (const file of (await readdir(dir)).filter(n => /^(codex|claude|opencode2)-.+\.json$/.test(n))) {
    const r = JSON.parse(await readFile(path.join(dir, file), "utf8"));
    const trace = (await readFile(path.join(dir, file.replace(/\.json$/, ".calls.jsonl")), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const checks = (cases[r.case] || r.case === "paper") && r.oracle ? grade(r.case, r.oracle, trace, r.candidates, r.answer ?? "", r.formalIntact) : {};
    const passed = Object.values(checks).filter(Boolean).length, possible = Object.keys(checks).length;
    const failedNative = new Set(r.events.filter(e => e.type === "tool.failed" && e.tool && !manifest.tools.includes(e.tool) &&
      !/topolumia|mcpToolCall/i.test(e.tool)).map(e => e.id ?? JSON.stringify(e))).size;
    const nativeTotal = r.events.filter(e => e.usage?.total?.totalTokens > 0).at(-1)?.usage.total.totalTokens ?? null;
    rows.push({
      round, runtime: r.runtime, case: r.case, verifiedModel: r.verifiedModel, stop: r.stop ?? r.error?.message ?? "unknown", passed, possible,
      complete: Boolean(possible && passed === possible && r.verifiedModel && r.stop === "end_turn"),
      input: r.tokens?.input ?? null, cached: r.tokens?.cached ?? null, output: r.tokens?.output ?? null, total: r.tokens?.total ?? null, nativeTotal,
      tokensPerPoint: r.tokens && passed > 0 ? Math.round(r.tokens.total / passed) : null,
      mcpCalls: trace.length, mcpFailures: trace.filter(c => c.failed).length, nativeFailures: failedNative,
      httpFailures: r.requests.filter(req => req.status >= 400 || req.status == null && req.error).length, elapsedSeconds: Math.round(r.elapsedMs / 1000),
      tools: [...new Set(trace.filter(c => !c.failed).map(c => c.tool))].sort(), missed: Object.keys(checks).filter(k => !checks[k]),
    });
  }
}
const header = Object.keys(rows[0] ?? {});
const csv = v => '"' + (Array.isArray(v) ? v.join("|") : String(v ?? "")).replaceAll('"', '""') + '"';
await writeFile(path.join(directory, "metrics.csv"), [header.join(","), ...rows.map(row => header.map(k => csv(row[k])).join(","))].join("\n") + "\n");
await writeFile(path.join(directory, "metrics.json"), JSON.stringify(rows, null, 2));
for (const round of rounds) {
  const batch = rows.filter(row => row.round === round);
  const sum = key => batch.reduce((s, row) => s + (row[key] ?? 0), 0);
  console.log([round, batch.length, sum("passed") + "/" + sum("possible"), sum("mcpFailures"), batch.every(r => r.total != null) ? sum("total") : "incomplete usage"].join("\t"));
}
