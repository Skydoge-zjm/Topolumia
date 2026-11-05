import { projectId } from "@/shared/lib/api";

export function attachmentImageUrl(sessionId: string, id: string) {
  return `/api/agent-sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId())}`;
}
