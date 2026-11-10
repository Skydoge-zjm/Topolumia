import { versionHash } from "../../lib/hash.js";
import { candidateTurn } from "./agent-candidate-turns.js";
import { summarizeCandidate } from "../research/changes/candidate-summary.js";
import type { ResearchCommandService } from "../research/research-command-service.js";
import type { StoredAgentSession, AgentTurn } from "../../domain/agents/agent-types.js";
import type { CandidateSummary } from "../research/changes/candidate-summary.js";

const summaries = new WeakMap<
  object,
  Map<string, { key: string; value: CandidateSummary }>
>();
export function sessionResearchChanges(session: Pick<StoredAgentSession, "researchSessionId" | "candidateTurns"> & { turns?: Pick<AgentTurn, "id" | "startedAt" | "completedAt">[] }, commands: ResearchCommandService) {
  const candidates = commands.store.forSession(
    "candidates",
    session.researchSessionId,
  );
  const links = new Map(Object.entries(session.candidateTurns ?? {}));
  const stateVersion = commands.state.topology?.stateVersion ?? "";
  let cache = summaries.get(commands);
  if (!cache) {
    cache = new Map();
    summaries.set(commands, cache);
  }
  const items = candidates.map((candidate) => {
    const key = `${candidate.revision}:${candidate.status}:${stateVersion}`;
    let summary = cache.get(candidate.id);
    if (!summary || summary.key !== key) {
      summary = { key, value: summarizeCandidate(commands, candidate) };
      cache.set(candidate.id, summary);
    }
    return {
      id: candidate.id,
      revision: candidate.revision,
      status: candidate.status,
      reason: candidate.reason,
      turnId: candidateTurn(candidate, session, links),
      createdAt: candidate.createdAt,
      summary: summary.value,
    };
  });
  const version = versionHash(
    items.map((item) => [
      item.id,
      item.revision,
      item.status,
      item.turnId,
      item.summary,
    ]),
  );
  return { candidates: items, version };
}
