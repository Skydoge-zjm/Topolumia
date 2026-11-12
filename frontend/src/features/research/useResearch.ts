import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { reviewPermission } from "@domain/research/review-policy";
export function useResearchPermissions() {
  const query = useQuery({ queryKey: ["collaboration-context", projectId()], queryFn: () => api<any>("/api/collaboration/context") });
  const permissions: string[] = query.data?.permissions ?? [];
  const has = (permission: string) => Boolean(query.data?.actor?.serverRole === "server-admin" || permissions.includes("*") || permissions.includes(permission));
  return { actorId: String(query.data?.actor?.id ?? "anonymous"), nodes: has(reviewPermission("accept")), manageEnvironments: has("project.manageSettings"), deleteNodes: has("research.withdrawOrSupersede"), records: has("research.recordProgress"), confirm: has(reviewPermission("reject")), approveHighRisk: has("agent.approveHighRiskTool") };
}
const dirtyEditors = new Set<symbol>();
export function confirmUnsavedChanges() {
  return dirtyEditors.size === 0 || window.confirm("放弃未保存的修改？ / Discard unsaved changes?");
}
const guardUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
const guardLink = (event: MouseEvent) => {
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (anchor && !event.defaultPrevented && !confirmUnsavedChanges()) { event.preventDefault(); event.stopPropagation(); }
};
export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const editor = Symbol();
    if (!dirtyEditors.size) { window.addEventListener("beforeunload", guardUnload); document.addEventListener("click", guardLink, true); }
    dirtyEditors.add(editor);
    return () => { dirtyEditors.delete(editor); if (!dirtyEditors.size) { window.removeEventListener("beforeunload", guardUnload); document.removeEventListener("click", guardLink, true); } };
  }, [dirty]);
}
