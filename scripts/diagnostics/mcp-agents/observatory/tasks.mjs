import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { issueCorrection } from "./fixture.mjs";

export const observatoryCore = ["panel", "packet"];
export const observatoryTasks = [...observatoryCore, "appendix"];
export function observatoryPrompts(site) {
  return {
    panel: [
      `The municipal board is deciding whether to deploy Reed at station ${site.station} in the Alder heat observatory. Check the environment and distinguish sealed blind validation from the superseded daylight pilot. Find the currently signed release rule, use its named run, step and metric, and independently freeze both the Atlas and Reed record blocks. Read their exact values on those snapshots. Create one pending study note for the board. Put numeric Atlas raw, Reed raw and gain (Atlas minus Reed, in °C), and a Disposition item (DEPLOY or HOLD) together in a metric block titled Preliminary. Explain the exclusion and the scope limitation in prose. Pin the signed text read and cite both fixed experiments on the note. Give the candidate ID. Use Topolumia MCP for scientific reads and proposals.`,
      `The QA officer has just issued release B of the same indexed rule and revised the signed station-offset table. Reopen the current evidence. Use the row for ${site.station} and keep the original frozen observations. Revise the same pending note. Preserve Preliminary, append a metric block titled Amended with numeric Reed corrected, corrected gain, and the new Disposition. Cite the new rule and exact table reads in the revision. Attach the newly staged out/station-certificate.csv original, and link this note to the formal Municipal instrument review node with an outgoing informs relation. Verify the saved amended values through the candidate, then report its ID and current decision. Leave the decision pending for the reviewer.`,
    ],
    packet: [
      `Prepare a reviewable evidence packet for station ${site.station} with exactly one new group called Field evidence packet nested under the existing Observatory operations group. Identify the current protocol note, the signed calibration ledger and the sealed challenger experiment. Use exactly those three formal nodes as members with roles protocol, calibration and challenger. Leave archived pilots out. On the group put a structured table with the numeric signed Reed offsets for ${site.station} and ${site.other}, and a short provenance paragraph explaining why the daylight pilot cannot substitute for blind validation. Pin the exact signed-ledger block read. Preserve the registered instrument-register.csv original as a group attachment, also deliver its byte-identical original to in/instrument-register.csv. Link the group to its formal municipal review board with an outgoing informs relation. Read back the pending membership and table, and return the single candidate ID and the register checksum. Use Topolumia MCP for research operations.`,
    ],
    appendix: [
      `The independent reproducibility editor needs a methods appendix for ${site.station}. Trace the Field offsets by station chart to its declared data table and find the signed value for ${site.other}. Verify whether the handover register's file block and the calibration ledger's spreadsheet refer to the same registered original. Recover the actual blind split filter from the code, the paper's external-validity quotation and catalogue URL, and the rule from the metrology original. Read the recorded alternative text of the layout image and deliver its original to in/layout.png. Create one pending note with a structured evidence crosswalk containing those findings, including the chart type, backing table ID, numeric offset and shared register asset ID. Attach the same layout asset and cite the code, quotation and metrology text reads. Check the pending crosswalk and report the candidate ID and the image checksum. Use Topolumia for research operations.`,
    ],
  };
}

function materialized(c, candidate, actor) {
  const view = c.snapshot(candidate.id, actor);
  const allocated = new Set(Object.values(candidate.allocation ?? {}));
  return {
    id: candidate.id, revision: candidate.revision, status: candidate.status,
    nodes: view.nodes.filter(n => allocated.has(n.id)), groups: view.groups.filter(g => allocated.has(g.id)),
    blocks: view.blocks.filter(b => allocated.has(b.owner.id) && b.lifecycle !== "archived"),
    edges: view.topology.edges.filter(e => allocated.has(e.from.id) || allocated.has(e.to.id)),
    evidence: candidate.evidenceReads ?? [],
  };
}
export function captureCandidates(c, actor) {
  return c.store.all("candidates").map(candidate => {
    try { return materialized(c, candidate, actor); }
    catch (error) { return { id: candidate.id, revision: candidate.revision, status: candidate.status, nodes: [], groups: [], blocks: [], edges: [], evidence: [],
      previewError: { code: error.code, message: error.message } }; }
  });
}
export function formalFingerprint(c, actor, hash) {
  const view = c.snapshot(null, actor);
  const ordered = items => [...items].sort((a, b) => a.id.localeCompare(b.id));
  return hash(JSON.stringify([ordered(view.nodes), ordered(view.groups), ordered(view.blocks), ordered(view.topology.edges)]));
}
export function reviewInSandbox(c, actor, pending) {
  if (pending.length !== 1 || pending[0].status !== "pending") return { applied: false };
  const candidate = pending[0];
  try {
    c.reviewCandidate({ actor, candidateId: candidate.id, expectedRevision: candidate.revision, decision: "accept", reason: "Synthetic independent reviewer rehearses application" });
    const formal = c.snapshot(null, actor), ids = new Set([...candidate.nodes, ...candidate.groups].map(o => o.id));
    return { applied: c.store.get("candidates", candidate.id).status === "applied",
      nodes: formal.nodes.filter(n => ids.has(n.id)), groups: formal.groups.filter(g => ids.has(g.id)),
      blocks: formal.blocks.filter(b => ids.has(b.owner.id) && b.lifecycle !== "archived"),
      edges: formal.topology.edges.filter(e => ids.has(e.from.id) || ids.has(e.to.id)) };
  } catch (error) {
    return { applied: false, error: { code: error.code, message: error.message } };
  }
}

export async function runObservatoryTurns({ app, actor, adapter, report, workspace, binding, oracle, trace, prompts, messages, gateway, hash, checkpoint }) {
  const c = app.researchCommands;
  const callCount = async () => (await readFile(trace,"utf8")).trim().split("\n").filter(Boolean).length;
  report.stages = [];
  for (const [i, prompt] of prompts.entries()) {
    if (i === 1) Object.assign(oracle, await issueCorrection(app, actor, workspace, binding.env.TOPOLUMIA_TRANSFER_ROOT, oracle));
    messages.clear();
    const stage = { index: i + 1, started: new Date().toISOString(), nativeSessionId: adapter.nativeSessionId,
      formalBefore: formalFingerprint(c, actor, hash), callStart: await callCount(), requestStart: gateway.requests.length };
    report.stages.push(stage);
    let timer;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Observatory turn deadline")), 900000); });
      const result = await Promise.race([adapter.prompt({ turnId: randomUUID(), content: [{ type: "text", text: prompt }] }), timeout]);
      stage.stop = result.stopReason;
      report.stop = result.stopReason;
    } catch (error) {
      stage.error = { code: error.code, message: error.message };
      report.error = stage.error;
      delete report.stop;
      await adapter.close().catch(() => {});
    } finally {
      clearTimeout(timer);
      stage.answer = [...messages.values()].join("\n");
      stage.callEnd = await callCount();
      stage.requestEnd = gateway.requests.length;
      stage.formalAfter = formalFingerprint(c, actor, hash);
      stage.candidates = captureCandidates(c, actor);
      stage.finished = new Date().toISOString();
      await checkpoint();
    }
    if (stage.stop !== "end_turn") break;
  }
  report.answer = report.stages.at(-1)?.answer;
}
