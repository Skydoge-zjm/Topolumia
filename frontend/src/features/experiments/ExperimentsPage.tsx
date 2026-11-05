import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import { useResearchPermissions } from "@/features/research/useResearch";
import { nodeUrl, text } from "@/features/research/model";
import type { ResearchNode } from "@/features/research/model";
export function ExperimentsPage() {
  const en = useUiStore(state => state.locale) === "en", permissions = useResearchPermissions();
  const topology = useQuery({ queryKey: ["topology", projectId()], queryFn: () => api<{ nodes: ResearchNode[] }>("/api/topology") });
  const runs = useQuery({ queryKey: ["experiments", projectId()], queryFn: () => api<{ items: any[] }>("/api/experiments?limit=120") });
  const nodes = topology.data?.nodes.filter(node => node.kind === "experiment") ?? [];
  return <section translate="no" className="research-workspace"><header className="research-page-heading"><div><h1>{en ? "Experiments and review" : "实验与复核"}</h1></div>{permissions.nodes && <Link className="button primary" to="/topology/new?kind=experiment">{en ? "New experiment" : "新建科研实验"}</Link>}</header>
    {(topology.error || runs.error) && <p role="alert">{topology.error?.message ?? runs.error?.message}</p>}
    <section className="research-card"><h2>{en ? "Research experiments" : "科研实验"} · {nodes.length}</h2>{nodes.map(node => <Link className="research-object-row" key={node.id} to={nodeUrl(node.id)}><span><strong>{text(node.label, en)}</strong><small>{text(node.summary, en)}</small></span><span className="research-badge">{node.status}</span></Link>)}{!nodes.length && <p className="research-empty">{en ? "No experiments recorded yet." : "尚未创建科研实验。"}</p>}</section>
    <section className="research-card"><h2>{en ? "Connected provider runs" : "已接入的运行数据"}</h2><div className="research-table-wrap"><table className="research-table"><thead><tr>{(en ? ["Run", "Provider", "Status", "Metrics", "Run reference"] : ["运行", "来源", "状态", "指标", "运行来源引用"]).map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{(runs.data?.items ?? []).map((run: any) => <tr key={run.ref ?? run.id}><td>{run.label ?? run.runName ?? run.name ?? run.id}</td><td>{run.provider ?? run.source}</td><td>{run.status}</td><td>{Object.entries(run.metrics ?? {}).filter(([, value]) => typeof value === "number").slice(0, 4).map(([key, value]) => `${key}: ${value}`).join(" · ") || "—"}</td><td>{run.ref}</td></tr>)}</tbody></table></div>{!runs.data?.items.length && <p className="research-empty">{en ? "No provider runs are available." : "暂无已接入的运行。"}</p>}</section>
  </section>;
}
