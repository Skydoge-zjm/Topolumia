import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import {
  AXIS_INK,
  CHART_COLORS,
  GRID_INK,
  buildFacetedData,
  format,
  lineLabel,
  nearestPoint,
  pointIndex,
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
  const hoverFrame = useRef<number | null>(null);
  const pendingHover = useRef<number | null>(null);
  const onHoverX = useCallback((value: number | null) => {
    pendingHover.current = value;
    if (typeof requestAnimationFrame !== "function") {
      setHoverX(value);
      return;
    }
    if (hoverFrame.current !== null) return;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = null;
      setHoverX(pendingHover.current);
    });
  }, []);
  useEffect(
    () => () => {
      if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
    },
    [],
  );
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
          onHoverX={onHoverX}
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
  const [canvas] = useState(canvasUsable);
  const [inView, setInView] = useState(
    typeof IntersectionObserver === "undefined",
  );
  const savedRange = useRef<{ min: number; max: number } | null>(null);
  useEffect(() => {
    if (!container.current || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { rootMargin: "400px" },
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const multiNode = useMemo(
    () => new Set(lines.map((line) => line.nodeId)).size > 1,
    [lines],
  );
  const label = useMemo(
    () => { const mixed = new Set(lines.map(line => line.xKey)).size > 1; return (line: RecordLine) => lineLabel(line, multiNode) + (mixed ? ` · ${line.xKey}` : ""); },
    [multiNode, lines],
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
  const data = useMemo(() => buildFacetedData(visible), [visible]);
  const hoverIndices = useMemo(
    () => data.map(([xs, ys]) => pointIndex(xs, ys)),
    [data],
  );
  const domain = useMemo(() => {
    let min = Infinity,
      max = -Infinity;
    for (const line of visible)
      for (const point of line.points) {
        min = Math.min(min, point.x);
        max = Math.max(max, point.x);
      }
    return Number.isFinite(min) ? [min, max === min ? min + 1 : max] : [0, 1];
  }, [visible]);

  useEffect(() => {
    if (!canvas || !inView || !container.current) return;
    const host = container.current;
    const options: uPlot.Options = {
      mode: 2,
      width: chartWidth(host),
      height: 260,
      cursor: {
        drag: { x: true, y: false, setScale: true },
        focus: { prox: 24 },
        dataIdx: (self, index) => {
          const x = self.posToVal(self.cursor.left ?? 0, "x");
          return hoverIndices[index]?.(x) ?? null;
        },
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
            facets: [
              { scale: "x", sorted: 0 },
              { scale: "y", sorted: 0 },
            ],
            paths: uPlot.paths.linear!(),
            points: {
              show: line.points.length === 1,
              size: 6,
              fill: CHART_COLORS[style],
            },
          };
        }),
      ],
      hooks: {
        setScale: [
          (self) => {
            const { min, max } = self.scales.x;
            if (min !== undefined && max !== undefined)
              host.dataset.xRange = `${min}:${max}`;
          },
        ],
        setCursor: [
          (self) => {
            if (!live.current) return;
            if ((self.cursor.left ?? -1) < 0) {
              live.current.textContent = "";
              onHoverX(null);
              return;
            }
            const xValue = self.posToVal(self.cursor.left ?? 0, "x");
            if (typeof xValue === "number") {
              live.current.textContent = `@ ${format(xValue)}`;
              onHoverX(xValue);
            }
          },
        ],
      },
    };
    const instance = new uPlot(
      options,
      data as unknown as uPlot.AlignedData,
      host,
    );
    chart.current = instance;
    const initialMin = instance.scales.x.min,
      initialMax = instance.scales.x.max;
    if (initialMin !== undefined && initialMax !== undefined)
      host.dataset.xRange = `${initialMin}:${initialMax}`;
    if (savedRange.current) instance.setScale("x", savedRange.current);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() =>
            instance.setSize({ width: chartWidth(host), height: 260 }),
          );
    observer?.observe(host);
    return () => {
      observer?.disconnect();
      const { min, max } = instance.scales.x;
      if (min !== undefined && max !== undefined)
        savedRange.current = { min, max };
      instance.destroy();
      chart.current = null;
    };
    // The x domain and visible series fully describe the chart; rebuilding on any render would reset zoom.
  }, [
    canvas,
    inView,
    visible,
    data,
    label,
    xAxisLabel,
    onHoverX,
    hoverIndices,
  ]);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    if (hoverX === null || !visible.length) {
      instance.setCursor({ left: -10, top: -10 }, false);
      return;
    }
    let anchor: ReturnType<typeof nearestPoint> = null;
    for (const line of visible) {
      anchor = nearestPoint(line.points, hoverX);
      if (anchor) break;
    }
    instance.setCursor(
      {
        left: instance.valToPos(hoverX, "x"),
        top: anchor ? instance.valToPos(anchor.y, "y") : 0,
      },
      false,
    );
  }, [hoverX, visible, data, inView]);

  const zoom = (factor: number) => {
    const instance = chart.current;
    if (!instance) return;
    const { min, max } = instance.scales.x;
    if (min === undefined || max === undefined) return;
    const center = (min + max) / 2,
      half = ((max - min) * factor) / 2;
    const lower = Math.max(domain[0], center - half),
      upper = Math.min(domain[1], center + half);
    if (upper > lower) instance.setScale("x", { min: lower, max: upper });
  };
  const reset = () => {
    const instance = chart.current;
    if (!instance || !visible.length) return;
    instance.setScale("x", { min: domain[0], max: domain[1] });
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
        {inView && hoverX !== null && visible.length > 0 && (
          <div className="experiment-chart-tooltip" role="status">
            <strong>@ {format(hoverX)}</strong>
            {visible.slice(0, 12).map((line) => {
              const point = nearestPoint(line.points, hoverX);
              return point ? (
                <span key={JSON.stringify([runKey(line), line.xKey])}>
                  {label(line)}: {format(point.y)}
                </span>
              ) : null;
            })}
            {visible.length > 12 && (
              <span>
                {en
                  ? `${visible.length - 12} more runs`
                  : `另 ${visible.length - 12} 次运行`}
              </span>
            )}
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
