import { Fragment, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Eye } from "lucide-react";
import { RunStatusDot } from "./RunStatusDot";
import { CHART_COLORS, format, type LedgerMetric } from "./chartModel";
import { runStatusOrder } from "./runPresentation";

export type LedgerRun = {
  /** Identity shared with the charts; see `runKey`. */
  key: string;
  label: string;
  status?: string;
  /** Rows with the same group are listed under one heading (an experiment, when comparing). */
  group?: string;
  /** Linked material items, shown on the row's expander. */
  materialCount?: number;
};
type Sort = { column: string; descending: boolean } | null;

/**
 * The runs of a record, one row each. The ledger is also the charts' legend: its swatch is the
 * line colour, pointing at a row brings that line forward, and the row button shows or hides it.
 */
export function RunLedger({ runs, colors, hidden, onToggle, onOnly, onShowAll, onEmphasis, metrics, en, renderActions, renderDetail }: {
  runs: LedgerRun[];
  colors: Map<string, number>;
  hidden: string[];
  onToggle: (key: string) => void;
  onOnly: (key: string) => void;
  onShowAll: () => void;
  onEmphasis: (key: string | null) => void;
  metrics: LedgerMetric[];
  en: boolean;
  renderActions?: (run: LedgerRun) => ReactNode;
  renderDetail?: (run: LedgerRun) => ReactNode;
}) {
  const [sort, setSort] = useState<Sort>(null), [open, setOpen] = useState<string[]>([]);
  const ordered = useMemo(() => {
    if (!sort) return runs;
    const direction = sort.descending ? -1 : 1, metric = metrics.find((item) => item.key === sort.column);
    const rank = (run: LedgerRun) => sort.column === "status" ? runStatusOrder.indexOf(run.status ?? "unknown") : metric?.values.get(run.key);
    return [...runs].sort((a, b) => {
      if (sort.column === "label") return direction * a.label.localeCompare(b.label, undefined, { numeric: true });
      const left = rank(a), right = rank(b);
      // Runs without a value stay last in either direction.
      if (left === undefined || right === undefined) return left === right ? 0 : left === undefined ? 1 : -1;
      return direction * (left - right);
    });
  }, [runs, sort, metrics]);
  // Sorting reads across experiments, so group headings only apply to the recorded order.
  const grouped = !sort && runs.some((run) => run.group);
  const header = (column: string, label: string, className = "") => {
    const active = sort?.column === column;
    return (
      <th scope="col" className={className} aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}>
        <button type="button" className="run-ledger-sort" title={en ? "Sort by this column" : "按此列排序"} onClick={() => setSort(active ? (sort.descending ? null : { column, descending: true }) : { column, descending: false })}>
          <span>{label}</span>{active && (sort.descending ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />)}
        </button>
      </th>
    );
  };
  const columns = 2 + metrics.length + 1;
  const solo = runs.length > 1 && hidden.length === runs.length - 1;
  return (
    <div className="run-ledger" translate="no">
      <div className="run-ledger-head">
        <span className="run-ledger-count">{runs.length} {en ? "runs" : "次运行"}</span>
        {hidden.length > 0 && <>
          <span className="count">{en ? `${runs.length - hidden.length} shown` : `显示 ${runs.length - hidden.length} 条`}</span>
          <button type="button" className="run-ledger-all" onClick={onShowAll}>{en ? "Show all" : "显示全部"}</button>
        </>}
      </div>
      <div className="run-ledger-scroll">
        <table>
          <thead><tr>
            {header("label", en ? "Run" : "运行")}
            {header("status", en ? "Status" : "状态")}
            {metrics.map((metric) => <Fragment key={metric.key}>{header(metric.key, metric.key, "is-numeric is-metric")}</Fragment>)}
            <th scope="col"><span className="visually-hidden">{en ? "Details and actions" : "详情与操作"}</span></th>
          </tr></thead>
          <tbody>
            {ordered.map((run, index) => {
              const shown = !hidden.includes(run.key), expanded = open.includes(run.key), heading = grouped && run.group !== ordered[index - 1]?.group;
              return (
                <Fragment key={run.key}>
                  {heading && <tr className="run-ledger-group"><th colSpan={columns} scope="colgroup">{run.group}</th></tr>}
                  <tr className={"experiment-run-item" + (shown ? "" : " is-hidden") + (expanded ? " is-open" : "")} onMouseEnter={() => onEmphasis(shown ? run.key : null)} onMouseLeave={() => onEmphasis(null)}>
                    <th scope="row">
                      <button type="button" className="run-ledger-toggle" aria-pressed={shown} title={shown ? (en ? "Hide in charts" : "在图中隐藏") : (en ? "Show in charts" : "在图中显示")} onClick={() => onToggle(run.key)} onFocus={() => onEmphasis(shown ? run.key : null)} onBlur={() => onEmphasis(null)}>
                        <svg className="experiment-run-swatch" width="18" height="10" aria-hidden="true"><path d="M1 5 H17" stroke={CHART_COLORS[colors.get(run.key) ?? 0]} strokeWidth="3" strokeLinecap="round" /></svg>
                        <span>{run.label}</span>
                      </button>
                      {runs.length > 1 && <button type="button" className="run-ledger-only" aria-pressed={solo && shown} aria-label={(en ? "Show only " : "只看 ") + run.label} title={solo && shown ? (en ? "Show all runs" : "显示全部运行") : (en ? "Show only this run" : "只看这条")} onClick={() => onOnly(run.key)}><Eye size={13} /></button>}
                    </th>
                    <td>{run.status ? <RunStatusDot status={run.status} en={en} /> : null}</td>
                    {metrics.map((metric) => { const value = metric.values.get(run.key); return <td key={metric.key} className="is-numeric">{value === undefined ? <span className="run-ledger-none">—</span> : format(value)}</td>; })}
                    <td className="run-ledger-actions">
                      {renderActions?.(run)}
                      {renderDetail && <button type="button" className="run-ledger-expand" aria-expanded={expanded} aria-label={(expanded ? (en ? "Hide details of " : "收起详情：") : (en ? "Details of " : "查看详情：")) + run.label} onClick={() => setOpen((current) => expanded ? current.filter((key) => key !== run.key) : [...current, run.key])}>
                        {run.materialCount ? <span>{en ? "Material" : "材料"} {run.materialCount}</span> : null}
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>}
                    </td>
                  </tr>
                  {expanded && renderDetail && <tr className="run-ledger-detail"><td colSpan={columns}>{renderDetail(run)}</td></tr>}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
