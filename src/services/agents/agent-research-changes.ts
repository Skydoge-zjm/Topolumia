import { versionHash } from "../../lib/hash.js";
import { candidateTurn } from "./agent-candidate-turns.js";
import { summarizeCandidate } from "../research/changes/candidate-summary.js";

const summaries = new WeakMap<
  object,
  Map<string, { key: string; value: unknown }>
>();
export function sessionResearchChanges(session, commands) {
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
