import { useState } from "react";
import { api, ApiClientError } from "@/shared/lib/api";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
export function NodeDeleteDialog({ id, title, nodeRevision, relationCount, groupCount, en, onClose, onDeleted, onReload }: {
  id: string; title: string; nodeRevision: number; relationCount: number; groupCount: number; en: boolean; onClose: () => void; onDeleted: (historyId?: string) => void; onReload: () => Promise<void>;
}) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [stale,setStale] = useState(false);
  return <ResearchDialog title={(en ? "Delete research node: " : "删除科研节点：") + title}  onClose={onClose}><form className="research-form" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError("");
    try { const result = await api<{ historyId?: string }>(`/api/research-nodes/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ expectedNodeRevision: nodeRevision, reason }) }); onDeleted(result.historyId); }
    catch (error) { setError((error as Error).message);setStale(error instanceof ApiClientError && ["NODE_VERSION_CONFLICT","OBJECT_VERSION_CONFLICT"].includes(error.code ?? "")); } finally { setBusy(false); }
  }}><p className="research-warning">{en ? `This removes the node, ${relationCount} connected relations and membership in ${groupCount} groups. The research history retains the prior snapshot. Source files and provider runs remain intact.` : `将移除此节点、${relationCount} 条相连关系，并从 ${groupCount} 个节点组中移出。科研历程保留操作前快照，来源文件和实验运行数据会保留。`}</p>
    <label>{en ? "Deletion reason" : "删除原因"}<textarea required maxLength={2000} rows={3} aria-label={en ? "Deletion reason" : "删除原因"} value={reason} onChange={event => setReason(event.target.value)} /></label>{error && <p role="alert">{error}</p>}<footer><button type="button" className="button" onClick={onClose}>{en ? "Cancel" : "取消"}</button>{stale ? <button type="button" className="button primary" disabled={busy} onClick={async()=>{setBusy(true);try{await onReload();onClose();}catch(error){setError((error as Error).message);}finally{setBusy(false);}}}>{en ? "Reload and review node" : "重新载入并查看节点"}</button> : <button className="button primary" disabled={!reason.trim() || busy}>{busy ? (en ? "Deleting…" : "删除中…") : (en ? "Confirm deletion" : "确认删除")}</button>}</footer>
  </form></ResearchDialog>;
}
