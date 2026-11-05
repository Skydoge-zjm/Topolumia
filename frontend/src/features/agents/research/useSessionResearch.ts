import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import type { AgentEvent, AgentSession } from "@/shared/types/api";

export type SessionCandidate = Record<string, unknown> & {
  id: string;
  turnId?: string | null;
  status: string;
};
export type SessionResearch = {
  selection?: { nodeIds?: string[]; sourceRefs?: string[] };
  reads?: Array<{
    id: string;
    type: string;
    refs: string[];
    at: string;
    sourceVersion?: string;
    stateVersion?: string;
    range?: { start: number; end: number };
  }>;
  omittedReadCount?: number;
  candidates?: SessionCandidate[];
  otherCandidateCount?: number;
  version?: string;
};

export function useSessionResearch(
  session?: AgentSession,
  events: AgentEvent[] = [],
) {
  const project = projectId(),
    client = useQueryClient();
  const settledCursor =
    events
      .filter((event) =>
        ["turn.completed", "turn.cancelled", "turn.failed"].includes(
          event.type,
        ),
      )
      .at(-1)?.cursor ?? 0;
  const query = useQuery({
    queryKey: ["agent-research-changes", project, session?.id],
    enabled: Boolean(session?.id),
    queryFn: () => {
      const previous = client.getQueryData<SessionResearch>([
        "agent-research-changes",
        project,
        session?.id,
      ]);
      return api<SessionResearch>(
        `/api/agent-sessions/${encodeURIComponent(session!.id)}/research-changes`,
        {
          headers: previous?.version
            ? { "if-none-match": `"${previous.version}"` }
            : {},
        },
        previous,
      );
    },
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      query.state.data?.candidates?.some((candidate) =>
        ["pending", "deferred"].includes(candidate.status),
      )
        ? 30000
        : false,
  });
  useEffect(() => {
    if (session?.id && settledCursor)
      void client.invalidateQueries({
        queryKey: ["agent-research-changes", project, session.id],
      });
  }, [client, project, session?.id, settledCursor]);
  return query;
}
