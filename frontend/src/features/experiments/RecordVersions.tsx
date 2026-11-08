import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";

export function RecordVersions({ blockId, en, onSelect }: { blockId: string; en: boolean; onSelect: (id: string) => void }) {
  const query = useQuery({ queryKey: ["record-sources", projectId(), blockId], queryFn: ({ signal }) => api<{ snapshots: { id: string; createdAt: string }[] }>("/api/research/record-blocks/" + encodeURIComponent(blockId) + "/status", { signal }) });
  if (query.error) return <p role="alert">{query.error.message}<button className="button" onClick={() => void query.refetch()}>{en ? "Retry versions" : "重新读取版本"}</button></p>;
  if (!query.data?.snapshots?.length) return null;
  return <details className="record-source-section"><summary>{en ? "Saved versions" : "已固定版本"} · {query.data.snapshots.length}</summary>{query.data.snapshots.map(snapshot => <div className="record-source-row" key={snapshot.id}><span>{new Date(snapshot.createdAt).toLocaleString(en ? "en-GB" : "zh-CN")}</span><button className="button" onClick={() => onSelect(snapshot.id)}>{en ? "View data" : "查看数据"}</button></div>)}</details>;
}
