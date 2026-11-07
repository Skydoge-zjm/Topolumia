import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { RunStatusDot } from "./RunStatusDot";
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
type Point = { x: number; y: number };
type DataPage = {
  xKey: string;
  pointCount: number;
  sampled?: boolean;
  nextOffset: number | null;
  points: Point[];
};

export function ExperimentDataWorkspace({
  nodeId,
  en,
}: {
  nodeId: string;
  en: boolean;
}) {
  const [runId, setRunId] = useState("");
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [firstRow, setFirstRow] = useState(0);
  const [rowWindow, setRowWindow] = useState(40);
  const scrollHost = useRef<HTMLDivElement>(null);
  const overview = useQuery({
    queryKey: ["experiment-data-overview", projectId(), nodeId],
    queryFn: ({ signal }) =>
      api<Overview>(
        "/api/research-nodes/" + encodeURIComponent(nodeId) + "/experiment",
        { signal },
      ),
  });
  const runs = useMemo(() => overview.data?.runs ?? [], [overview.data?.runs]);
  useEffect(() => {
    if (!runs.length) return setRunId("");
    if (!runs.some((run) => run.id === runId)) setRunId(runs[0].id);
  }, [runs, runId]);
  const metrics = useQuery({
    queryKey: ["experiment-data-metrics", projectId(), nodeId, runId],
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
            nodeId,
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
    const keys = metricItems.map((item) => item.key);
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
    selectedMetrics.includes(item.key),
  );
  const table = useQuery({
    queryKey: [
      "experiment-data-table",
      projectId(),
      nodeId,
      runId,
      visibleMetrics.map((item) => [
        item.key,
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
          nodeId,
          runId,
          metricKeys: visibleMetrics.map((item) => item.key),
          pointOffset: offset,
          pointLimit: 100,
          expectedVersions: Object.fromEntries(
            visibleMetrics.map((item) => [
              item.key,
              item.readHint?.expectedContentVersion,
            ]),
          ),
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
        x: number;
        occurrence: number;
        values: (number | null)[];
      }
    >();
    pointData.forEach((data, column) => {
      const occurrences = new Map<number, number>();
      for (const point of data.points) {
        const occurrence = occurrences.get(point.x) ?? 0;
        occurrences.set(point.x, occurrence + 1);
        const key = JSON.stringify([data.xKey, point.x, occurrence]);
        const row = aligned.get(key) ?? {
          key,
          axis: data.xKey,
          x: point.x,
          occurrence,
          values: Array<number | null>(pointData.length).fill(null),
        };
        row.values[column] = point.y;
        aligned.set(key, row);
      }
    });
    return [...aligned.values()].sort(
      (a, b) =>
        a.axis.localeCompare(b.axis) ||
        a.x - b.x ||
        a.occurrence - b.occurrence,
    );
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
      [mixedAxes ? "x" : xKey, ...visibleMetrics.map((item) => item.key)].join(
        "\t",
      ),
      ...rows.map((row) =>
        [
          mixedAxes ? `${row.axis} ${row.x}` : row.x,
          ...row.values.map((value) => value ?? ""),
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
                const selected = selectedMetrics.includes(item.key);
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={
                      "experiment-data-metric-toggle" +
                      (selected ? " is-selected" : "")
                    }
                    disabled={!selected && selectedMetrics.length >= 24}
                    aria-pressed={selected}
                    onClick={() =>
                      setSelectedMetrics((current) =>
                        selected
                          ? current.filter((key) => key !== item.key)
                          : [...current, item.key],
                      )
                    }
                  >
                    {item.key}
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
                        <th scope="col" key={item.key}>
                          {item.key}
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
                          <td>{mixedAxes ? `${row.axis} ${row.x}` : row.x}</td>
                          {row.values.map((value, index) => (
                            <td key={visibleMetrics[index].key}>
                              {value ?? "—"}
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
