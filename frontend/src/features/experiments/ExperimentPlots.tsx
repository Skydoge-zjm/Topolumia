import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import "./experiment-records.css";

export type RecordLine = {
  nodeId: string;
  nodeName: string;
  runId: string;
  runLabel: string;
  key: string;
  xKey: string;
  points: { x: number; y: number }[];
  pointCount: number;
  sampled: boolean;
  contentVersion?: string;
  sources: any[];
};
export type RecordPlot = {
  temporary: true;
  metricKeys: string[];
  omittedMetricCount: number;
  runs: { nodeId: string; nodeName: string; runId: string; runLabel: string }[];
  series: RecordLine[];
  warnings?: { nodeId: string; runId: string; message: string }[];
};
const COLORS = [
  "#087d55",
  "#2563eb",
  "#b45309",
  "#9333ea",
  "#b91c1c",
  "#0f766e",
];
const DASHES = ["", "6 3", "2 3", "9 3 2 3"];
const lineDash = (style: number) =>
  DASHES[(style + Math.floor(style / COLORS.length)) % DASHES.length];
const runKey = (line: { nodeId: string; runId: string }) =>
  JSON.stringify([line.nodeId, line.runId]);
const format = (value: number) =>
  Number.isFinite(value)
    ? new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 }).format(
        value,
      )
    : "—";
const tickFormat = (value: number) => {
  const short = Number(value.toPrecision(3)).toString();
  return short.length > 7 ? value.toExponential(2) : short;
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
  const styles = new Map(plot.runs.map((run, index) => [runKey(run), index]));
  const metrics = [...new Set(plot.series.map((line) => line.key))];
  return (
    <div className="experiment-plots" translate="no">
      {(plot.warnings ?? []).map((warning, index) => (
        <p className="experiment-plot-warning" role="alert" key={index}>
          {
            plot.runs.find(
              (run) =>
                run.nodeId === warning.nodeId && run.runId === warning.runId,
            )?.runLabel
          }
          : {warning.message}
        </p>
      ))}
      {metrics.map((metric) => (
        <MetricChart
          key={metric}
          metric={metric}
          lines={plot.series.filter((line) => line.key === metric)}
          styles={styles}
          en={en}
          blockId={blockId}
          blockRevision={blockRevision}
          candidateId={candidateId}
        />
      ))}
      {!metrics.length && (
        <p className="research-empty">
          {en ? "No metric curves available." : "暂无指标曲线。"}
        </p>
      )}
    </div>
  );
}

function MetricChart({
  metric,
  lines,
  styles,
  en,
  blockId,
  blockRevision,
  candidateId,
}: {
  metric: string;
  lines: RecordLine[];
  styles: Map<string, number>;
  en: boolean;
  blockId?: string;
  blockRevision?: number;
  candidateId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null),
    clipId = useId().replace(/:/g, "");
  const [width, setWidth] = useState(760),
    [hidden, setHidden] = useState<string[]>([]),
    [range, setRange] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<number | null>(null),
    [drag, setDrag] = useState<[number, number] | null>(null),
    [keyboardValue, setKeyboardValue] = useState("");
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(220, entry.contentRect.width)),
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const geometry = useMemo(() => {
    const visible = lines.filter((line) => !hidden.includes(runKey(line))),
      points = visible.flatMap((line) => line.points);
    const allX = points.map((point) => point.x),
      min = allX.length ? Math.min(...allX) : 0,
      max = allX.length ? Math.max(...allX) : 1;
    const xmin = range?.[0] ?? min,
      xmax = range?.[1] ?? (max === min ? min + 1 : max);
    const ys = points
      .filter((point) => point.x >= xmin && point.x <= xmax)
      .map((point) => point.y);
    const low = ys.length ? Math.min(...ys) : 0,
      high = ys.length ? Math.max(...ys) : 1,
      padding = (high - low || Math.abs(high) || 1) * 0.05;
    const ymin = low - padding,
      ymax = high + padding,
      left = Math.max(
        58,
        ...[0, 1, 2, 3, 4].map(
          (tick) =>
            tickFormat(ymin + ((ymax - ymin) * tick) / 4).length * 7 + 12,
        ),
      ),
      right = width - 16,
      top = 16,
      bottom = 220;
    const x = (value: number) =>
      left + ((value - xmin) / (xmax - xmin || 1)) * (right - left);
    const y = (value: number) =>
      bottom - ((value - ymin) / (ymax - ymin || 1)) * (bottom - top);
    const paths = visible.map((line) => {
      let previous = -Infinity;
      const d = line.points
        .map((point, index) => {
          const move = index === 0 || point.x < previous;
          previous = point.x;
          return `${move ? "M" : "L"}${x(point.x).toFixed(2)},${y(point.y).toFixed(2)}`;
        })
        .join(" ");
      return { line, d };
    });
    return {
      visible,
      min,
      max,
      xmin,
      xmax,
      ymin,
      ymax,
      left,
      right,
      top,
      bottom,
      x,
      y,
      paths,
    };
  }, [lines, hidden, range, width]);
  const { xmin, xmax, ymin, ymax, left, right, top, bottom, x, y } = geometry;
  const at = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.max(
      xmin,
      Math.min(
        xmax,
        xmin +
          ((((event.clientX - bounds.left) * width) / (bounds.width || width) -
            left) /
            (right - left)) *
            (xmax - xmin),
      ),
    );
  };
  const nearest = (line: RecordLine, value: number) => {
    const points = line.points;
    if (
      !points.length ||
      value < Math.min(...points.map((point) => point.x)) ||
      value > Math.max(...points.map((point) => point.x))
    )
      return null;
    return points.reduce((best, point) =>
      Math.abs(point.x - value) < Math.abs(best.x - value) ? point : best,
    );
  };
  const zoom = (factor: number) => {
    const center = (xmin + xmax) / 2,
      half = ((xmax - xmin) * factor) / 2;
    const lower = Math.max(geometry.min, center - half),
      upper = Math.min(geometry.max, center + half);
    if (upper > lower) setRange([lower, upper]);
  };
  const multiNode = new Set(lines.map((line) => line.nodeId)).size > 1;
  const label = (line: RecordLine) =>
    (multiNode ? line.nodeName + " · " : "") + line.runLabel;
  const runLines = [
    ...new Map(lines.map((line) => [runKey(line), line])).values(),
  ];
  return (
    <figure className="experiment-metric-chart" aria-label={metric}>
      <figcaption>
        <strong>{metric}</strong>
        <div className="experiment-chart-actions">
          <button
            className="research-icon-button"
            aria-label={en ? "Zoom in" : "放大曲线"}
            onClick={() => zoom(0.5)}
          >
            <ZoomIn size={16} />
          </button>
          <button
            className="research-icon-button"
            aria-label={en ? "Zoom out" : "缩小曲线"}
            onClick={() => zoom(2)}
          >
            <ZoomOut size={16} />
          </button>
          <button
            className="research-icon-button"
            aria-label={en ? "Reset zoom" : "重置缩放"}
            onClick={() => {
              setRange(null);
              setHover(null);
            }}
          >
            <RotateCcw size={16} />
          </button>
        </div>
      </figcaption>
      <div className="experiment-chart-legends">
        {runLines.map((line) => {
          const key = runKey(line),
            style = styles.get(key) ?? 0;
          return (
            <button
              type="button"
              key={key}
              aria-pressed={!hidden.includes(key)}
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
                  stroke={COLORS[style % COLORS.length]}
                  strokeDasharray={lineDash(style)}
                  strokeWidth="2"
                />
              </svg>
              {label(line)}
            </button>
          );
        })}
      </div>
      <div ref={ref} className="experiment-chart-surface">
        <svg
          viewBox={`0 0 ${width} 255`}
          width="100%"
          height="255"
          role="img"
          tabIndex={0}
          aria-label={`${metric} · ${runLines.length} ${en ? "runs" : "次运行"}`}
          onDoubleClick={() => setRange(null)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const value = at(event);
            setDrag([value, value]);
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const value = at(event);
            setHover(value);
            setDrag((current) => (current ? [current[0], value] : null));
          }}
          onPointerUp={() => {
            if (drag && Math.abs(drag[1] - drag[0]) > (xmax - xmin) * 0.01)
              setRange([Math.min(...drag), Math.max(...drag)]);
            setDrag(null);
          }}
          onPointerCancel={() => setDrag(null)}
          onPointerLeave={() => {
            if (!drag) setHover(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setRange(null);
              setHover(null);
              return;
            }
            if (!["ArrowLeft", "ArrowRight", "+", "-"].includes(event.key))
              return;
            event.preventDefault();
            if (event.key === "+" || event.key === "-") {
              zoom(event.key === "+" ? 0.5 : 2);
              return;
            }
            const value = Math.max(
              xmin,
              Math.min(
                xmax,
                (hover ?? xmin) +
                  ((event.key === "ArrowRight" ? 1 : -1) * (xmax - xmin)) / 100,
              ),
            );
            setHover(value);
            setKeyboardValue(
              geometry.visible
                .map((line) => {
                  const point = nearest(line, value);
                  return `${label(line)}: ${point ? format(point.y) + " @ " + format(point.x) : "—"}`;
                })
                .join("; "),
            );
          }}
        >
          <defs>
            <clipPath id={clipId}>
              <rect
                x={left}
                y={top}
                width={right - left}
                height={bottom - top}
              />
            </clipPath>
          </defs>
          {[0, 1, 2, 3, 4].map((tick) => {
            const value = ymin + ((ymax - ymin) * tick) / 4;
            return (
              <g key={tick} className="experiment-chart-grid">
                <path d={`M${left} ${y(value)} H${right}`} />
                <text x={left - 6} y={y(value) + 4} textAnchor="end">
                  {tickFormat(value)}
                </text>
              </g>
            );
          })}
          {[0, 1, 2, 3, 4].map((tick) => {
            const value = xmin + ((xmax - xmin) * tick) / 4;
            return (
              <text
                className="experiment-chart-tick"
                key={tick}
                x={x(value)}
                y={240}
                textAnchor={
                  tick === 0 ? "start" : tick === 4 ? "end" : "middle"
                }
              >
                {tickFormat(value)}
              </text>
            );
          })}
          <g clipPath={`url(#${clipId})`}>
            {geometry.paths.map(({ line, d }, index) => {
              const style = styles.get(runKey(line)) ?? 0;
              return (
                <g key={runKey(line) + ":" + index}>
                  <path
                    d={d}
                    fill="none"
                    stroke={COLORS[style % COLORS.length]}
                    strokeWidth="1.8"
                    strokeDasharray={lineDash(style)}
                    vectorEffect="non-scaling-stroke"
                    aria-label={label(line)}
                  />
                  {line.points.length === 1 && (
                    <circle
                      cx={x(line.points[0].x)}
                      cy={y(line.points[0].y)}
                      r={3}
                      fill={COLORS[style % COLORS.length]}
                      aria-label={label(line) + ": " + format(line.points[0].y)}
                    />
                  )}
                </g>
              );
            })}
            {hover !== null && (
              <path
                className="experiment-chart-cursor"
                d={`M${x(hover)} ${top} V${bottom}`}
              />
            )}
            {drag && (
              <rect
                className="experiment-chart-brush"
                x={x(Math.min(...drag))}
                y={top}
                width={Math.abs(x(drag[1]) - x(drag[0]))}
                height={bottom - top}
              />
            )}
          </g>
        </svg>
        {hover !== null && (
          <div className="experiment-chart-tooltip" aria-hidden="true">
            <b>{format(hover)}</b>
            {geometry.visible.map((line, index) => {
              const point = nearest(line, hover);
              return (
                <span key={runKey(line) + ":" + index}>
                  {label(line)}:{" "}
                  {point
                    ? format(point.y) + ` (${line.xKey} ${format(point.x)})`
                    : "—"}
                </span>
              );
            })}
          </div>
        )}
      </div>
      <div className="experiment-chart-metadata">
        <span>{[...new Set(lines.map((line) => line.xKey))].join(" / ")}</span>
        {lines.some((line) => line.sampled) && (
          <span>{en ? "Sampled display" : "曲线展示已采样"}</span>
        )}
      </div>
      <span className="visually-hidden" aria-live="polite">
        {keyboardValue}
      </span>
      <RawValues
        lines={lines}
        en={en}
        blockId={blockId}
        blockRevision={blockRevision}
        candidateId={candidateId}
      />
    </figure>
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
  const line = lines[Number(selected)] ?? lines[0];
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
            value={selected}
            onChange={(value) => {
              setSelected(value);
              setOffset(0);
            }}
            options={lines.map((item, index) => ({
              value: String(index),
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
                      (point: { x: number; y: number }, index: number) => (
                        <tr key={offset + index}>
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
              </div>
            </>
          )}
        </>
      )}
    </details>
  );
}
