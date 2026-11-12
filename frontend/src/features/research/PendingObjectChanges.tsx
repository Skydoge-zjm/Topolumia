import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import type { ResearchObjectRef } from "./model";
import { ResearchCandidateCard } from "./ResearchCandidateCard";
export function PendingObjectChanges({ candidates, owner, en, empty }: { candidates: Record<string, unknown>[]; owner: ResearchObjectRef; en: boolean; empty: boolean }) {
  const client = useQueryClient(), [saved, setSaved] = useState(false);
  const review = async (id: string, decision: string, revision: unknown) => {
    await api("/api/research/candidates/" + encodeURIComponent(id) + "/review", { method: "POST", body: JSON.stringify({ decision, expectedRevision: revision }) });
    if (decision === "accept") setSaved(true);
    await Promise.all([client.invalidateQueries({ queryKey: [owner.kind === "group" ? "research-group" : "research-node", projectId(), owner.id] }), ...["topology", "research-context", "agent-research-context", "candidate-preview", "group-members", "research-blocks", "research-block", "object-relations", "experiment-runs", "experiment-data-overview", "experiment-data-metrics", "experiment-data-table", "research-experiments", "experiment-record-plot", "temporary-experiment-compare"].map(key => client.invalidateQueries({ queryKey: [key] }))]);
  };
  return <>{saved && <p role="status" className="research-save-notice">{en ? "The proposed changes have been saved." : "待审变更已保存。"}</p>}{candidates.length > 0 && <section className="research-card research-pending-content"><header className="research-section-heading"><div><h2>{en ? "Proposed research changes" : "待审科研变更"}</h2></div><span className="research-badge">{candidates.length}</span></header>{candidates.map(candidate => <ResearchCandidateCard key={String(candidate.id)} candidate={candidate} en={en} onReview={review} initialExpanded={empty} />)}</section>}</>;
}
