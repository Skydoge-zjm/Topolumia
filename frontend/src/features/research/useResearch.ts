import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { reviewPermission } from "@domain/research/review-policy";
export function useResearchPermissions() {
  const query = useQuery({ queryKey: ["collaboration-context", projectId()], queryFn: () => api<any>("/api/collaboration/context") });
  const permissions: string[] = query.data?.permissions ?? [];
  const has = (permission: string) => Boolean(query.data?.actor?.serverRole === "server-admin" || permissions.includes("*") || permissions.includes(permission));
  return { actorId: String(query.data?.actor?.id ?? "anonymous"), nodes: has(reviewPermission("accept")), deleteNodes: has("research.withdrawOrSupersede"), records: has("research.recordProgress"), confirm: has(reviewPermission("reject")), approveHighRisk: has("agent.approveHighRiskTool") };
}
export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const click = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement).closest("a[href]");
      if (anchor && !window.confirm("放弃未保存的修改？ / Discard unsaved changes?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", click, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", click, true); };
  }, [dirty]);
}
