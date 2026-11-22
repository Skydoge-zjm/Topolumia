import { metric } from "./fixture.mjs";

const sameNumber = (x, y) => typeof x === "number" && Math.abs(x - y) < 1e-6;
const items = (doc, label) => doc?.blocks?.find(b => b.type === "metric" && b.title.toLowerCase() === label.toLowerCase())?.payload?.items ?? [];
const named = (values, re, expected) => values.some(item => re.test(item.name) &&
  (typeof expected === "number" ? sameNumber(item.value, expected) : String(item.value).trim().toUpperCase() === expected));
const outcome = (gain, threshold) => gain >= threshold ? "DEPLOY" : "HOLD";
const read = (doc, kind, id, version) => doc?.evidence?.some(r => r.object.kind === kind && r.object.id === id &&
  ["content", "structuredValues"].includes(r.disclosure) && r.version === version) === true;
const candidate = stage => stage?.candidates?.length === 1 && stage.candidates[0].status === "pending" ? stage.candidates[0] : undefined;
const outgoing = (doc, from, board) => Boolean(from && doc?.edges?.some(e => e.from.id === from && e.to.id === board && e.type === "informs"));
const assetAttached = (doc, id) => Boolean(id && doc?.blocks?.some(b => b.representations?.some(r => r.kind === "asset" && r.assetId === id)));
const prose = doc => (doc?.blocks ?? []).filter(b => b.type === "richText").map(b => b.payload?.body ?? "").join(" ");
function tableMatches(doc, site, a, b) {
  return (doc?.blocks ?? []).some(block => block.type === "table" && [ [site.station, a], [site.other, b] ].every(([station, value]) =>
    block.payload.rows?.some(row => Object.values(row).includes(station) && Object.values(row).some(v => sameNumber(v, value)))));
}
function pinnedReading(calls, record, note, site, expected) {
  const sources = new Set((note?.sourceRefs ?? []).filter(r => r.kind === "experimentSnapshot").map(r => r.value));
  const snapshots = calls.filter(c => c.tool === "read_experiment" && c.args.mode === "snapshot" && c.result.data.snapshot?.blockId === record.block)
    .map(c => c.result.data.snapshot.id).filter(id => sources.has(id));
  return calls.some(c => c.tool === "read_experiment" && c.args.mode === "series" && snapshots.includes(c.args.snapshotId) &&
    c.args.runId === record.run && c.args.metric === metric && c.result.data.xKey === "step" &&
    c.result.data.points?.some(p => p.x === site.step && sameNumber(p.y, expected)));
}
function confirmedMetric(calls, doc, title, target) {
  const block = doc?.blocks.find(b => b.type === "metric" && b.title.toLowerCase() === title.toLowerCase());
  return Boolean(block && calls.some(c => c.tool === "read_blocks" && c.args.candidateId === doc.id && c.args.blockId === block.id &&
    c.args.view === "values" && c.result.data.items?.some(item => sameNumber(item.value, target))));
}
export function gradeObservatory(report, trace) {
  const { oracle: o, stages = [], review } = report;
  const a = stages[0], b = stages[1];
  const first = candidate(a), last = candidate(stages.at(-1));
  const calls = trace.filter(c => !c.failed), site = o.site;
  const common = {
    singlePending: Boolean(last), untouchedByAgent: Boolean(stages.length && stages.every(s => s.formalBefore === s.formalAfter)),
    candidateReported: Boolean(last && stages.at(-1)?.answer?.includes(last.id)),
    humanApplied: Boolean(review?.applied),
  };
  if (report.case === "packet") {
    const group = last?.groups?.[0];
    const expected = [[o.nodes.protocol,"protocol"],[o.nodes.ledger,"calibration"],[o.nodes.reed,"challenger"]];
    const table = last?.blocks.find(bl => bl.type === "table");
    const seenRows = calls.filter(c => c.tool === "read_blocks" && c.args.candidateId === last?.id && c.args.blockId === table?.id &&
      c.args.view === "values").flatMap(c => c.result.data.items ?? []).map(row => Object.values(row.values ?? {}));
    return { ...common,
      identity: Boolean(last?.groups?.length === 1 && !last.nodes.length && group.core.nodeName.toLowerCase() === "field evidence packet"),
      parent: group?.parentId === o.groups.operations,
      members: Boolean(group?.members.length === 3 && expected.every(([id, role]) => group.members.some(m => m.nodeId === id && m.role?.toLowerCase() === role))),
      stationRows: tableMatches(last, site, 0, site.otherOffset),
      signedEvidence: read(last, "block", o.ledger, 1),
      blinding: /pilot|daylight/i.test(prose(last)) && /train|overlap|not blind|different split/i.test(prose(last)),
      assetAttached: assetAttached(last, o.basisAsset),
      deliveredOriginal: report.downloadedChecksum === o.basisChecksum && calls.some(c => c.tool === "transfer_asset" && c.args.direction === "download" && c.result.data.checksum?.endsWith(o.basisChecksum)),
      checksumReported: Boolean(a?.answer?.includes(o.basisChecksum)),
      boardRelation: outgoing(last, group?.id, o.nodes.board),
      verifiedMembership: Boolean(group && calls.some(c => c.tool === "read_groups" && c.args.mode === "members" && c.args.groupId === group.id &&
        c.args.candidateId === last.id && c.result.data.items?.some(m => m.object?.id === o.nodes.reed))),
      verifiedTable: [[site.station,0],[site.other,site.otherOffset]].every(([station,value]) => seenRows.some(fields => fields.includes(station) && fields.some(v => sameNumber(v,value)))),
      persistedPacket: Boolean(review?.applied && review.groups.some(g => g.id === group?.id && g.parentId === o.groups.operations) &&
        outgoing(review, group?.id, o.nodes.board) && assetAttached(review, o.basisAsset) && tableMatches(review, site, 0, site.otherOffset)),
    };
  }
  const firstCalls = trace.slice(a?.callStart ?? 0, a?.callEnd ?? 0).filter(c => !c.failed);
  const secondCalls = trace.slice(b?.callStart ?? 0, b?.callEnd ?? 0).filter(c => !c.failed);
  const preliminary = items(first,"Preliminary"), amended = items(last,"Amended"), note = first?.nodes[0], finalNote = last?.nodes[0];
  const decisionA = outcome(o.initialGain,site.threshold), decisionB = outcome(o.finalGain,site.threshold);
  const file = secondCalls.find(c => c.tool === "transfer_asset" && c.args.direction === "upload" && c.result.data.checksum?.endsWith(o.certificateChecksum ?? "missing"));
  const oldPins = (note?.sourceRefs ?? []).filter(r => r.kind === "experimentSnapshot").map(r => r.value);
  return { ...common,
    twoTurns: Boolean(b && a?.stop === "end_turn" && b.stop === "end_turn" && report.nativeSession),
    preliminaryIdentity: Boolean(first?.nodes?.length === 1 && note.kind === "note" && first?.id && a?.answer?.includes(first.id)),
    environment: firstCalls.some(c => c.tool === "get_environment"),
    originalRule: read(first,"source",o.rule,o.initialVersion),
    atlasSnapshot: pinnedReading(firstCalls,o.atlas,note,site,site.atlas),
    reedSnapshot: pinnedReading(firstCalls,o.reed,note,site,site.reed),
    rawPair: named(preliminary,/atlas/i,site.atlas) && named(preliminary,/reed/i,site.reed),
    preliminaryGain: named(preliminary,/gain|improv|differ|delta/i,o.initialGain),
    preliminaryDisposition: named(preliminary,/disposition|decision|verdict/i,decisionA),
    scopeAndExclusion: /pilot|daylight/i.test(prose(first)) && /train|overlap/i.test(prose(first)) && /single.site|one station|independent station|city.wide|one site/i.test(prose(first)),
    sameCandidate: Boolean(first && last && first.id === last.id && last.revision > first.revision && finalNote?.id === note?.id),
    retainedBaseline: Boolean(first && last && preliminary.length && JSON.stringify(items(last,"Preliminary")) === JSON.stringify(preliminary) &&
      oldPins.length === 2 && oldPins.every(id => finalNote?.sourceRefs.some(r => r.value === id))),
    amendedEvidence: Boolean(o.initialVersion !== o.revisedVersion && read(last,"source",o.rule,o.revisedVersion) && read(last,"block",o.ledger,o.ledgerRevision)),
    reacquiredEvidence: Boolean(b && secondCalls.some(c => c.tool === "read_source" && c.result.data.source?.version === o.revisedVersion) &&
      secondCalls.some(c => c.tool === "read_blocks" && c.args.blockId === o.ledger && c.result.readReceipts?.some(r => r.version === o.ledgerRevision))),
    correctedReed: named(amended,/reed/i,o.corrected),
    amendedGain: named(amended,/gain|improv|differ|delta/i,o.finalGain),
    amendedDisposition: named(amended,/disposition|decision|verdict/i,decisionB),
    certificate: assetAttached(last,file?.result.data.assetId),
    directedHandover: outgoing(last,finalNote?.id,o.nodes.board),
    verifiedAmendment: confirmedMetric(secondCalls,last,"Amended",o.corrected) && confirmedMetric(secondCalls,last,"Amended",o.finalGain),
    persistedDecision: Boolean(review?.applied && outgoing(review,finalNote?.id,o.nodes.board) && named(items(review,"Amended"),/disposition|decision|verdict/i,decisionB)),
  };
}
