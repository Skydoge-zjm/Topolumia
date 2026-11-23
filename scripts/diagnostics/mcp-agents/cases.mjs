import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { seedPaper, gradePaper } from "./paper-case.mjs";

const stamp = "Calibration batch KESTREL-42; signed by station M4.\n";
const checksum = createHash("sha256").update(stamp).digest("hex");
const nodeRef = id => ({ kind: "node", id });

export const cases = {
  dossier: `Prepare a reviewable handover for the Kestrel calibration group. Establish the project brief, identify the baseline member and the destination of the group's outgoing logical relation. From the group's acceptance block and the indexed kestrel-protocol.md source, recover the threshold, required seeds and evaluator. The handover office supplied out/calibration.txt in the session transfer directory. Upload it, verify its registered metadata, and attach the original file to the handover. Create exactly one pending note candidate with the findings, explicit source and block read receipts, and a source reference to the protocol. Then add a separately titled Limitations block to that same candidate in a revision. Check the saved candidate and return its ID, the actual calibration checksum and the findings. Use Topolumia MCP for research reads and changes. Leave formal objects untouched.`,
  curves: `Audit the Kestrel drift experiment for a reviewer planning a rerun. Check the selected environment and locate the experiment from the project. Freeze its record block and compare the baseline and variant at step 3 of validation/loss. Use the exact series for both runs at the same snapshot, and inspect the metric block format. Save exactly one pending research note with a metric block holding the two observed values and a numeric absolute improvement (baseline minus variant). Attach the reproducible experiment snapshot reference to the note. Record that two individual runs cannot establish statistical significance. Verify the saved block through the pending candidate, then report the candidate ID, values and difference. Use Topolumia MCP for research data and changes.`,
};

export async function seedCase(app, actor, key, root, binding) {
  const c = app.researchCommands;
  if (key === "paper") return seedPaper(c, actor);
  const change = operations => c.changes.direct(operations, actor);
  const node = (ref, kind, name) => ({ op: "addNode", clientRef: ref, kind, core: { nodeName: name } });
  if (key === "dossier") {
    await writeFile(path.join(root, "kestrel-protocol.md"), "# Kestrel protocol\n" + "Calibration materials were archived.\n".repeat(16) + "Accepted replication seeds are 17, 31, and 59. Use evaluator E7-r3.\n");
    await writeFile(path.join(root, "kestrel-draft.md"), "# Superseded memo\nDraft calibration uses a single seed. Not an accepted protocol.\n");
    const files = await app.registry.filesystem.snapshot();
    app.state.snapshot = { stateVersion: "files:v1", files };
    const n = change([node("base", "note", "Quartz control"), node("decoy", "note", "Slate variant"), node("review", "note", "Meridian review")]).allocation;
    const group = change([{ op: "addGroup", clientRef: "g", core: { nodeName: "Kestrel calibration" }, members: [
      { nodeId: n["node:base"], role: "baseline" }, { nodeId: n["node:decoy"], role: "variant" },
    ] }]).allocation["group:g"];
    const owner = { kind: "group", id: group };
    const block = change([{ op: "addBlock", owner, clientRef: "rule", type: "richText", title: "Acceptance ceiling", payload: { format: "markdown", body: "Accept a batch only when absolute drift is at most 0.0375 mV." } }]).allocation["block:rule"];
    const to = nodeRef(n["node:review"]);
    change([{ op: "addEdge", clientRef: "review", edge: { from: owner, to, type: "informs" }, expectedEndpointRevisions: [owner, to].map(object => ({ object, revision: c.objects.get(object).revision })) }]);
    await mkdir(path.join(binding.env.TOPOLUMIA_TRANSFER_ROOT, "out"), { recursive: true });
    await writeFile(path.join(binding.env.TOPOLUMIA_TRANSFER_ROOT, "out", "calibration.txt"), stamp);
    return { group, block, protocol: files.files.find(f => f.label === "kestrel-protocol.md" || f.ref.endsWith("kestrel-protocol.md"))?.ref, checksum };
  }
  const id = change([node("experiment", "experiment", "Kestrel drift"), node("other", "experiment", "Kestrel pilot archive")]).allocation["node:experiment"];
  const assets = [];
  for (const [name, values] of [["baseline", [0.91, 0.64, 0.57, 0.438]], ["variant", [0.93, 0.67, 0.61, 0.312]]]) {
    const record = { runId: name, name, scalars: { "validation/loss": values.map((value, step) => ({ step, value })), "training/loss": [{ step: 3, value: 0.11 }] } };
    const asset = await c.assets.upload(Readable.from([Buffer.from(JSON.stringify(record))]), { originalName: name + ".json", mediaType: "application/json", idempotencyKey: name }, actor);
    assets.push(asset.id);
  }
  const inspection = await c.records.inspect("wandb", assets, actor);
  const block = change([{ op: "addBlock", owner: nodeRef(id), clientRef: "runs", type: "experimentRecord", title: "Drift validation",
    payload: { provider: "wandb", runs: inspection.runs.map(({ metrics, ...run }) => run) }, representations: assets.map(assetId => ({ kind: "asset", assetId, role: "source" })) }]).allocation["block:runs"];
  return { id, block };
}

export function grade(key, oracle, calls, candidates, answer, formalIntact) {
  if (key === "paper") return gradePaper(oracle, calls, candidates, answer, formalIntact);
  const done = calls.filter(call => !call.failed);
  const saw = (name, condition = () => true) => done.some(call => call.tool === name && condition(call));
  const c = candidates[0];
  const ops = c?.operations ?? [];
  const note = ops.find(op => op.op === "addNode" && op.kind === "note");
  const blocks = ops.filter(op => op.op === "addBlock");
  const body = JSON.stringify([note?.core, ...blocks.map(b => b.payload)]).replaceAll("*", "");
  const common = {
    pendingNote: candidates.length === 1 && c.status === "pending" && Boolean(note),
    formalIntact: Boolean(c) && formalIntact,
    returnedCandidate: Boolean(c?.id && answer.includes(c.id)),
  };
  if (key === "dossier") {
    const reads = c?.evidenceReads ?? [];
    const upload = done.find(call => call.tool === "transfer_asset" && call.args.direction === "upload")?.result.data;
    return { ...common,
      groupAndEdge: /Quartz control/i.test(body) && /Meridian review/i.test(body) &&
        saw("read_groups", call => call.args.mode === "members" && call.args.groupId === oracle.group) &&
        saw("neighbors", call => call.args.object?.id === oracle.group),
      threshold: /0\.0375\s*mV/i.test(body),
      protocolFacts: ["17", "31", "59", "E7-r3"].every(f => body.includes(f)),
      evidence: Boolean(oracle.protocol && reads.some(r => r.object.kind === "source" && r.object.id === oracle.protocol && r.disclosure === "content") && reads.some(r => r.object.kind === "block" && r.object.id === oracle.block && r.disclosure === "content")),
      source: [note, ...blocks].some(op => op?.sourceRefs?.some(r => r.kind === "file" && [oracle.protocol, "kestrel-protocol.md"].includes(r.value))),
      attachment: Boolean(upload?.assetId && (blocks.some(b => b.representations?.some(r => r.assetId === upload.assetId)) ||
        [note, ...blocks].some(op => op?.sourceRefs?.some(r => r.assetId === upload.assetId)))),
      checksum: answer.toLowerCase().includes(checksum) && saw("read_assets", call => call.args.assetId === upload?.assetId),
      incremental: c?.revision >= 2 && blocks.some(b => /limit|局限|限制/i.test(b.title)) && saw("edit_candidate"),
      verified: done.some((call, index) => call.tool === "read_candidates" && call.args.candidateId === c?.id && call.args.mode === "show" &&
        done.slice(0, index).some(prior => prior.tool === "edit_candidate" && prior.args.candidateId === c?.id)),
    };
  }
  const frozen = done.filter(call => call.tool === "read_experiment" && call.args.mode === "snapshot" &&
    call.result.data.snapshot?.blockId === oracle.block).map(call => call.result.data.snapshot.id);
  const series = done.filter(call => call.tool === "read_experiment" && call.args.mode === "series" &&
    call.args.metric === "validation/loss" && call.result.data.points?.some(p => p.x === 3));
  const items = blocks.find(b => b.type === "metric")?.payload?.items ?? [];
  const value = (re, target) => items.some(item => re.test([item.name, item.condition, item.split].join(" ")) && typeof item.value === "number" && Math.abs(item.value - target) < 1e-7);
  return { ...common,
    environment: saw("get_environment"),
    snapshot: Boolean(note?.sourceRefs?.some(r => r.kind === "experimentSnapshot" && frozen.includes(r.value))),
    exactPair: frozen.some(id => new Set(series.filter(call => call.args.snapshotId === id).map(call => call.args.runId)).size === 2),
    baseline: value(/baseline|基线/i, 0.438),
    variant: value(/variant|变体|变种/i, 0.312),
    difference: value(/differ|improv|delta|reduction|gain|差|改善|改进|降低/i, 0.126),
    uncertainty: /(?:no|not|cannot|insufficient|lack|unable|without|preclud|do not|doesn.t|can.t)[^.!。]{0,100}(?:significan|statistic|infer)|(?:significan|statistic)[^.!。]{0,70}(?:not|unknown|undetermined)|(?:need|require|more|additional|repeat)[^.!。]{0,55}(?:replicat|runs)|(?:不能|无法|不足|未能)[^。]{0,50}(?:显著|统计)/i.test(body),
    reportedValues: ["0.438", "0.312", "0.126"].every(f => answer.includes(f)),
    verified: saw("read_blocks", call => call.args.candidateId === c?.id && call.args.mode === "read" && call.args.view === "values" &&
      [0.438, 0.312, 0.126].every(target => call.result.data.items?.some(item => typeof item.value === "number" && Math.abs(item.value - target) < 1e-7))),
  };
}
