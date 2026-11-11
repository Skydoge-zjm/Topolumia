import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { api, projectId } from "@/shared/lib/api";
import { objectBase } from "@/features/research/model";
import type { ResearchObjectRef } from "@/features/research/model";
import { AXIS_INK, CHART_COLORS, GRID_INK, canvasUsable, format, niceTicks, tickFormat } from "@/features/experiments/chartModel";

type Column = { key: string; label: string };
type Row = Record<string, string | number | boolean | null>;
type TableBlock = { id: string; title: string; type: string; payload?: { columns?: Column[]; rows?: Row[] } };
type ChartPayload = { chartType?: "line" | "bar" | "scatter" | "area"; dataBlockId?: string; config?: { x?: string; y?: string | string[] } };
const MAX_SERIES = 8, MAX_BARS = 60;

const numeric = (value: unknown) => typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;

/** Resolve the configured columns, or fall back to "first column against every numeric column". */
function chartSeries(columns: Column[], rows: Row[], config: ChartPayload["config"]) {
  const find = (name?: string) => columns.find(column => column.key === name || column.label === name);
  const isNumeric = (column: Column) => rows.length > 0 && rows.every(row => row[column.key] === null || row[column.key] === "" || numeric(row[column.key]) !== null) && rows.some(row => numeric(row[column.key]) !== null);
  const x = find(config?.x) ?? columns[0];
  const requested = (Array.isArray(config?.y) ? config.y : config?.y ? [config.y] : []).map(find).filter((column): column is Column => Boolean(column));
  const ys = (requested.length ? requested : columns.filter(column => column !== x && isNumeric(column))).slice(0, MAX_SERIES);
  return { x, ys, numericX: Boolean(x) && isNumeric(x) };
}

/** Draws the table block this chart points at; the table stays the source of the numbers. */
export function ChartBlock({ payload, owner, en }: { payload: ChartPayload; owner: ResearchObjectRef; en: boolean }) {
  const id = payload.dataBlockId ?? "";
  const query = useQuery({
    queryKey: ["research-chart-data", projectId(), owner, id],
    enabled: Boolean(id),
    retry: false,
    queryFn: () => api<TableBlock>(objectBase(owner) + "/content-blocks/" + encodeURIComponent(id)),
  });
  const columns = query.data?.payload?.columns, rows = query.data?.payload?.rows;
  const series = useMemo(() => columns?.length && rows ? chartSeries(columns, rows, payload.config) : null, [columns, rows, payload.config]);
  if (!id) return <p className="research-hint">{en ? "Choose the table block this chart reads from." : "请选择这张图表读取的表格内容块。"}</p>;
  if (query.isPending) return <p role="status" className="research-hint">{en ? "Reading chart data…" : "正在读取图表数据…"}</p>;
  if (query.error) return <p role="alert">{en ? "The table this chart reads from is unavailable: " : "无法读取图表引用的表格："}{query.error.message}</p>;
  if (!series || !rows?.length) return <p className="research-hint">{en ? `“${query.data?.title}” has no inline table rows to plot.` : `“${query.data?.title}”没有可绘制的表格数据。`}</p>;
  if (!series.ys.length) return <p className="research-hint">{en ? "No numeric column to plot." : "表格中没有可绘制的数值列。"}</p>;
  const type = payload.chartType ?? "line";
  return (
    <figure className="chart-block" aria-label={query.data?.title}>
      <ul className="chart-block-legend">{series.ys.map((column, index) => <li key={column.key}><span className="chart-swatch" style={{ background: CHART_COLORS[index] }} />{column.label}</li>)}</ul>
      {type === "bar" || !series.numericX
        ? <BarChart x={series.x} ys={series.ys} rows={rows} en={en} asBars={type === "bar"} />
        : <LineChart x={series.x} ys={series.ys} rows={rows} type={type} en={en} />}
      <figcaption>{en ? "Data: " : "数据："}<button type="button" className="chart-block-source" onClick={() => document.getElementById(id)?.scrollIntoView?.({ block: "start" })}>{query.data?.title}</button><span className="count">{series.x.label}</span></figcaption>
    </figure>
  );
}

function LineChart({ x, ys, rows, type, en }: { x: Column; ys: Column[]; rows: Row[]; type: "line" | "scatter" | "area"; en: boolean }) {
  const host = useRef<HTMLDivElement>(null), [canvas] = useState(canvasUsable);
  const data = useMemo(() => {
    const points = rows.map(row => ({ x: numeric(row[x.key]), values: ys.map(column => numeric(row[column.key])) })).filter((point): point is { x: number; values: (number | null)[] } => point.x !== null).sort((a, b) => a.x - b.x);
    return [points.map(point => point.x), ...ys.map((_, index) => points.map(point => point.values[index]))] as uPlot.AlignedData;
  }, [rows, x, ys]);
  useEffect(() => {
    const element = host.current;
    if (!canvas || !element) return;
    const width = () => Math.max(220, element.clientWidth || 320);
    const axis = { stroke: AXIS_INK, grid: { stroke: GRID_INK, width: 1 }, ticks: { stroke: GRID_INK, width: 1 }, values: (_self: uPlot, splits: number[]) => splits.map(tickFormat) };
    const plot = new uPlot({
      width: width(), height: 280,
      scales: { x: { time: false } },
      legend: { show: false },
      cursor: { drag: { x: true, y: false, setScale: true } },
      axes: [{ ...axis, size: 30, label: x.label, labelSize: 20, labelFont: "12px inherit" }, { ...axis, size: 58 }],
      series: [{}, ...ys.map((column, index) => ({
        label: column.label, stroke: CHART_COLORS[index], width: type === "scatter" ? 0 : 1.8,
        fill: type === "area" ? CHART_COLORS[index] + "22" : undefined,
        paths: type === "scatter" ? () => null : undefined,
        points: { show: type === "scatter" || data[0].length <= 40, size: type === "scatter" ? 6 : 5, fill: CHART_COLORS[index] },
      }))],
    }, data, element);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => plot.setSize({ width: width(), height: 280 }));
    observer?.observe(element);
    return () => { observer?.disconnect(); plot.destroy(); };
  }, [canvas, data, type, x, ys]);
  return <div ref={host} className="chart-block-surface" role="img" aria-label={ys.map(column => column.label).join(en ? ", " : "、")}>
    {!canvas && <p className="research-hint">{en ? "Open the source table to read the values." : "请在来源表格中查看数值。"}</p>}
  </div>;
}

/** Categories on the x axis: grouped bars, or grouped marks when the chart is not a bar chart. */
function BarChart({ x, ys, rows, en, asBars }: { x: Column; ys: Column[]; rows: Row[]; en: boolean; asBars: boolean }) {
  const shown = rows.slice(0, MAX_BARS), values = shown.flatMap(row => ys.map(column => numeric(row[column.key]))).filter((value): value is number => value !== null);
  const low = Math.min(0, ...values), high = Math.max(0, ...values), ticks = niceTicks(low, high === low ? low + 1 : high, 5);
  const min = Math.min(low, ticks[0]), max = Math.max(high, ticks[ticks.length - 1]), span = max - min || 1;
  const width = Math.max(480, shown.length * Math.max(28, ys.length * 14 + 14) + 70), height = 280, left = 58, top = 10, bottom = 44, plotHeight = height - top - bottom, slot = (width - left - 10) / shown.length;
  const y = (value: number) => top + plotHeight - (value - min) / span * plotHeight, bar = Math.min(26, (slot - 8) / ys.length);
  return (
    <div className="chart-block-surface is-scrolling">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={ys.map(column => column.label).join(en ? ", " : "、")}>
        {ticks.map(tick => <g key={tick}><line x1={left} x2={width - 10} y1={y(tick)} y2={y(tick)} stroke={GRID_INK} /><text x={left - 8} y={y(tick)} textAnchor="end" dominantBaseline="central" fill={AXIS_INK} fontSize="12">{tickFormat(tick)}</text></g>)}
        <line x1={left} x2={width - 10} y1={y(0)} y2={y(0)} stroke={AXIS_INK} />
        {shown.map((row, index) => {
          const centre = left + slot * (index + 0.5), label = String(row[x.key] ?? "");
          return <g key={index}>
            {ys.map((column, seriesIndex) => {
              const value = numeric(row[column.key]); if (value === null) return null;
              const offset = centre - bar * ys.length / 2 + bar * seriesIndex;
              return asBars
                ? <rect key={column.key} x={offset + 1} width={Math.max(2, bar - 2)} y={Math.min(y(value), y(0))} height={Math.max(1, Math.abs(y(value) - y(0)))} fill={CHART_COLORS[seriesIndex]}><title>{`${label} · ${column.label}: ${format(value)}`}</title></rect>
                : <circle key={column.key} cx={offset + bar / 2} cy={y(value)} r={4} fill={CHART_COLORS[seriesIndex]}><title>{`${label} · ${column.label}: ${format(value)}`}</title></circle>;
            })}
            <text x={centre} y={height - bottom + 16} textAnchor="middle" fill={AXIS_INK} fontSize="12">{label.length > 12 ? label.slice(0, 11) + "…" : label}<title>{label}</title></text>
          </g>;
        })}
      </svg>
      {rows.length > MAX_BARS && <p className="research-hint">{en ? `First ${MAX_BARS} of ${rows.length} rows shown.` : `仅显示前 ${MAX_BARS} 行，共 ${rows.length} 行。`}</p>}
    </div>
  );
}
