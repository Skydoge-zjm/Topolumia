import type { ReadReceipt } from "../../../domain/research/types.js";
import type { ResearchCommandService } from "../research-command-service.js";

export function changedSourceEvidence(c: ResearchCommandService, receipts: readonly ReadReceipt[]) {
  const citations = receipts.filter(r => r.object.kind === "source");
  if (!citations.length) return [];
  const sources = new Map(c.sources().map(s => [s.ref, s]));
  return citations.flatMap(read => {
    const ref = read.object.id, source = sources.get(ref);
    const currentVersion = source?.version ?? (source?.hash ? "sha256:" + source.hash : null);
    if (source && currentVersion === read.version) return [];
    return [{ ref, observedVersion: read.version, currentVersion,
      ...(source ? { readHint: { tool: "read_source", ref, ...(currentVersion ? { expectedVersion: currentVersion } : {}) } } : {}) }];
  });
}
