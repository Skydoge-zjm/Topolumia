import { useState } from "react";
import type { AgentSession } from "@/shared/types/api";
import { api } from "@/shared/lib/api";

export function AgentHistoryStatus({
  session,
  en,
}: {
  session?: AgentSession;
  en: boolean;
}) {
  const [retrying, setRetrying] = useState(false),
    [error, setError] = useState("");
  if (!session || session.historyStatus !== "failed") return null;
  return (
    <div className="agent-history-error" role="alert">
      <span>
        {en ? "Conversation history could not be saved." : "会话历史保存失败。"}{" "}
        {error || session.historyError}
      </span>
      <button
        type="button"
        className="button"
        disabled={retrying}
        onClick={async () => {
          setRetrying(true);
          setError("");
          try {
            await api(
              `/api/agent-sessions/${encodeURIComponent(session.id)}/persist`,
              { method: "POST", body: "{}" },
            );
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setRetrying(false);
          }
        }}
      >
        {retrying
          ? en
            ? "Saving…"
            : "正在保存…"
          : en
            ? "Retry saving"
            : "重试保存"}
      </button>
    </div>
  );
}
