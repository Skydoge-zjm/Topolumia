import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChartLine } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import { useResearchPermissions } from "@/features/research/useResearch";
import { nodeUrl } from "@/features/research/model";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { ExperimentCompareDialog } from "./ExperimentCompareDialog";
import type { ExperimentIndex } from "./ExperimentCompareDialog";

export function ExperimentsPage() {
  const en = useUiStore(state => state.locale) === "en", permissions = useResearchPermissions();
  const [compare, setCompare] = useState(false);
  const experiments = useQuery({ queryKey: ["research-experiments", projectId()], queryFn: () => api<ExperimentIndex>("/api/research-experiments") });
  return <section translate="no" className="research-workspace">
    <header className="research-page-heading"><h1>{en ? "Experiments" : "实验"}</h1><div className="research-actions"><button className="button" onClick={() => setCompare(true)}><ChartLine size={15} />{en ? "Compare experiments" : "实验对比"}</button>{permissions.nodes && <Link className="button primary" to="/topology/new?kind=experiment">{en ? "New experiment" : "新建实验"}</Link>}</div></header>
    {experiments.isPending && <LoadingSkeleton layout="rows" label={en ? "Loading experiments…" : "正在读取实验…"} />}
    {experiments.error && <p role="alert">{experiments.error.message}<button className="button" onClick={() => void experiments.refetch()}>{en ? "Retry" : "重试"}</button></p>}
    <div className="research-card">{experiments.data?.items.map(node => <Link className="research-object-row" key={node.id} to={nodeUrl(node.id)}><span><strong>{node.name}</strong>{node.summary && <small>{node.summary}</small>}</span><span className="research-badge">{node.runs.length} {en ? "runs" : "次运行"}</span></Link>)}{experiments.data && !experiments.data.items.length && <p className="research-empty">{en ? "No experiments recorded yet." : "尚未创建实验。"}</p>}</div>
    {compare && <ExperimentCompareDialog en={en} onClose={() => setCompare(false)} />}
  </section>;
}
