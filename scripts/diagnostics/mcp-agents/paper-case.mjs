import { createHash } from "node:crypto";
import { Readable } from "node:stream";

// A held-out workflow with a registered original, independent of the tuning prompts.
export const paperPrompt = `Review the registered washout-study.md manuscript for the optics reading group. Check for an existing paper first. Read the manuscript evidence, and also deliver its byte-identical original into in/washout-study.md through the session transfer. Save exactly one pending paper with its title, author and year, a structured two-row table of dwell time and residual drift (numeric cells), and a reading block explaining the study's limitation. Attach the registered original and pin its exact asset-read receipt. Verify the pending table values, then report the candidate ID and the original checksum. Use the workbench paper-reading guidance and Topolumia MCP for research operations.`;

export async function seedPaper(c, actor) {
  const manuscript = [
    "# Dwell time and residual drift", "Author: Lena Quill. Year: 2024.", "",
    "Optics bench memorandum. Each dwell condition was measured on one instrument.",
    "| Dwell (seconds) | Residual drift (mV) |", "| --- | --- |", "| 5 | 0.84 |", "| 20 | 0.29 |",
    "The instrument was not recalibrated between measurements. There were no independent replicates.",
  ].join("\n");
  const asset = await c.assets.upload(Readable.from([Buffer.from(manuscript)]), {
    originalName: "washout-study.md", mediaType: "text/markdown", idempotencyKey: "intake-original",
  }, actor);
  c.changes.direct([
    { op: "addNode", clientRef: "inbox", kind: "note", core: { nodeName: "Optics intake" } },
    { op: "addBlock", owner: { kind: "node", id: "@inbox" }, clientRef: "manuscript", title: "Registered manuscript", type: "document",
      payload: { format: "markdown" }, representations: [{ kind: "asset", role: "source", assetId: asset.id }] },
  ], actor);
  return { assetId: asset.id, checksum: createHash("sha256").update(manuscript).digest("hex") };
}

export function gradePaper(oracle, calls, candidates, answer, formalIntact) {
  const c = candidates[0], ops = c?.operations ?? [];
  const paper = ops.find(o => o.op === "addNode" && o.kind === "paper");
  const blocks = ops.filter(o => o.op === "addBlock");
  const rows = blocks.find(b => b.type === "table")?.payload?.rows ?? [];
  const pair = (x, y) => rows.some(row => Object.values(row).includes(x) && Object.values(row).includes(y));
  const done = calls.filter(call => !call.failed);
  const prose = blocks.filter(b => b.type === "richText").map(b => b.payload?.body).join(" ");
  const exact = done.filter(call => call.tool === "read_assets" && call.args.assetId === oracle.assetId && call.args.view === "text");
  const observedRows = done.filter(call => call.tool === "read_blocks" && call.args.candidateId === c?.id && call.args.view === "values")
    .flatMap(call => call.result.data.items ?? []).map(item => Object.values(item.values ?? {}));
  return {
    pendingPaper: candidates.length === 1 && c.status === "pending" && Boolean(paper),
    formalIntact: Boolean(c) && formalIntact,
    identity: paper?.core.paperTitle === "Dwell time and residual drift" && paper.core.year === 2024 && paper.core.authors?.includes("Lena Quill") === true,
    searched: done.some(call => call.tool === "search" && ["all", "nodes", undefined].includes(call.args.target) && /drift|washout|dwell/i.test(call.args.query)),
    originalDelivered: oracle.downloadedChecksum === oracle.checksum && done.some(call => call.tool === "transfer_asset" && call.args.direction === "download"),
    readOriginal: exact.some(call => call.result.data.text?.includes("independent replicates")),
    receipt: exact.some(call => call.result.readReceipts?.some(receipt => c?.evidenceReads?.some(r => r.id === receipt.id))),
    attached: blocks.some(b => b.representations?.some(r => r.assetId === oracle.assetId)) || [paper, ...blocks].some(o => o?.sourceRefs?.some(r => r.assetId === oracle.assetId)),
    table: rows.length === 2 && pair(5, 0.84) && pair(20, 0.29),
    limitation: /no independent|no replicat|without.*replicat|single.instrument|one instrument|未.*重复|单台/i.test(prose),
    verifiedTable: [[5, 0.84], [20, 0.29]].every(pair => observedRows.some(values => pair.every(n => values.includes(n)))),
    reported: Boolean(c?.id && answer.includes(c.id) && answer.toLowerCase().includes(oracle.checksum)),
  };
}
