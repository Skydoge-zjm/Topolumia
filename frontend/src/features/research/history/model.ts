import type { ResearchNode } from "../model";
export type HistoryActor = { type: "human" | "agent" | "system"; id: string; name: string; sessionId?: string; model?: string; ownerId?: string; workbenchSessionId?: string };
export type HistorySubject = { type: string; id: string; kind: string; label: ResearchNode["label"]; summary: ResearchNode["summary"]; status?: string; version: string };
export type HistoryChange = { action: string; subject: HistorySubject; before?: any; after?: any };
export type HistoryEvent = { id: string; kind: string; category: string; outcome: string; occurredAt: string; actor: HistoryActor; initiatedBy?: HistoryActor; reviewedBy?: HistoryActor;
  reason: string; proposalReason?: string; proposal?: { id: string; revision: number; status: string }; changes: HistoryChange[]; changeCount: number; planned: boolean; causedBy?: string;
  beforeStateVersion?: string; afterStateVersion?: string; related?: HistoryEvent[]; liveObjects?: string[]; sourceRefs?: string[] };
export function subjectUrl(subject: HistorySubject) {
  if (subject.type === "node") return `/topology/nodes/${encodeURIComponent(subject.id)}`;
  if (subject.type === "group") return `/topology/groups/${encodeURIComponent(subject.id)}`;
  if (subject.type === "record") return `/records/${encodeURIComponent(subject.id)}`;
  return null;
}
