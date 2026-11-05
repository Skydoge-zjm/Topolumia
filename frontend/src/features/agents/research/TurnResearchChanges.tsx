import { FileCheck2 } from "lucide-react";
import { ResearchCandidateCard } from "@/features/research/ResearchCandidateCard";
import type { SessionCandidate } from "./useSessionResearch";

export function TurnResearchChanges({
  candidates,
  en,
  onReview,
}: {
  candidates: SessionCandidate[];
  en: boolean;
  onReview: (id: string, decision: string, revision: unknown) => Promise<void>;
}) {
  if (!candidates.length) return null;
  const pending = candidates.filter((candidate) =>
    ["pending", "deferred"].includes(candidate.status),
  ).length;
  return (
    <section
      className="agent-turn-changes research-workspace"
      aria-label={en ? "Proposed research changes" : "本轮科研变更"}
    >
      <header>
        <FileCheck2 size={16} aria-hidden="true" />
        <h3>{en ? "Research changes" : "科研变更"}</h3>
        {pending > 0 && (
          <span>
            {en ? `${pending} awaiting review` : `${pending} 项待审阅`}
          </span>
        )}
      </header>
      {candidates.map((candidate) => (
        <ResearchCandidateCard
          key={candidate.id}
          candidate={candidate}
          en={en}
          onReview={onReview}
        />
      ))}
    </section>
  );
}
