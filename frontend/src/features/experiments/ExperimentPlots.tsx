import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import {
  AXIS_INK,
  CHART_COLORS,
  GRID_INK,
  buildData,
  format,
  lineLabel,
  runColor,
  runKey,
  seriesByMetric,
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
}: {
  plot: RecordPlot;
  en: boolean;
}) {
  const groups = useMemo(() => seriesByMetric(plot.series), [plot.series]);
  // One toggle per run, acting on every metric at once: repeating the same three
  // series above each chart only buried the curves.
  const multiNode = useMemo(
    () => new Set(plot.series.map((line) => line.nodeId)).size > 1,
    [plot.series],
  );
  const legendEntries = useMemo(
    () => [
      ...new Map(plot.series.map((line) => [runKey(line), line])).values(),
    ],
    [plot.series],
  );
  const [hidden, setHidden] = useState<string[]>([]);
  const [hoverX, setHoverX] = useState<number | null>(null);
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
          hoverX={hoverX}
          onHoverX={setHoverX}
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
  hoverX,
  onHoverX,
}: {
  metric: string;
  lines: RecordLine[];
  en: boolean;
  hidden: string[];
  hoverX: number | null;
  onHoverX: (value: number | null) => void;
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
              onHoverX(null);
              return;
            }
            const index = self.cursor.idx,
              xValue = self.data[0][index];
            if (typeof xValue === "number") {
              live.current.textContent = `@ ${format(xValue)}`;
              onHoverX(xValue);
            }
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
  }, [canvas, visible, data, label, xAxisLabel, onHoverX]);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    if (hoverX === null || !data[0].length) {
      instance.setCursor({ left: -10, top: -10 });
      return;
    }
    const first = data[0][0] ?? hoverX;
    const last = data[0].at(-1) ?? hoverX;
    const value = Math.max(first, Math.min(last, hoverX));
    instance.setCursor({
      left: instance.valToPos(value, "x"),
      top: instance.bbox.top + instance.bbox.height / 2,
    });
  }, [hoverX, data]);

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
        {!canvas && (
          <p className="experiment-chart-fallback research-hint">
            {en
              ? "Open the Experiment data tab to inspect raw points."
              : "请打开“实验数据”页面查看原始数据点。"}
          </p>
        )}
        {hoverX !== null && visible.length > 0 && (
          <div className="experiment-chart-tooltip" role="status">
            <strong>@ {format(hoverX)}</strong>
            {visible.map((line) => {
              const point = line.points.reduce((best, current) =>
                Math.abs(current.x - hoverX) < Math.abs(best.x - hoverX)
                  ? current
                  : best,
              );
              return (
                <span key={runKey(line)}>
                  {lineLabel(line, multiNode)}: {format(point.y)}
                </span>
              );
            })}
          </div>
        )}
      </div>
      <span ref={live} className="visually-hidden" aria-live="polite" />
      <div className="experiment-chart-metadata">
        {lines.some((line) => line.sampled) && (
          <span className="research-badge">
            {en ? "Sampled display" : "曲线展示已采样"}
          </span>
        )}
      </div>
    </figure>
  );
}
