import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, projectId } from "../../../shared/lib/api";
import { mergeAgentSnapshot } from "../conversation/model/agentSession";
import type { AgentProfile, AgentSession } from "@/shared/types/api";

export function useAgentProfiles() {
  return useQuery({
    queryKey: ["agent-profiles", projectId()],
    queryFn: () => api<{ profiles: AgentProfile[] }>("/api/agent-profiles"),
  });
}
export function useAgentSessions() {
  return useQuery({
    queryKey: ["agent-sessions", projectId()],
    queryFn: () =>
      api<{ sessions: AgentSession[] }>("/api/agent-sessions?view=summary"),
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  });
}
export function useAgentDetail(sessionId?: string) {
  const client = useQueryClient();
  const key = ["agent-session", projectId(), sessionId];
  return useQuery({
    queryKey: key,
    enabled: Boolean(sessionId),
    queryFn: async () =>
      mergeAgentSnapshot(
        await api<AgentSession>(
          `/api/agent-sessions/${encodeURIComponent(sessionId!)}`,
        ),
        client.getQueryData<AgentSession>(key),
      ),
  });
}
