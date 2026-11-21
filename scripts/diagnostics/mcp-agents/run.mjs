import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cases, grade, seedCase } from "./cases.mjs";
import { meteredGateway, model, providerTokens } from "./gateway.mjs";

const build = path.resolve(process.env.TOPOLUMIA_EVAL_BUILD || "dist");
const product = file => import(pathToFileURL(path.join(build, "src", file)).href);
const [{ startMvpServer }, { CodexAgentAdapter }, { ClaudeCodeAgentAdapter }, { OpenCodeV2AgentAdapter },
  { buildResearchMcpBinding }, { MCP_SESSION_HINT, MCP_INSTRUCTIONS }, { toolDefinitions }] = await Promise.all([
  "server.js", "adapters/agents/codex/codex-agent-adapter.js", "adapters/agents/claude/claude-code-agent-adapter.js",
  "adapters/agents/opencode/v2/opencode-agent-adapter.js", "agent/research-mcp-binding.js", "domain/research/research-interface.js",
  "domain/research/research-mcp-contract.js",
].map(product));

const adapters = { codex: CodexAgentAdapter, claude: ClaudeCodeAgentAdapter, opencode2: OpenCodeV2AgentAdapter };
const [output, selectedRuntime = "all", selectedCase = "all"] = process.argv.slice(2);
if (!output || !["all", ...Object.keys(adapters)].includes(selectedRuntime) || !["all", "probe", ...Object.keys(cases)].includes(selectedCase))
  throw new Error("Usage: node scripts/diagnostics/mcp-agents/run.mjs NEW_OUTPUT_DIR [all|codex|claude|opencode2] [all|dossier|curves|probe]");
const directory = path.resolve(output);
const runtimes = selectedRuntime === "all" ? Object.keys(adapters) : [selectedRuntime];
const scenarios = selectedCase === "all" ? Object.keys(cases) : [selectedCase];
for (const runtime of runtimes) {
  const api = runtime === "claude" ? "ANTHROPIC" : "OPENAI";
  for (const suffix of ["URL", "KEY"]) if (!process.env["TOPOLUMIA_EVAL_" + api + "_" + suffix]) throw new Error("Missing TOPOLUMIA_EVAL_" + api + "_" + suffix);
}
await mkdir(path.dirname(directory), { recursive: true });
await mkdir(directory); // An existing round, including a failed one, is immutable.
const hash = text => createHash("sha256").update(text).digest("hex");
const contract = toolDefinitions();
await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
  model, started: new Date().toISOString(), head: process.env.TOPOLUMIA_EVAL_REVISION || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  contractHash: hash(JSON.stringify(contract) + MCP_INSTRUCTIONS), caseHash: hash(await readFile(new URL("cases.mjs", import.meta.url))),
  prompts: cases, tools: contract.map(t => t.name), definitionChars: JSON.stringify(contract).length,
}, null, 2));

async function run(runtime, key) {
  const prefix = runtime + "-" + key;
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-mcp-eval-"));
  const workspaces = path.join(root, "workspaces");
  const trace = path.join(directory, prefix + ".calls.jsonl");
  const api = runtime === "claude" ? "ANTHROPIC" : "OPENAI";
  const gateway = await meteredGateway(process.env["TOPOLUMIA_EVAL_" + api + "_URL"], process.env["TOPOLUMIA_EVAL_" + api + "_KEY"]);
  const report = { runtime, case: key, model, started: new Date().toISOString(), events: [] };
  let app, adapter, binding, oracle, before, timer;
  const start = Date.now();
  try {
    app = await startMvpServer({ port: 0, host: "127.0.0.1", testMode: false,
      collaborationFile: path.join(root, "account.sqlite"), userSettingsFile: path.join(root, "settings.json"), sshRoot: path.join(root, "ssh"),
      config: { project: { workspacesRoot: workspaces }, sourceRefresh: { enabled: false }, curator: { enabled: false, automation: { enabled: false } } } });
    const projectId = app.config.project.id;
    const workspace = app.config.project.root;
    const user = app.collaboration.bootstrapAdmin({ username: "reviewer", password: randomUUID() + "aA!2" });
    const actor = app.collaboration.actorForUser(user.id, projectId);
    const session = randomUUID();
    const credential = app.collaboration.issueAgentCredential(actor, projectId, session, { researchSessionId: session });
    binding = buildResearchMcpBinding({ baseUrl: app.url, projectId, sessionToken: credential, cwd: workspace, runtimeInstanceId: session, dataRoot: path.join(workspace, ".topolumia") });
    binding.args = [fileURLToPath(new URL("trace-stdio.mjs", import.meta.url)), trace, ...binding.args];
    if (cases[key]) oracle = await seedCase(app, actor, key, workspace, binding);
    before = app.researchCommands.formalTopology().stateVersion;
    await writeFile(trace, "", { flag: "wx" });
    const native = path.join(root, "native");
    await mkdir(native);
    const profile = { id: runtime, provider: runtime === "opencode2" ? "opencode" : runtime, label: runtime, command: process.env["TOPOLUMIA_EVAL_" + runtime.toUpperCase() + "_BIN"] || runtime,
      model, nativeConfigRoot: native, approvalPolicy: "never", ephemeral: true };
    let env;
    if (runtime === "codex") {
      env = { CODEX_HOME: native };
      profile.nativeConfig = { model_provider: "metered", model_providers: { metered: { name: "Metered", base_url: gateway.url + "/v1", wire_api: "responses", experimental_bearer_token: gateway.secret } },
        ...(process.env.TOPOLUMIA_EVAL_CODEX_CATALOG ? { model_catalog_json: process.env.TOPOLUMIA_EVAL_CODEX_CATALOG } : {}), web_search: "disabled" };
      profile.sandbox = "read-only";
    } else if (runtime === "claude") {
      env = { CLAUDE_CONFIG_DIR: native, ANTHROPIC_BASE_URL: gateway.url, ANTHROPIC_AUTH_TOKEN: gateway.secret,
        ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
      profile.permissionMode = "dontAsk";
      profile.extraArgs = ["--strict-mcp-config", "--setting-sources", "project", "--no-session-persistence"];
    } else {
      env = { XDG_DATA_HOME: native, XDG_CONFIG_HOME: native, XDG_CACHE_HOME: native, OPENCODE_DISABLE_MODELS_FETCH: "true" };
      profile.model = "metered/" + model;
      profile.nativeConfig = { model: profile.model, providers: { metered: { name: "Metered", package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: gateway.url + "/v1", apiKey: gateway.secret }, models: { [model]: { name: model, modelID: model, capabilities: { input: ["text"], output: ["text"], tools: true }, limit: { context: 200000, output: 8192 } } } } },
        permissions: [{ action: "*", resource: "*", effect: "ask" }], agents: { title: { disabled: true } }, compaction: { auto: false } };
    }
    const messages = new Map();
    adapter = new adapters[runtime](profile, { env, requestTimeoutMs: 60000, onEvent(event) {
      const p = event.payload ?? {};
      if (event.type === "assistant.message.completed" && p.text) messages.set(p.nativeItemId ?? p.itemId ?? messages.size, p.text);
      if (["usage.updated", "tool.failed", "turn.retrying", "approval.requested", "turn.failed"].includes(event.type)) {
        report.events.push({ type: event.type, id: p.nativeItemId ?? p.toolCallId, tool: p.item?.tool ?? p.toolName,
          error: p.item?.error?.message ?? p.message, usage: p.tokenUsage, nativeModelUsage: p.nativeModelUsage });
      }
      if (event.type === "approval.requested") void adapter.resolvePermission(p.requestId, "reject").catch(() => {});
    } });
    const ready = await adapter.start({ cwd: workspace, researchMcp: binding, developerInstructions: MCP_SESSION_HINT + " " + binding.instructions });
    report.native = ready.agentInfo;
    const text = cases[key] ?? "Use Topolumia MCP get_context once and reply READY.";
    console.log(prefix + " started");
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Benchmark case deadline")), 600000); });
    const result = await Promise.race([adapter.prompt({ turnId: randomUUID(), content: [{ type: "text", text }] }), timeout]);
    report.stop = result.stopReason;
    report.answer = [...messages.values()].join("\n");
  } catch (error) {
    report.error = { code: error.code, message: error.message, detail: typeof error.detail?.stderr === "string" ? error.detail.stderr.slice(-500) : undefined };
  } finally {
    clearTimeout(timer);
    await adapter?.close().catch(() => {});
    const calls = (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(s => JSON.parse(s));
    const candidates = app?.researchCommands?.store.all("candidates") ?? [];
    report.candidates = candidates.map(({ id, revision, status, operations, evidenceReads, provenance }) => ({ id, revision, status, operations, evidenceReads, origin: provenance?.kind }));
    report.oracle = oracle;
    report.formalIntact = before !== undefined && before === app.researchCommands.formalTopology().stateVersion;
    report.checks = oracle ? grade(key, oracle, calls, candidates, report.answer ?? "", report.formalIntact) : {};
    report.passed = Object.values(report.checks).filter(Boolean).length;
    report.possible = Object.keys(report.checks).length;
    report.calls = calls.length;
    report.failedCalls = calls.filter(c => c.failed).length;
    report.requests = gateway.requests;
    report.tokens = providerTokens(gateway.requests);
    report.verifiedModel = gateway.requests.length > 0 && gateway.requests.every(r => r.requested === model) &&
      gateway.requests.some(r => r.status === 200) && gateway.requests.filter(r => r.status === 200).every(r => r.returned === model);
    report.elapsedMs = Date.now() - start;
    await writeFile(path.join(directory, prefix + ".json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ id: prefix, points: [report.passed, report.possible], calls: report.calls, failed: report.failedCalls, tokens: report.tokens?.total, verified: report.verifiedModel, stop: report.stop, error: report.error?.message }));
    await gateway.close();
    await app?.close();
    if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("topolumia-mcp-eval-"))
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return report;
}
const results = await Promise.allSettled(runtimes.flatMap(runtime => scenarios.map(key => run(runtime, key))));
for (const r of results) {
  if (r.status === "rejected") console.error(r.reason);
  if (r.status === "rejected" || !r.value.verifiedModel || r.value.error || !r.value.tokens) process.exitCode = 1;
}
