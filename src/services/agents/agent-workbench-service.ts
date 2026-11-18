import { sessionResearchChanges } from "./agent-research-changes.js";
import type { ResearchCommandService } from "../research/research-command-service.js";
import type { StoredAgentSession, AgentTurn } from "../../domain/agents/agent-types.js";

export function agentResearchContext(session: Pick<StoredAgentSession, "id" | "researchSessionId" | "context" | "candidateTurns"> & { turns?: Pick<AgentTurn, "id" | "startedAt" | "completedAt">[] }, commands: ResearchCommandService) {
  const receipts = commands.store.forSession("receipts", session.researchSessionId);
  const reads = receipts.map(r => ({ ...r, actor: { sessionId: r.researchSessionId }, type: r.object.kind === "source" ? "source_excerpt" : "node", refs: [r.object.id], sourceVersion: r.version, range: r.delivered?.textRanges?.[0] }));
  const { candidates } = sessionResearchChanges(session, commands);
  return { sessionId: session.id, researchSessionId: session.researchSessionId,
    selection: session.context ?? {}, reads: reads.slice(-200), omittedReadCount: Math.max(0, reads.length - 200),
    candidates, otherCandidateCount: commands.store.otherPendingCount(session.researchSessionId) };
}
