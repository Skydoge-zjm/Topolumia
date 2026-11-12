import { runStatusLabel } from "./runPresentation";

const statusClass: Record<string, string> = {
  succeeded: "is-succeeded",
  failed: "is-failed",
  running: "is-running",
  queued: "is-queued",
  cancelled: "is-cancelled",
  unknown: "is-unknown",
};

/**
 * Status is carried by shape and text, not colour alone: the dot adds a ring for
 * in-flight runs and a slash for failures so it stays readable without colour.
 */
export function RunStatusDot({ status, en, withLabel = true }: { status: string; en: boolean; withLabel?: boolean }) {
  return (
    <span className={`run-status ${statusClass[status] ?? "is-unknown"}`}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        {status === "failed" && <path d="M2.5 2.5 L7.5 7.5 M7.5 2.5 L2.5 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
        {status === "succeeded" && <circle cx="5" cy="5" r="3.4" fill="currentColor" />}
        {status === "running" && (
          <>
            <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="5" cy="5" r="1.6" fill="currentColor" />
          </>
        )}
        {["queued", "cancelled", "unknown"].includes(status) && (
          <circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray={status === "cancelled" ? "2 1.6" : undefined} />
        )}
      </svg>
      {withLabel && <span>{runStatusLabel(status, en)}</span>}
    </span>
  );
}
