import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { TopologyService } from "../../src/services/topology/topology-service.js";
import { ResearchState } from "../../src/services/research/research-state.js";
import { ResearchCommandService } from "../../src/services/research/research-command-service.js";
import { commandHelp, commands as cliCommands } from "../../src/domain/research/research-cli-contract.js";
import { toolDefinitions } from "../../src/domain/research/research-mcp-contract.js";
import { MCP_INSTRUCTIONS } from "../../src/domain/research/research-interface.js";

// Isolated contract evaluation: no application data and no model calls.
const topologyService = new TopologyService({ demo: false });
const state = new ResearchState(topologyService.build());
const sourceText = "Each control cell requires three seeds; evaluator v2.";
state.snapshot = { stateVersion: "sources:v1", files: { files: [{ ref: "file:protocol.md", label: "Protocol schedule", version: "version:v1", excerpt: sourceText }] } };
const commands = new ResearchCommandService({ state, topologyService, projectId: "context-evaluation", projectName: "Synthetic context evaluation",
  sourceReader: async () => ({ text: sourceText, complete: true }) });
const actor = { isServerAdmin: true, projectId: "context-evaluation", user: { id: "fixture", displayName: "Synthetic researcher" }, permissions: ["*"] };
const relevant = [
  { op: "addNode", clientRef: "paper", kind: "paper", core: { nodeName: "Noise schedule research", paperTitle: "A synthetic sampling study", abstract: "A comparison of sampling schedules." } },
  { op: "addNode", clientRef: "evaluator", kind: "assumption", core: { nodeName: "LPIPS backbone evaluator", summary: "The evaluation backbone must remain fixed." } },
  { op: "addNode", clientRef: "metrics", kind: "gap", core: { nodeName: "Per-image metric artifact", summary: "Missing individual image measurements." } },
  { op: "addNode", clientRef: "seeds", kind: "hypothesis", core: { nodeName: "Seed sampler variance", summary: "Sampling variation may explain the comparison." } },
];
const noise = Array.from({ length: 500 }, (_, i) => ({ op: "addNode", clientRef: `unrelated-${i}`, kind: "observation",
  core: { nodeName: `Unrelated geometry ${i}`, summary: "Unrelated geometry background. ".repeat(60) } }));
const fullEvidence = "METHOD_EVIDENCE: compare schedules with the same evaluator and three seeds.\n" + "Detailed derivation.\n".repeat(600) + "FULL_EVIDENCE_END";

try {
  const view = commands.changes.direct([...relevant, ...noise, { op: "addBlock", owner: { kind: "node", id: "@paper" }, clientRef: "method", title: "Method evidence", type: "richText",
    payload: { format: "markdown", body: fullEvidence } }], actor);
  const started = performance.now();
  const brief = commands.context({ actor, view: "compact" });
  const briefMs = performance.now() - started;
  const tasks = [
    { query: "noise schedule", target: "nodes", expected: view.allocation["node:paper"] },
    { query: "LPIPS backbone evaluator", target: "nodes", expected: view.allocation["node:evaluator"] },
    { query: "per-image metric artifact", target: "nodes", expected: view.allocation["node:metrics"] },
    { query: "seed sampler variance", target: "nodes", expected: view.allocation["node:seeds"] },
    { query: "three seeds", target: "sources", expected: "file:protocol.md" },
  ];
  const retrieval = tasks.map(({ query, target, expected }) => {
    const before = performance.now();
    const response = commands.search({ actor, query, target, limit: 5, locale: "en" });
    const hits = response.data.items.map(hit => hit.id ?? hit.ref);
    return { query, target, expected, rank: hits.indexOf(expected) + 1, hits,
      returnedChars: response.budget.returnedChars, durationMs: Math.round(performance.now() - before) };
  });
  const overview = commands.readNode({ actor, nodeIds: [view.allocation["node:paper"]] });
  const evidence = await commands.queries.readBlocks({ actor, mode: "read", owner: { kind: "node", id: view.allocation["node:paper"] },
    blockId: view.allocation["block:method"], view: "text", selection: { offset: 0, length: 160 } });
  const source = await commands.readSource({ actor, ref: "file:protocol.md", expectedVersion: "version:v1" });
  const report = {
    schemaVersion: "research-context-evaluation.v2", createdAt: new Date().toISOString(), syntheticData: true,
    scenario: { nodes: relevant.length + noise.length, sources: 1, contentBlocks: 1 },
    brief: { returnedChars: brief.budget.returnedChars, maxChars: brief.budget.maxChars, durationMs: Math.round(briefMs) },
    disclosure: { overviewChars: overview.budget.returnedChars, evidenceChars: evidence.budget.returnedChars,
      overviewExcludesFullEvidence: !JSON.stringify(overview).includes("FULL_EVIDENCE_END") && JSON.stringify(overview).length < fullEvidence.length,
      exactBlockRead: evidence.data.text.includes("METHOD_EVIDENCE"), exactSourceRead: source.data.text === sourceText },
    fixedTooling: { commands: Object.keys(cliCommands).length, toolDefinitions: toolDefinitions().length,
      toolDefinitionsChars: JSON.stringify(toolDefinitions()).length, serverInstructionsChars: MCP_INSTRUCTIONS.length, rootHelpChars: commandHelp("").length },
    hitAt5: retrieval.filter(item => item.rank > 0).length / tasks.length, retrieval,
    limits: "Synthetic lexical retrieval and disclosure checks, not model reasoning or real research quality. Serialized characters are not tokenizer counts.",
  };
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex >= 0 && process.argv[outputIndex + 1]) {
    const output = path.resolve(process.argv[outputIndex + 1]);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.hitAt5 !== 1 || !report.disclosure.overviewExcludesFullEvidence || !report.disclosure.exactBlockRead || !report.disclosure.exactSourceRead) process.exitCode = 1;
} finally {
  await commands.assets.close();
  commands.store.db.close();
}
