import { Search } from "lucide-react";
import type { ChartPrefs } from "./chartPrefs";

/** One set of controls for every chart of a record: filter, smoothing, scale and density. */
export function ChartControls({ prefs, onChange, filter, onFilter, metricCount, en }: {
  prefs: ChartPrefs; onChange: (patch: Partial<ChartPrefs>) => void; filter: string; onFilter: (value: string) => void; metricCount: number; en: boolean;
}) {
  return (
    <div className="chart-controls" role="group" aria-label={en ? "Chart display" : "曲线显示"}>
      {metricCount > 4 && <label className="chart-controls-filter">
        <Search size={14} aria-hidden="true" />
        <input type="search" aria-label={en ? "Filter metrics" : "筛选指标"} placeholder={en ? "Filter metrics" : "筛选指标"} value={filter} onChange={(event) => onFilter(event.target.value)} />
      </label>}
      <label className="chart-controls-smoothing">
        <span>{en ? "Smoothing" : "平滑"}</span>
        <input type="range" min={0} max={0.95} step={0.05} value={prefs.smoothing} aria-label={en ? "Smoothing" : "平滑"} onChange={(event) => onChange({ smoothing: Number(event.target.value) })} />
        <output>{prefs.smoothing ? prefs.smoothing.toFixed(2) : en ? "off" : "关"}</output>
      </label>
      <button type="button" className="chart-controls-toggle" aria-pressed={prefs.logScale} onClick={() => onChange({ logScale: !prefs.logScale })}>{en ? "Log scale" : "对数轴"}</button>
      <div className="segmented" role="group" aria-label={en ? "Charts per row" : "每行图表数"}>
        {[0, 1, 2, 3].map((value) => <button key={value} type="button" className={prefs.columns === value ? "is-active" : ""} aria-pressed={prefs.columns === value} onClick={() => onChange({ columns: value })}>{value || (en ? "Auto" : "自动")}</button>)}
      </div>
    </div>
  );
}
