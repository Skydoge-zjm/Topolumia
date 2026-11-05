import { startMvpServer } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";
import { resolveOpenCodeModelId } from "../../src/adapters/agents/opencode/opencode-server.js";
import { redactAgentSecrets } from "../../src/agent/redact-secrets.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Opt-in real-provider acceptance; each runtime owns isolated synthetic state.
function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
const model = option("--model");
const runtime = option("--runtime", "opencode");
const timeoutMs = Number(option("--timeout-ms", "360000"));
if (
  !model ||
  !["all", "codex", "claude", "opencode"].includes(runtime) ||
  !Number.isSafeInteger(timeoutMs) ||
  timeoutMs < 1000 ||
  timeoutMs > 600000
) {
  throw new Error(
    "Usage: --model MODEL [--runtime codex|claude|opencode|all] [--timeout-ms 1000..600000] [--output FILE]. Calls real providers.",
  );
}
const output = path.resolve(
  option("--output", `test-results/agent-context-real-smoke-${runtime}.json`),
);
const config = await loadConfig();
const requested =
  runtime === "all" ? ["codex", "claude", "opencode"] : [runtime];
function progress(provider, phase, extra = {}) {
  process.stdout.write(
    `${JSON.stringify({ runtime: provider, phase, ...extra })}\n`,
  );
}
async function run(provider) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), `topolumia-${provider}-smoke-`),
  );
  const workspace = path.join(root, "workspace");
  const policy =
    "AURORA_FINAL_POLICY: seeds=[11,29,47]; evaluator=eval-7.4. Synthetic test data, not a real study.";
  const sourceText =
    "# Synthetic AURORA study\n" +
    "Background unrelated to the final sampling decision.\n".repeat(80) +
    `\n${policy}\n`;
  let app;
  const started = Date.now();
  const report: any = {
    runtime: provider,
    syntheticData: true,
    success: false,
    requestedModel: model,
    startedAt: new Date().toISOString(),
  };
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, "aurora-protocol.md"), sourceText);
    for (let i = 0; i < 15; i++)
      await writeFile(
        path.join(workspace, `unrelated-${i}.md`),
        `# Unrelated study ${i}\nGeometry notes; not the AURORA sampling protocol.\n`,
      );
    const profile = config.agentSessions.profiles.find(
      (item) => item.provider === provider,
    );
    if (!profile) throw new Error(`No ${provider} profile configured.`);
    app = await startMvpServer({
      port: 0,
      collaborationFile: path.join(root, "db.sqlite"),
      userSettingsFile: path.join(root, "settings.json"),
      config: {
        project: {
          id: "agent-context-smoke",
          name: "Synthetic context smoke",
          root: workspace,
        },
        filesystem: { roots: [workspace] },
        sourceRefresh: { enabled: false },
        curator: { enabled: false, automation: { enabled: false } },
        agentSessions: {
          requestTimeoutMs: timeoutMs,
          profiles: [{ ...profile, model }],
        },
      },
    });
    const profiles = await app.agentSessionGateway.profiles();
    report.availability = profiles[0]?.availability;
    report.runtimeVersion = profiles[0]?.runtime?.version;
    let resolved = model;
    if (provider === "opencode") {
      resolved = resolveOpenCodeModelId(profiles[0]?.models ?? [], model);
    }
    report.model = resolved;
    progress(provider, "calling-provider", { model: resolved });
    const response = await fetch(`${app.url}/api/agent-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileId: profile.id,
        title: "Synthetic retrieval acceptance",
      }),
      signal: AbortSignal.timeout(90000),
    });
    const session = await response.json();
    if (!response.ok)
      throw new Error(session.error?.message ?? "Session creation failed");
    report.sessionModel = session.model;
    const initialFormalVersion =
      app.researchCommands.formalTopology().stateVersion;
    app.agentSessionGateway.startTurn(session.id, {
      text: "这是一次合成科研检索验收。只使用 Topolumia MCP 工具操作科研状态。先 get_context，再 search 查找 AURORA_FINAL_POLICY，通过 read_source 读取匹配版本的原文。报告精确 seeds 和 evaluator，附 ref、version 和字符范围。创建且仅创建一个 pending gap 候选，说明仍需真实实验验证；引用该来源并用 evidenceReadIds 固定其读取回执。不要审批，不引用无关 study。简短中文回复。",
    });
    const deadline = Date.now() + timeoutMs + 5000;
    let detail;
    let lastTools = 0;
    let lastUpdate = Date.now();
    do {
      await new Promise((resolve) => setTimeout(resolve, 200));
      detail = app.agentSessionGateway.snapshot(session.id);
      const calls = (detail.conversationEvents ?? detail.events).filter(
        (event) => event.type === "tool.started",
      );
      if (calls.length !== lastTools || Date.now() - lastUpdate > 20000) {
        progress(provider, "running", {
          status: detail.status,
          tools: calls.length,
          elapsedMs: Date.now() - started,
        });
        lastTools = calls.length;
        lastUpdate = Date.now();
      }
      if (
        ["ready", "failed", "awaiting_permission"].includes(detail.status) &&
        detail.turns.length
      )
        break;
    } while (Date.now() < deadline);
    report.status = detail.status;
    const transcript = detail.conversationEvents ?? detail.events;
    report.tools = transcript
      .filter((event) => event.type === "tool.started")
      .map((event) => ({
        tool:
          event.payload.item?.tool ??
          event.payload.item?.kind ??
          event.payload.kind,
        arguments:
          event.payload.item?.arguments ?? event.payload.item?.input ?? null,
        command: event.payload.item?.command ?? null,
      }));
    report.toolResults = transcript
      .filter((event) => ["tool.completed", "tool.failed"].includes(event.type))
      .map((event) => ({
        type: event.type,
        item: event.payload.item ?? event.payload,
      }));
    report.errors = transcript
      .filter((event) => ["turn.failed", "tool.failed"].includes(event.type))
      .map(
        (event) =>
          event.payload.error ?? event.payload.item?.error ?? event.payload,
      );
    report.turnStatus = detail.turns.at(-1)?.status;
    report.output = detail.turns.at(-1)?.assistantText;
    report.usage = detail.events
      .filter((event) => event.type === "usage.updated")
      .map((event) => event.payload);
    report.usageLatest = detail.usage;
    report.traceRetention = detail.eventRetention;
    report.cliExecutions = app.collaboration.db
      .prepare(
        "SELECT tool,outcome,pid,duration_ms,result_id,result_chars,content_chars,structured_chars,estimated_result_tokens,tool_definition_chars,instructions_chars FROM research_tool_calls WHERE project_id=? ORDER BY started_at",
      )
      .all(app.config.project.id);
    const candidates = app.researchCommands.data().candidates;
    report.candidates = candidates.map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      sourceRefs: candidate.sourceRefs,
      evidenceReads: candidate.evidenceReads,
      operations: candidate.operations,
    }));
    const policyStart = sourceText.indexOf(policy);
    const pinned = candidates[0]?.evidenceReads?.find(
      (read) =>
        read.refs?.includes("file:aurora-protocol.md") &&
        read.range?.start > 1800 &&
        read.range.start <= policyStart &&
        read.range.end >= policyStart + policy.length,
    );
    report.checks = {
      selectedModel: session.model === resolved,
      completed: report.turnStatus === "completed",
      exactFacts:
        /\[\s*11\s*,\s*29\s*,\s*47\s*\]/.test(report.output ?? "") &&
        /eval-7\.4\b/.test(report.output ?? ""),
      onePendingCandidate:
        candidates.length === 1 && candidates[0].status === "pending",
      onlyRelevantSource:
        candidates[0]?.sourceRefs.length === 1 &&
        candidates[0].sourceRefs[0] === "file:aurora-protocol.md",
      gapProposed:
        (candidates[0]?.operations.length === 1 &&
          candidates[0].operations.some(
            (operation) =>
              operation.op === "addNode" && operation.node?.kind === "gap",
          )) ??
        false,
      pinnedPassage: Boolean(pinned),
      formalStateUnchanged:
        initialFormalVersion ===
        app.researchCommands.formalTopology().stateVersion,
      citedVersionAndRange: Boolean(
        pinned &&
        report.output?.includes(pinned.sourceVersion) &&
        [pinned.range.start, pinned.range.end].every((value) =>
          report.output?.includes(String(value)),
        ),
      ),
      nativeMcp: report.tools.some((call) =>
        /mcp|topolumia|get_context|read_source|create_candidate/i.test(
          String(call.tool) + JSON.stringify(call),
        ),
      ),
      candidateViaCli: report.cliExecutions.some(
        (call) =>
          call.tool === "create_candidate" &&
          call.outcome === "completed" &&
          call.pid > 0 &&
          call.result_id === candidates[0]?.id,
      ),
    };
    report.success = Object.values(report.checks).every(Boolean);
  } catch (error) {
    report.error = { code: error.code, message: error.message };
  } finally {
    if (app) {
      await app.agentSessionGateway.closeAll();
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
    try {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
      report.cleanedUp = true;
    } catch (error) {
      report.cleanedUp = false;
      report.cleanupError = { code: error.code, message: error.message };
      report.success = false;
    }
    report.elapsedMs = Date.now() - started;
    progress(provider, "finished", {
      success: report.success,
      checks: report.checks,
      error: report.error,
      elapsedMs: report.elapsedMs,
    });
  }
  return redactAgentSecrets(report);
}
const results = await Promise.all(requested.map(run));
const report = {
  schemaVersion: "real-agent-context-smoke.v2",
  syntheticData: true,
  requestedModel: model,
  success: results.every((result) => result.success),
  results,
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ success: report.success, output })}\n`,
);
if (!report.success) process.exitCode = 1;
