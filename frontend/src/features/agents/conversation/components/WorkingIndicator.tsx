import { useEffect, useState } from "react";
import type { AgentEvent, AgentSession } from "@/shared/types/api";
import { workingStatus } from "../model/workingStatus";

/**
 * Live line describing what the agent is doing. It re-reads the event stream on a
 * short clock so long turns move through stages instead of showing one frozen label.
 */
export function WorkingIndicator({
  session,
  events,
  en,
}: {
  session?: AgentSession;
  events: AgentEvent[];
  en: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const running = session?.status === "running" || session?.status === "stopping";
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const status = workingStatus(session, events, en, now);
  if (!status) return null;
  return (
    <span
      className="conversation-current-activity"
      data-activity-phase={status.phase}
      data-activity-tool={String(status.tool)}
      title={status.text}
    >
      <span className="working-dots" aria-hidden="true" data-motion-indicator="true">
        <i />
        <i />
        <i />
      </span>
      <span key={status.phase} className="working-text">
        {status.text}
      </span>
    </span>
  );
}
