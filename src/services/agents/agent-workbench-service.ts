import { AppError } from "../../lib/errors.js";
import { versionHash } from "../../lib/hash.js";
import { actorKey } from "../../domain/agents/agent-conversation.js";
import { sessionResearchChanges } from "./agent-research-changes.js";
import type { ResearchCommandService } from "../research/research-command-service.js";
import type { ResearchActor } from "../../domain/research/types.js";
import type { PublicAgentSessionSnapshot, StoredAgentSession, AgentTurn } from "../../domain/agents/agent-types.js";

export function agentResearchContext(session: Pick<StoredAgentSession, "id" | "researchSessionId" | "context" | "candidateTurns"> & { turns?: Pick<AgentTurn, "id" | "startedAt" | "completedAt">[] }, commands: ResearchCommandService) {
  const receipts = commands.store.forSession("receipts", session.researchSessionId);
  const reads = receipts.map(r => ({ ...r, actor: { sessionId: r.researchSessionId }, type: r.object.kind === "source" ? "source_excerpt" : "node", refs: [r.object.id], sourceVersion: r.version, range: r.delivered?.textRanges?.[0] }));
  const { candidates } = sessionResearchChanges(session, commands);
  return { sessionId: session.id, researchSessionId: session.researchSessionId,
    selection: session.context ?? {}, reads: reads.slice(-200), omittedReadCount: Math.max(0, reads.length - 200),
    candidates, otherCandidateCount: commands.store.otherPendingCount(session.researchSessionId) };
}

export function saveAgentMessage(session: PublicAgentSessionSnapshot, commands: ResearchCommandService, actor: ResearchActor, eventIds: unknown) {
  commands.check(actor, "research.proposeChange");
  if (!Array.isArray(eventIds) || !eventIds.length || eventIds.length > 32 || eventIds.some(id => typeof id !== "string")) {
    throw new AppError("AGENT_NOTE_INPUT_INVALID", "请选择一条已完成的回复。", { status: 422 });
  }
  const ids = [...new Set(eventIds)];
  const events = ids.map(id => session.conversationEvents?.find(event => event.id === id));
  const first = events[0];
  if (!first || events.some(event => !event || event.type !== "assistant.message.completed" || event.turnId !== first.turnId || actorKey(event.payload) !== actorKey(first.payload))) {
    throw new AppError("AGENT_NOTE_MESSAGE_UNAVAILABLE", "回复尚未完成或已更新，请刷新后重试。", { status: 409 });
  }
  const markdown = events.map(event => event!.payload.text ?? "").join("");
  if (!markdown.trim() || markdown.length > 100_000) throw new AppError("AGENT_NOTE_SIZE_INVALID", "回复为空或超过记录长度限制。", { status: 422 });
  const fingerprint = versionHash({ session: session.id, ids, markdown });
  const prior = commands.data().candidates.find(candidate => candidate.requestKey === `agent-note:${fingerprint}` && candidate.provenance?.sessionId === session.researchSessionId);
  if (prior) return { ...prior, idempotent: true };
  const label = markdown.split("\n").find(line => line.trim())?.replace(/^#+\s*/, "").slice(0, 90) ?? "科研笔记";
  const candidate = commands.createCandidate({ actor: { ...actor, sessionId: session.researchSessionId },
    reason: `保存会话「${session.title}」的研究回复`, idempotencyKey: `agent-note:${fingerprint}`,
    nodes: [{kind:"note",core:{nodeName:label},blocks:[{title:"正文",type:"richText",role:"body",payload:{format:"markdown",body:markdown}}]}] });
  const linked = { ...candidate, sourceTurnId: first.turnId };
  commands.store.put("candidates", candidate.id, linked);
  return linked;
}
