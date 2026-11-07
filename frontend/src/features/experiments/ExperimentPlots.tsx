import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { api, projectId } from "@/shared/lib/api";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import {
  AXIS_INK,
  CHART_COLORS,
  DASH_PATTERNS,
  GRID_INK,
  buildData,
  format,
  formatValue,
  lineLabel,
  nearestValue,
  runColor,
  runKey,
  seriesByMetric,
  seriesKey,
  tickFormat,
  type RecordLine,
} from "./chartModel";
import "./experiment-records.css";

export type { RecordLine } from "./chartModel";

export type RecordPlot = {
  temporary: true;
  metricKeys: string[];
  omittedMetricCount: number;
  runs: { nodeId: string; nodeName: string; runId: string; runLabel: string }[];
  series: RecordLine[];
  warnings?: { nodeId: string; runId: string; message: string }[];
};

export function ExperimentPlots({
  plot,
  en,
  blockId,
  blockRevision,
  candidateId,
}: {
  plot: RecordPlot;
  en: boolean;
  blockId?: string;
  blockRevision?: number;
  candidateId?: string;
}) {
  const groups = useMemo(() => seriesByMetric(plot.series), [plot.series]);
  // One toggle per run, acting on every metric at once: repeating the same three
  // series above each chart only buried the curves.
  const multiNode = useMemo(
    () => new Set(plot.series.map((line) => line.nodeId)).size > 1,
    [plot.series],
  );
  const legendEntries = useMemo(
    () => [...new Map(plot.series.map((line) => [runKey(line), line])).values()],
    [plot.series],
  );
  const [hidden, setHidden] = useState<string[]>([]);
  const grouped = new Map<
    string,
    { runId: string; label: string; message: string }[]
  >();
  for (const warning of plot.warnings ?? []) {
    const run = plot.runs.find(
      (item) => item.nodeId === warning.nodeId && item.runId === warning.runId,
    );
    const key = run?.nodeName ?? warning.nodeId;
    grouped.set(key, [
      ...(grouped.get(key) ?? []),
      {
        runId: warning.runId,
        label: run?.runLabel ?? warning.runId,
        message: warning.message,
      },
    ]);
  }
  return (
    <div className="experiment-plots" translate="no">
      {grouped.size > 0 && (
        <details className="experiment-plot-warning" role="alert">
          <summary>
            {en ? "Some records could not be read" : "部分记录未能读取"} (
            {grouped.size})
          </summary>
          <ul>
            {[...grouped].map(([nodeName, items]) => (
              <li key={nodeName}>
                <strong>{nodeName}</strong>
                <ul>
                  {items.map((item) => (
                    <li key={item.runId + item.message}>
                      {item.label}: {item.message}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      )}
      {legendEntries.length > 1 && (
        <div
          className="experiment-plot-legend"
          role="group"
          aria-label={en ? "Runs shown in every chart" : "所有图表显示的运行"}
        >
          {legendEntries.map((line) => {
            const key = runKey(line),
              style = runColor(line.nodeId, line.runId),
              shown = !hidden.includes(key);
            return (
              <button
                type="button"
                key={key}
                aria-pressed={shown}
                className="experiment-chart-legend"
                onClick={() =>
                  setHidden((current) =>
                    current.includes(key)
                      ? current.filter((item) => item !== key)
                      : [...current, key],
                  )
                }
              >
                <svg width="24" height="12" aria-hidden="true">
                  <path
                    d="M0 6 H24"
                    stroke={CHART_COLORS[style]}
                    strokeDasharray={
                      DASH_PATTERNS[style % DASH_PATTERNS.length].join(" ") ||
                      undefined
                    }
                    strokeWidth="2"
                  />
                </svg>
                {lineLabel(line, multiNode)}
              </button>
            );
          })}
        </div>
      )}
      {groups.map(([metric, metricLines]) => (
        <MetricChart
          key={metric}
          metric={metric}
          lines={metricLines}
          en={en}
          hidden={hidden}
          blockId={blockId}
          blockRevision={blockRevision}
          candidateId={candidateId}
        />
      ))}
      {!groups.length && (
        <p className="research-empty">
          {en ? "No metric curves available." : "暂无指标曲线。"}
        </p>
      )}
    </div>
  );
}

/** Never start wider than the host: an unmeasured chart must not stretch its grid column. */
function chartWidth(host: HTMLElement) {
  return Math.max(
    220,
    Math.min(host.clientWidth || 320, host.parentElement?.clientWidth || 320),
  );
}

function canvasUsable() {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof window.HTMLCanvasElement === "undefined"
  )
    return false;
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent))
    return false;
  try {
    return Boolean(document.createElement("canvas").getContext("2d"));
  } catch {
    return false;
  }
}

function MetricChart({
  metric,
  lines,
  en,
  hidden,
  blockId,
  blockRevision,
  candidateId,
}: {
  metric: string;
  lines: RecordLine[];
  en: boolean;
  hidden: string[];
  blockId?: string;
  blockRevision?: number;
  candidateId?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const live = useRef<HTMLSpanElement>(null);
  const chart = useRef<uPlot | null>(null);
  const canvas = canvasUsable();
  const multiNode = useMemo(
    () => new Set(lines.map((line) => line.nodeId)).size > 1,
    [lines],
  );
  const label = useMemo(
    () => (line: RecordLine) => lineLabel(line, multiNode),
    [multiNode],
  );
  const visible = useMemo(
    () => lines.filter((line) => !hidden.includes(runKey(line))),
    [lines, hidden],
  );
  const xKeys = useMemo(
    () => [...new Set(lines.map((line) => line.xKey))],
    [lines],
  );
  const xAxisLabel = xKeys.join(" / ");
  const data = useMemo(() => buildData(visible), [visible]);

  useEffect(() => {
    if (!canvas || !container.current) return;
    const host = container.current;
    const options: uPlot.Options = {
      width: chartWidth(host),
      height: 260,
      cursor: {
        drag: { x: true, y: false, setScale: true },
        focus: { prox: 24 },
      },
      legend: { show: false },
      scales: { x: { time: false } },
      axes: [
        {
          stroke: AXIS_INK,
          grid: { stroke: GRID_INK, width: 1 },
          ticks: { stroke: GRID_INK, width: 1 },
          size: 30,
          values: (_self, splits) => splits.map((value) => tickFormat(value)),
          label: xAxisLabel,
          labelSize: 20,
          labelFont: "12px inherit",
        },
        {
          stroke: AXIS_INK,
          grid: { stroke: GRID_INK, width: 1 },
          ticks: { stroke: GRID_INK, width: 1 },
          size: 58,
          values: (_self, splits) => splits.map((value) => tickFormat(value)),
        },
      ],
      series: [
        {},
        ...visible.map((line) => {
          const style = runColor(line.nodeId, line.runId);
          return {
            label: label(line),
            stroke: CHART_COLORS[style],
            width: 1.8,
            dash: DASH_PATTERNS[style % DASH_PATTERNS.length],
            points: {
              show: line.points.length === 1,
              size: 6,
              fill: CHART_COLORS[style],
            },
          };
        }),
      ],
      hooks: {
        setCursor: [
          (self) => {
            if (!live.current) return;
            if (self.cursor.idx == null) {
              live.current.textContent = "";
              return;
            }
            const index = self.cursor.idx,
              xValue = self.data[0][index];
            const values = visible
              .slice(0, 6)
              .map(
                (line, position) =>
                  `${label(line)}: ${formatValue(nearestValue(self.data[position + 1] as (number | null)[], index))}`,
              );
            live.current.textContent =
              values.join(" · ") +
              (visible.length > 6
                ? ` · ${en ? `+${visible.length - 6} more` : `另 ${visible.length - 6} 条`}`
                : "") +
              ` @ ${format(xValue ?? 0)}`;
          },
        ],
      },
    };
    const instance = new uPlot(options, data as uPlot.AlignedData, host);
    chart.current = instance;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() =>
            instance.setSize({ width: chartWidth(host), height: 260 }),
          );
    observer?.observe(host);
    return () => {
      observer?.disconnect();
      instance.destroy();
      chart.current = null;
    };
    // The x domain and visible series fully describe the chart; rebuilding on any render would reset zoom.
  }, [canvas, visible, data, en, label, xAxisLabel]);

  const zoom = (factor: number) => {
    const instance = chart.current;
    if (!instance) return;
    const { min, max } = instance.scales.x;
    if (min === undefined || max === undefined) return;
    const center = (min + max) / 2,
      half = ((max - min) * factor) / 2;
    const lower = Math.max(data[0][0] ?? min, center - half),
      upper = Math.min(data[0][data[0].length - 1] ?? max, center + half);
    if (upper > lower) instance.setScale("x", { min: lower, max: upper });
  };
  const reset = () => {
    const instance = chart.current;
    const xs = data[0];
    if (!instance || !xs.length) return;
    instance.setScale("x", { min: xs[0]!, max: xs[xs.length - 1]! });
  };

  return (
    <figure
      className="experiment-metric-chart"
      aria-label={metric}
      data-series-count={visible.length}
    >
      <figcaption>
        <div className="experiment-chart-title">
          <strong>{metric}</strong>
          <span>{xKeys.join(" / ")}</span>
        </div>
        <div className="experiment-chart-actions">
          <button
            className="research-icon-button"
            aria-label={en ? "Zoom in" : "放大曲线"}
            onClick={() => zoom(0.5)}
            disabled={!canvas}
          >
            <ZoomIn size={16} />
          </button>
          <button
            className="research-icon-button"
            aria-label={en ? "Zoom out" : "缩小曲线"}
            onClick={() => zoom(2)}
            disabled={!canvas}
          >
            <ZoomOut size={16} />
          </button>
          <button
            className="research-icon-button"
            aria-label={en ? "Reset zoom" : "重置缩放"}
            onClick={reset}
            disabled={!canvas}
          >
            <RotateCcw size={16} />
          </button>
        </div>
      </figcaption>
      <div
        ref={container}
        className="experiment-chart-surface"
        role="img"
        tabIndex={0}
        aria-label={`${metric} · ${visible.length} ${en ? "runs" : "次运行"}`}
        onDoubleClick={reset}
      >
        {!canvas && <FallbackTable lines={visible} xs={data[0]} en={en} />}
      </div>
      <span ref={live} className="visually-hidden" aria-live="polite" />
      <div className="experiment-chart-metadata">
        <RawValues
          lines={lines}
          en={en}
          blockId={blockId}
          blockRevision={blockRevision}
          candidateId={candidateId}
        />
        {lines.some((line) => line.sampled) && (
          <span className="research-badge">
            {en ? "Sampled display" : "曲线展示已采样"}
          </span>
        )}
      </div>
    </figure>
  );
}

function FallbackTable({
  lines,
  xs,
  en,
}: {
  lines: RecordLine[];
  xs: (number | null)[];
  en: boolean;
}) {
  const columns = lines.map((line) => {
    const points = new Map(line.points.map((point) => [point.x, point.y]));
    return xs.map((x) => (x === null ? null : (points.get(x) ?? null)));
  });
  return (
    <div className="experiment-chart-fallback">
      <p role="status">
        {en
          ? "Charts need a canvas; showing the first data points."
          : "当前环境无画布，显示前若干数据点。"}
      </p>
      <div className="research-table-wrap">
        <table className="research-table">
          <thead>
            <tr>
              <th>{lines[0]?.xKey ?? "x"}</th>
              {lines.map((line) => (
                <th key={seriesKey(line)}>
                  {line.nodeName} · {line.runLabel}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {xs.slice(0, 12).map((x, index) => (
              <tr key={String(x)}>
                <td>{format(x ?? 0)}</td>
                {columns.map((column, position) => (
                  <td key={position}>
                    {column[index] === null ? "—" : format(column[index]!)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RawValues({
  lines,
  en,
  blockId,
  blockRevision,
  candidateId,
}: {
  lines: RecordLine[];
  en: boolean;
  blockId?: string;
  blockRevision?: number;
  candidateId?: string;
}) {
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState("0"),
    [offset, setOffset] = useState(0);
  const index = Math.min(Number(selected), Math.max(0, lines.length - 1));
  const line = lines[index] ?? lines[0];
  const query = useQuery({
    queryKey: [
      "experiment-values",
      projectId(),
      line.nodeId,
      line.runId,
      line.key,
      blockId,
      blockRevision,
      candidateId,
      offset,
      line.sources,
    ],
    enabled: open,
    queryFn: () =>
      api<any>("/api/research/experiments/read", {
        method: "POST",
        body: JSON.stringify({
          mode: "series",
          nodeId: line.nodeId,
          runId: line.runId,
          metric: line.key,
          blockId,
          blockRevision,
          candidateId,
          expectedContentVersion: line.contentVersion,
          pointOffset: offset,
          pointLimit: 40,
          maxChars: 16000,
        }),
      }),
  });
  const data = query.data?.data;
  const copy = () => {
    if (!data) return;
    const text = [
      data.xKey + "\t" + data.metric,
      ...data.points.map(
        (point: { x: number; y: number }) => `${point.x}\t${point.y}`,
      ),
    ].join("\n");
    void navigator.clipboard?.writeText(text);
  };
  return (
    <details
      className="experiment-raw-values"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{en ? "Data points" : "数据点"}</summary>
      {open && (
        <>
          <SelectMenu
            ariaLabel={en ? "Data run" : "数据运行"}
            value={String(index)}
            onChange={(value) => {
              setSelected(value);
              setOffset(0);
            }}
            options={lines.map((item, position) => ({
              value: String(position),
              label: item.nodeName + " · " + item.runLabel,
            }))}
          />
          {query.isPending && (
            <p role="status">{en ? "Loading…" : "读取中…"}</p>
          )}
          {query.error && <p role="alert">{query.error.message}</p>}
          {data && (
            <>
              <div className="research-table-wrap">
                <table className="research-table">
                  <thead>
                    <tr>
                      <th>{data.xKey}</th>
                      <th>{data.metric}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.points.map(
                      (point: { x: number; y: number }, pointIndex: number) => (
                        <tr key={offset + pointIndex}>
                          <td>{point.x}</td>
                          <td>{point.y}</td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
              <div className="research-pagination">
                <button
                  className="button"
                  disabled={!offset || query.isFetching}
                  onClick={() => setOffset(Math.max(0, offset - 40))}
                >
                  {en ? "Previous" : "上一页"}
                </button>
                <span>
                  {data.offset + 1}–{data.offset + data.points.length} /{" "}
                  {data.pointCount}
                </span>
                <button
                  className="button"
                  disabled={data.nextOffset === null || query.isFetching}
                  onClick={() => setOffset(data.nextOffset)}
                >
                  {en ? "Next" : "下一页"}
                </button>
                <button
                  className="button"
                  disabled={!navigator.clipboard}
                  onClick={copy}
                >
                  {en ? "Copy" : "复制"}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </details>
  );
}
