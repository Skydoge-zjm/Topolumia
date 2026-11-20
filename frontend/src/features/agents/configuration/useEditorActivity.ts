import { useEffect } from "react";
import { useUnsavedChanges } from "@/features/research/useResearch";

export function useEditorActivity(
  dirty: boolean,
  busy: boolean,
  onActivity: (state: { dirty: boolean; busy: boolean }) => void,
) {
  useUnsavedChanges(dirty);
  useEffect(() => onActivity({ dirty, busy }), [dirty, busy, onActivity]);
  useEffect(
    () => () => onActivity({ dirty: false, busy: false }),
    [onActivity],
  );
}
