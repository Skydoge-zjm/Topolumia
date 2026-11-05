import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { MetricTable, LinkList } from "@/features/research/components/ResearchUi";
import { text, safeUrl } from "@/features/research/model";
import type { Metric } from "@/features/research/model";
export function ExperimentResults({ id, en }: { id: string; en: boolean }) {
  const query = useQuery({ queryKey: ["node-results", projectId(), id], queryFn: () => api<any>(`/api/research-nodes/${encodeURIComponent(id)}/results`) });
  const [metric, setMetric] = useState("");
  if (query.isPending) return <p role="status">{en ? "Reading experiment results…" : "正在读取实验结果…"}</p>;
  if (query.error) return <p role="alert">{query.error.message}</p>;
  const data = query.data, details: any[] = data.details ?? [], attempts: any[] = data.attempts ?? [];
  const allSeries = details.flatMap(detail => (detail.series?.series ?? detail.run?.series ?? []).map((series: any) => ({ ...series, run: detail.run })));
  const keys = [...new Set<string>(allSeries.map(line => line.key))], selected = keys.includes(metric) ? metric : keys[0];
  const summaryMetrics: Metric[] = Object.entries(data.experiment?.keyMetrics ?? {}).filter(([, value]) => typeof value === "number").map(([name, value]) => ({ name, value: value as number, unit: "", split: "", direction: "none" }));
  return <div className="research-results">
    {(data.warnings ?? []).map((warning: any, index: number) => <p className="research-warning" key={index}>{warning.message}</p>)}
    <section className="research-card"><h2>{en ? "Result metrics" : "结果指标"}</h2><MetricTable metrics={data.authoredMetrics.length ? data.authoredMetrics : summaryMetrics} en={en} /></section>
    {data.experiment && <section className="research-card"><h2>{en ? "Design and limitations" : "设计与局限"}</h2><p>{text(data.experiment.purpose, en)}</p><dl className="research-field-details">{Object.entries(data.experiment.design ?? {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>{(data.experiment.controls ?? []).map((item: any, i: number) => <p key={`c${i}`}>{en ? "Control: " : "控制条件："}{text(item, en)}</p>)}{(data.experiment.limitations ?? []).map((item: any, i: number) => <p className="research-warning" key={`l${i}`}>{text(item, en)}</p>)}</section>}
    <section className="research-card"><h2>{en ? "Runs and attempts" : "运行与尝试"}</h2>{!attempts.length && !details.length && <p className="research-empty">{en ? "No linked runs." : "尚未关联运行。"}</p>}
      {attempts.map((attempt, index) => <div className="research-attempt" key={attempt.id ?? index}><strong>{text(attempt.label, en) || attempt.ref}</strong><span className="research-badge">{attempt.status}</span>{attempt.failure && <p className="research-warning">{text(attempt.failure, en)}</p>}{attempt.params && <dl className="research-inline-facts">{Object.entries(attempt.params).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>}</div>)}
      {details.map((detail, index) => <div className="research-attempt" key={detail.run?.ref ?? index}><header><strong>{detail.run?.label ?? detail.run?.runName ?? detail.run?.ref}</strong><span className="research-badge">{detail.source?.provider ?? detail.run?.provider} · {detail.source?.mode}</span><span>{detail.run?.status}</span></header><small>{detail.source?.observedAt ?? detail.run?.observedAt}</small>
        <MetricTable metrics={Object.entries(detail.run?.metrics ?? {}).filter(([, value]) => typeof value === "number").map(([name, value]) => ({ name, value: value as number, unit: "", split: "", direction: "none" }))} en={en} />
        {(detail.warnings ?? []).map((warning: any, i: number) => <p className="research-warning" key={i}>{warning.message}</p>)}
        <div className="research-artifacts">{(detail.run?.artifacts ?? []).map((artifact: any, i: number) => { const url = safeUrl(artifact.url ?? artifact.href ?? ""); return <p key={i}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{artifact.name ?? artifact.path ?? url} ↗</a> : <span>{artifact.name ?? artifact.path ?? artifact.ref ?? (en ? "Output" : "产出")}</span>}</p>; })}</div>
      </div>)}
    </section>
    <section className="research-card"><header className="research-section-heading"><h2>{en ? "Metric history" : "指标历史"}</h2>{keys.length > 0 && <SelectMenu ariaLabel={en ? "History metric" : "历史曲线指标"} value={selected} onChange={setMetric} options={keys.map(value => ({ value, label: value }))} />}</header>
      {allSeries.filter(line => line.key === selected).map((line, index) => <MetricHistory key={`${line.run?.ref}:${line.key}:${index}`} line={line} en={en} />)}{!allSeries.length && <p className="research-empty">{en ? "No metric history." : "暂无指标历史。"}</p>}
    </section><section className="research-card"><h2>{en ? "Dashboards and outputs" : "图表与产出入口"}</h2><LinkList links={data.links} en={en} /></section>
  </div>;
}
function MetricHistory({ line, en }: { line: any; en: boolean }) {
  const points: { x: number; y: number }[] = (line.points ?? []).filter((point: any) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!points.length) return null;
  const xmin = Math.min(...points.map(point => point.x)), xmax = Math.max(...points.map(point => point.x)), ymin = Math.min(...points.map(point => point.y)), ymax = Math.max(...points.map(point => point.y));
  const polyline = points.map(point => `${40 + (point.x - xmin) / (xmax - xmin || 1) * 700},${170 - (point.y - ymin) / (ymax - ymin || 1) * 140}`).join(" ");
  return <figure className="research-metric-chart"><figcaption>{line.run?.label ?? line.run?.ref} · {line.key}<small>{points.length} {en ? "returned points" : "个返回数据点"}{line.downsampled || line.sampling?.sampled ? (en ? " · sampled" : " · 已采样") : ""}</small></figcaption><svg viewBox="0 0 780 205" role="img" aria-label={`${line.key}: ${ymin}–${ymax}`}><path className="research-chart-axis" d="M40 20 V170 H740" /><polyline points={polyline} fill="none" /><text x="42" y="195">{xmin}</text><text x="700" y="195">{xmax}</text><text x="42" y="17">{ymax.toPrecision(4)}</text><text x="5" y="170">{ymin.toPrecision(3)}</text></svg><details><summary>{en ? "View data points" : "查看曲线数据"}</summary><div className="research-table-wrap"><table className="research-table"><thead><tr><th>{en ? "Step" : "步数"}</th><th>{line.key}</th></tr></thead><tbody>{points.map((point, index) => <tr key={index}><td>{point.x}</td><td>{point.y}</td></tr>)}</tbody></table></div></details></figure>;
}
