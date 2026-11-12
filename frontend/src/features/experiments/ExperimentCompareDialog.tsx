import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { ExperimentPlots } from "./ExperimentPlots";
import { useFilteredExperimentPlot } from "./useFilteredExperimentPlot";
import { ChartControls } from "./ChartControls";
import { useChartPrefs } from "./chartPrefs";
import { RunLedger, type LedgerRun } from "./RunLedger";
import { RunStrip } from "./RunStrip";
import { assignRunColors, latestValues, runKey } from "./chartModel";

export type ExperimentIndex = {
  items: {
    id: string;
    name: string;
    summary: string;
    runs: { id: string; label: string; status: string; blockId?: string }[];
  }[];
};

/** A temporary reading across experiments: nothing here is saved as a research object. */
export function ExperimentCompareDialog({ nodeIds, en, onClose }: { nodeIds?: string[]; en: boolean; onClose: () => void }) {
  const [selected, setSelected] = useState(() => [...new Set(nodeIds ?? [])]);
  const [picking, setPicking] = useState(!nodeIds?.length), [search, setSearch] = useState(""), [filter, setFilter] = useState("");
  const [hidden, setHidden] = useState<string[]>([]), [emphasis, setEmphasis] = useState<string | null>(null);
  const [prefs, setPrefs] = useChartPrefs();
  const index = useQuery({ queryKey: ["research-experiments", projectId()], queryFn: ({ signal }) => api<ExperimentIndex>("/api/research-experiments", { signal }) });
  const selectedItems = useMemo(() => index.data?.items.filter((item) => selected.includes(item.id)) ?? [], [index.data?.items, selected]);
  const { plot, metricKeys, omittedMetricCount } = useFilteredExperimentPlot({
    queryKey: ["temporary-experiment-compare", projectId(), selected],
    enabled: selected.length >= 2 && !picking,
    input: { nodeIds: selected },
    filter,
  });
  const toggleExperiment = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const series = plot.data?.series;
  // Rows follow the plotted series so the ledger, its colours and the curves describe the same runs.
  const runs: LedgerRun[] = useMemo(() => {
    const status = new Map(selectedItems.flatMap((item) => item.runs.map((run) => [runKey({ nodeId: item.id, blockId: run.blockId, runId: run.id }), run.status] as const)));
    return [...new Map((series ?? []).map((line) => [runKey(line), { key: runKey(line), label: line.runLabel, group: line.nodeName, status: status.get(runKey(line)) }])).values()];
  }, [series, selectedItems]);
  const colors = useMemo(() => assignRunColors(series ?? []), [series]);
  const metrics = useMemo(() => latestValues(series ?? [], 6, filter), [series, filter]);
  const toggle = (key: string) => setHidden((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  const only = (key: string) => setHidden((current) => { const others = runs.map((run) => run.key).filter((item) => item !== key); return current.length === others.length && !current.includes(key) ? [] : others; });
  const withoutRecords = selectedItems.filter((item) => !item.runs.length);
  const shownItems = (index.data?.items ?? []).filter((item) => item.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <ResearchDialog title={en ? "Compare experiments" : "实验对比"} className="experiment-compare" onClose={onClose}>
      <div className="experiment-compare-toolbar">
        <ul className="experiment-compare-chips" aria-label={en ? "Selected experiments" : "已选实验"}>
          {selectedItems.map((item) => (
            <li key={item.id}>
              <span>{item.name}</span><span className="count">{item.runs.length} {en ? "runs" : "次运行"}</span>
              <button type="button" aria-label={(en ? "Remove " : "移除 ") + item.name} onClick={() => toggleExperiment(item.id)}><X size={13} /></button>
            </li>
          ))}
        </ul>
        <button className="button" aria-expanded={picking} onClick={() => setPicking((value) => !value)}>{en ? "Select experiments" : "选择实验"} ({selected.length})</button>
      </div>
      {index.isPending && <LoadingSkeleton layout="rows" label={en ? "Loading experiments…" : "正在读取实验…"} />}
      {index.error && <p role="alert">{index.error.message}<button className="button" onClick={() => void index.refetch()}>{en ? "Retry" : "重试"}</button></p>}
      {picking && index.data && <div className="experiment-compare-picker">
        <label className="chart-controls-filter"><Search size={14} aria-hidden="true" /><input type="search" aria-label={en ? "Find experiments" : "查找实验"} placeholder={en ? "Search experiments" : "搜索实验"} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <ul className="experiment-compare-list">
          {shownItems.map((item) => (
            <li key={item.id}><label>
              <input type="checkbox" aria-label={item.name} checked={selected.includes(item.id)} onChange={() => toggleExperiment(item.id)} />
              <span className="experiment-compare-name">{item.name}</span>
              {item.runs.length ? <><RunStrip runs={item.runs} en={en} max={16} /><span className="count">{item.runs.length} {en ? "runs" : "次运行"}</span></> : <span className="count">{en ? "No run records" : "没有运行记录"}</span>}
            </label></li>
          ))}
          {!shownItems.length && <li className="research-hint">{en ? "No experiment matches." : "没有匹配的实验。"}</li>}
        </ul>
        <footer><button className="button primary" disabled={selected.length < 2} onClick={() => setPicking(false)}>{en ? "View comparison" : "查看对比"}</button></footer>
      </div>}
      {!picking && selected.length < 2 && <p className="research-empty">{en ? "Select at least two experiments." : "请选择至少两个实验。"}</p>}
      {!picking && selected.length >= 2 && plot.isPending && <LoadingSkeleton layout="cards" label={en ? "Loading comparison…" : "正在读取对比…"} />}
      {!picking && plot.error && <p role="alert">{plot.error.message}<button className="button" onClick={() => void plot.refetch()}>{en ? "Retry" : "重试"}</button></p>}
      {!picking && selected.length >= 2 && (plot.data || metricKeys.length > 0) && <>
        {withoutRecords.length > 0 && <p className="research-hint">{(en ? "No run records to compare in: " : "以下实验没有可比较的运行记录：") + withoutRecords.map((item) => item.name).join(en ? ", " : "、")}</p>}
        {runs.length > 0 && <RunLedger runs={runs} colors={colors} hidden={hidden} metrics={metrics} en={en} onToggle={toggle} onOnly={only} onShowAll={() => setHidden([])} onEmphasis={setEmphasis} />}
        <div className="record-view-bar"><ChartControls prefs={prefs} onChange={setPrefs} filter={filter} onFilter={setFilter} metricCount={metricKeys.length} en={en} /></div>
        {plot.data && <ExperimentPlots plot={plot.data} en={en} colors={colors} hidden={hidden} onToggle={toggle} emphasis={emphasis} showLegend={false} smoothing={prefs.smoothing} logScale={prefs.logScale} columns={prefs.columns} filter={filter} />}
        {plot.data && omittedMetricCount > 0 && <p className="research-hint">{en ? `${omittedMetricCount} more metrics are available through the metric filter.` : `另有 ${omittedMetricCount} 项指标，可筛选查看。`}</p>}
      </>}
    </ResearchDialog>
  );
}
