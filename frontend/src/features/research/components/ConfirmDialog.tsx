import { useState } from "react";
import type { ReactNode } from "react";
import { ResearchDialog } from "./ResearchUi";

/** A destructive step states its consequence and reports failure in place instead of closing. */
export function ConfirmDialog({ title, children, confirmLabel, en, onConfirm, onClose }: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  en: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return (
    <ResearchDialog title={title} className="research-confirm" onClose={() => { if (!busy) onClose(); }}>
      <div className="research-form">
        {children}
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" className="button" disabled={busy} onClick={onClose}>{en ? "Cancel" : "取消"}</button>
          <button
            type="button"
            className="button danger"
            disabled={busy}
            autoFocus
            onClick={async () => {
              setBusy(true); setError("");
              try { await onConfirm(); }
              catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
              finally { setBusy(false); }
            }}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </ResearchDialog>
  );
}
