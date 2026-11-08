import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { RunStatusDot } from "./RunStatusDot";
import { experimentMetricId } from "@domain/research/experiment-records";
import "./experiment-records.css";

type Run = { id: string; label: string; status: string };
type Overview = { runs: Run[] };
type Metric = {
  key: string;
  xKey: string;
  pointCount: number;
  sampled?: boolean;
  readHint?: { expectedContentVersion?: string };
};
type Numeric = number | { dtype: string; value: string };
const exactText = (value: Numeric | null) => value === null ? "" : typeof value === "object" ? value.value : String(value);
type Point = { x: Numeric; y: Numeric };
type DataPage = {
  xKey: string;
  pointCount: number;
  sampled?: boolean;
  nextOffset: number | null;
  points: Point[];
};

export function ExperimentDataWorkspace({
  nodeId,
  blockId,
  snapshotId,
  latestWatermark,
  onLatest,
  en,
}: {
  nodeId: string;
  blockId?: string;
  snapshotId?: string;
  latestWatermark?: number;
  onLatest?: () => void;
  en: boolean;
}) {
  const [runId, setRunId] = useState("");
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [firstRow, setFirstRow] = useState(0);
  const [rowWindow, setRowWindow] = useState(40);
  const scrollHost = useRef<HTMLDivElement>(null);
  // A snapshot is a read mode selected by the caller. Latest mode must stay a
  // live query and must never create or cache a snapshot as its substitute.
  const pinnedId = snapshotId;
  const dataVersion = snapshotId ?? `latest:${latestWatermark ?? 0}`;
  const overview = useQuery({
    queryKey: ["experiment-data-overview", projectId(), nodeId, blockId, dataVersion],
    enabled: true,
    queryFn: async ({ signal }): Promise<Overview> => {
      if (!pinnedId) {
        const path = "/api/research-nodes/" + encodeURIComponent(nodeId) + "/experiment" + (blockId ? "?blockId=" + encodeURIComponent(blockId) : "");
        return api(path, { signal });
      }
      const runs: Run[] = []; let cursor: string | null = null;
      do {
        const page: { data: { items: Run[] }; page: { nextCursor: string | null } } = await api("/api/research/experiments/read", { method: "POST", signal, body: JSON.stringify({ mode: "runs", nodeId, blockId, snapshotId: pinnedId, limit: 100, maxChars: 16000, ...(cursor ? { cursor } : {}) }) });
        runs.push(...page.data.items); cursor = page.page.nextCursor;
      } while (cursor);
      return { runs };
    },
  });
  const runs = useMemo(() => overview.data?.runs ?? [], [overview.data?.runs]);
  useEffect(() => {
    if (!runs.length) return setRunId("");
    if (!runs.some((run) => run.id === runId)) setRunId(runs[0].id);
  }, [runs, runId]);
  const metrics = useQuery({
    queryKey: ["experiment-data-metrics", projectId(), nodeId, blockId, dataVersion, runId],
    enabled: Boolean(runId),
    queryFn: async ({ signal }) => {
      const items: Metric[] = [];
      let cursor: string | null = null;
      do {
        const page: {
          data: { items: Metric[] };
          page?: { nextCursor?: string | null };
        } = await api("/api/research/experiments/read", {
          method: "POST",
          signal,
          body: JSON.stringify({
            mode: "metrics",
            nodeId, blockId, snapshotId: pinnedId,
            runId,
            limit: 100,
            maxChars: 16000,
            ...(cursor ? { cursor } : {}),
          }),
        });
        items.push(...page.data.items);
        cursor = page.page?.nextCursor ?? null;
      } while (cursor);
      return items;
    },
  });
  const metricItems: Metric[] = useMemo(
    () => metrics.data ?? [],
    [metrics.data],
  );
  useEffect(() => {
    const keys = metricItems.map(experimentMetricId);
    setSelectedMetrics((current) => {
      const kept = current.filter((key) => keys.includes(key));
      return kept.length ? kept.slice(0, 24) : keys.slice(0, 12);
    });
  }, [metricItems]);
  useEffect(() => setOffset(0), [runId]);
  useEffect(() => {
    setFirstRow(0);
    if (scrollHost.current) scrollHost.current.scrollTop = 0;
  }, [runId, offset, selectedMetrics]);
  const visibleMetrics = metricItems.filter((item) =>
    selectedMetrics.includes(experimentMetricId(item)),
  );
  const repeatedKeys = useMemo(() => {
    const seen = new Set<string>(), repeated = new Set<string>();
    for (const metric of metricItems) { if (seen.has(metric.key)) repeated.add(metric.key); seen.add(metric.key); }
    return repeated;
  }, [metricItems]);
  const metricLabel = (item: Metric) => repeatedKeys.has(item.key) ? `${item.key} · ${item.xKey}` : item.key;
  const table = useQuery({
    queryKey: [
      "experiment-data-table",
      projectId(),
      nodeId, blockId, dataVersion,
      runId,
      visibleMetrics.map((item) => [
        item.key,
        item.xKey,
        item.readHint?.expectedContentVersion,
      ]),
      offset,
    ],
    enabled: Boolean(runId && visibleMetrics.length),
    queryFn: ({ signal }) =>
      api<{ columns: DataPage[] }>("/api/research/experiments/table", {
        method: "POST",
        signal,
        body: JSON.stringify({
          nodeId, blockId, snapshotId: pinnedId,
          runId,
          metrics: visibleMetrics.map((item) => ({ key: item.key, xKey: item.xKey, expectedContentVersion: item.readHint?.expectedContentVersion })),
          pointOffset: offset,
          pointLimit: 100,
        }),
      }),
  });
  const loadingPoints = table.isPending && visibleMetrics.length > 0;
  const pointData = useMemo(() => table.data?.columns ?? [], [table.data]);
  useEffect(() => {
    const host = scrollHost.current;
    if (!host) return;
    const measure = () =>
      setRowWindow(Math.max(20, Math.ceil(host.clientHeight / 27) + 12));
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(host);
    return () => observer?.disconnect();
  }, [pointData, visibleMetrics.length]);
  const errors = table.error ? [table.error] : [];
  const xKey = pointData[0]?.xKey ?? "step";
  const mixedAxes = new Set(pointData.map((data) => data.xKey)).size > 1;
  const rows = useMemo(() => {
    const aligned = new Map<
      string,
      {
        key: string;
        axis: string;
        x: Numeric;
        occurrence: number;
        values: (Numeric | null)[];
      }
    >();
    pointData.forEach((data, column) => {
      const occurrences = new Map<string, number>();
      for (const point of data.points) {
        const occurrence = occurrences.get(exactText(point.x)) ?? 0;
        occurrences.set(exactText(point.x), occurrence + 1);
        const key = JSON.stringify([data.xKey, point.x, occurrence]);
        const row = aligned.get(key) ?? {
          key,
          axis: data.xKey,
          x: point.x,
          occurrence,
          values: Array<Numeric | null>(pointData.length).fill(null),
        };
        row.values[column] = point.y;
        aligned.set(key, row);
      }
    });
    return [...aligned.values()];
  }, [pointData]);
  const run = runs.find((item) => item.id === runId);
  const pointCount = Math.max(
    0,
    ...pointData.map((data) => data.pointCount ?? 0),
  );
  const sampled = pointData.some((data) => data.sampled);
  const nextOffset = pointData.reduce<number | null>(
    (next, data) => next ?? data.nextOffset ?? null,
    null,
  );
  const copy = () => {
    if (!rows.length) return;
    const lines = [
      [mixedAxes ? "x" : xKey, ...visibleMetrics.map(metricLabel)].join(
        "\t",
      ),
      ...rows.map((row) =>
        [
          mixedAxes ? `${row.axis} ${exactText(row.x)}` : exactText(row.x),
          ...row.values.map((value) => exactText(value)),
        ].join("\t"),
      ),
    ];
    void navigator.clipboard?.writeText(lines.join("\n"));
  };
  if (overview.isPending)
    return (
      <LoadingSkeleton
        layout="rows"
        label={en ? "Loading experiment data…" : "正在读取实验数据…"}
      />
    );
  if (overview.error) return <p role="alert">{overview.error.message}</p>;
  return (
    <section
      className="experiment-data-workspace"
      aria-label={en ? "Experiment data" : "实验数据"}
    >
      {pinnedId && <div className="experiment-run-toolbar"><span className="research-badge">{en ? "Snapshot" : "快照"} · {pinnedId.slice(-12)}</span>{onLatest && <button className="button" onClick={() => onLatest()}>{en ? "Read latest data" : "读取最新数据"}</button>}</div>}
      {!runs.length ? (
        <p className="research-empty">
          {en ? "No runs recorded." : "尚无运行记录。"}
        </p>
      ) : (
        <>
          <div className="experiment-data-toolbar">
            <SelectMenu
              ariaLabel={en ? "Data run" : "数据运行"}
              value={runId}
              onChange={(value) => {
                setRunId(value);
                setOffset(0);
              }}
              options={runs.map((item) => ({
                value: item.id,
                label: item.label,
              }))}
            />
            {run && <RunStatusDot status={run.status} en={en} />}
            <span className="research-hint">
              {pointCount}{" "}
              {en ? "points per metric (max)" : "点 / 指标（最多）"}
            </span>
            <button
              className="button experiment-data-copy"
              disabled={
                !navigator.clipboard ||
                !rows.length ||
                loadingPoints ||
                Boolean(errors.length)
              }
              onClick={copy}
            >
              {en ? "Copy table" : "复制表格"}
            </button>
          </div>
          {metrics.isPending ? (
            <LoadingSkeleton
              layout="rows"
              label={en ? "Loading metrics…" : "正在读取指标…"}
            />
          ) : metrics.error ? (
            <p role="alert">
              {metrics.error.message}
              <button className="button" onClick={() => void metrics.refetch()}>
                {en ? "Retry" : "重试"}
              </button>
            </p>
          ) : metricItems.length ? (
            <div
              className="experiment-data-metric-toggles"
              role="group"
              aria-label={en ? "Data columns" : "数据列"}
            >
              <span className="research-hint">
                {selectedMetrics.length} / {metricItems.length}{" "}
                {en ? "columns · up to 24" : "列 · 最多同时显示 24 列"}
              </span>
              {metricItems.map((item) => {
                const identity = experimentMetricId(item);
                const selected = selectedMetrics.includes(identity);
                return (
                  <button
                    key={identity}
                    type="button"
                    className={
                      "experiment-data-metric-toggle" +
                      (selected ? " is-selected" : "")
                    }
                    disabled={!selected && selectedMetrics.length >= 24}
                    aria-pressed={selected}
                    onClick={() => {
                      setOffset(0);
                      setSelectedMetrics((current) =>
                        selected
                          ? current.filter((key) => key !== identity)
                          : [...current, identity],
                      );
                    }}
                  >
                    {metricLabel(item)}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="research-hint">
              {en
                ? "No scalar metrics for this run."
                : "这次运行没有标量指标。"}
            </p>
          )}
          {errors.length > 0 && <p role="alert">{String(errors[0])}</p>}
          {loadingPoints && (
            <LoadingSkeleton
              layout="rows"
              label={en ? "Loading source points…" : "正在读取原始数据点…"}
            />
          )}
          {visibleMetrics.length > 0 && !loadingPoints && !errors.length && (
            <>
              <div className="experiment-data-meta">
                <span>
                  {rows.length} {en ? "rows" : "行"}
                </span>
                <span>
                  {visibleMetrics.length} {en ? "metrics" : "个指标"}
                </span>
                {sampled && (
                  <span className="research-badge">
                    {en ? "Source sampled" : "来源已采样"}
                  </span>
                )}
              </div>
              <div
                ref={scrollHost}
                className="research-table-wrap experiment-data-table"
                onScroll={(event) =>
                  setFirstRow(
                    Math.max(
                      0,
                      Math.floor(event.currentTarget.scrollTop / 27) - 5,
                    ),
                  )
                }
              >
                <table
                  className="research-table"
                  aria-rowcount={rows.length + 1}
                >
                  <thead>
                    <tr>
                      <th scope="col">{mixedAxes ? "x" : xKey}</th>
                      {visibleMetrics.map((item) => (
                        <th scope="col" key={experimentMetricId(item)}>
                          {metricLabel(item)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {firstRow > 0 && (
                      <tr aria-hidden="true">
                        <td
                          colSpan={visibleMetrics.length + 1}
                          style={{
                            height: firstRow * 27,
                            padding: 0,
                            border: 0,
                          }}
                        />
                      </tr>
                    )}
                    {rows
                      .slice(firstRow, firstRow + rowWindow)
                      .map((row, index) => (
                        <tr key={row.key} aria-rowindex={firstRow + index + 2}>
                          <td>{mixedAxes ? `${row.axis} ${exactText(row.x)}` : exactText(row.x)}</td>
                          {row.values.map((value, index) => (
                            <td key={experimentMetricId(visibleMetrics[index])}>
                              {value === null ? "—" : exactText(value)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    {firstRow + rowWindow < rows.length && (
                      <tr aria-hidden="true">
                        <td
                          colSpan={visibleMetrics.length + 1}
                          style={{
                            height: (rows.length - firstRow - rowWindow) * 27,
                            padding: 0,
                            border: 0,
                          }}
                        />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="research-pagination">
                <button
                  className="button"
                  disabled={!offset || table.isFetching}
                  onClick={() => setOffset(Math.max(0, offset - 100))}
                >
                  {en ? "Previous" : "上一页"}
                </button>
                <span>
                  {Math.floor(offset / 100) + 1} /{" "}
                  {Math.max(1, Math.ceil(pointCount / 100))}
                </span>
                <button
                  className="button"
                  disabled={nextOffset === null || table.isFetching}
                  onClick={() => {
                    if (nextOffset !== null) setOffset(nextOffset);
                  }}
                >
                  {en ? "Next" : "下一页"}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
