import { useEffect, useMemo, useState } from "react";
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

export function ExperimentDataWorkspace({
  nodeId,
  en,
}: {
  nodeId: string;
  en: boolean;
}) {
  const [runId, setRunId] = useState("");
  const [metric, setMetric] = useState("");
  const [offset, setOffset] = useState(0);
  const overview = useQuery({
    queryKey: ["experiment-data-overview", projectId(), nodeId],
    queryFn: () =>
      api<Overview>(
        "/api/research-nodes/" + encodeURIComponent(nodeId) + "/experiment",
      ),
  });
  const runs = useMemo(() => overview.data?.runs ?? [], [overview.data?.runs]);
  useEffect(() => {
    if (!runs.length) {
      setRunId("");
      return;
    }
    if (!runs.some((run) => run.id === runId)) setRunId(runs[0].id);
  }, [runs, runId]);
  const metrics = useQuery({
    queryKey: ["experiment-data-metrics", projectId(), nodeId, runId],
    enabled: Boolean(runId),
    queryFn: () =>
      api<any>("/api/research/experiments/read", {
        method: "POST",
        body: JSON.stringify({
          mode: "metrics",
          nodeId,
          runId,
          limit: 100,
          maxChars: 16000,
        }),
      }),
  });
  const metricItems: Metric[] = useMemo(
    () => metrics.data?.data?.items ?? [],
    [metrics.data?.data?.items],
  );
  useEffect(() => {
    if (!metricItems.length) {
      setMetric("");
      return;
    }
    if (!metricItems.some((item) => item.key === metric))
      setMetric(metricItems[0].key);
  }, [metricItems, metric]);
  useEffect(() => setOffset(0), [runId, metric]);
  const selectedMetric = metricItems.find((item) => item.key === metric);
  const series = useQuery({
    queryKey: [
      "experiment-data-series",
      projectId(),
      nodeId,
      runId,
      metric,
      offset,
      selectedMetric?.readHint?.expectedContentVersion,
    ],
    enabled: Boolean(runId && metric),
    queryFn: () =>
      api<any>("/api/research/experiments/read", {
        method: "POST",
        body: JSON.stringify({
          mode: "series",
          nodeId,
          runId,
          metric,
          expectedContentVersion:
            selectedMetric?.readHint?.expectedContentVersion,
          pointOffset: offset,
          pointLimit: 40,
          maxChars: 16000,
        }),
      }),
  });
  const data = series.data?.data;
  const run = runs.find((item) => item.id === runId);
  const copy = () => {
    if (!data) return;
    void navigator.clipboard?.writeText(
      [
        data.xKey + "\t" + data.metric,
        ...data.points.map(
          (point: { x: number; y: number }) => `${point.x}\t${point.y}`,
        ),
      ].join("\n"),
    );
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
      aria-labelledby="experiment-data-heading"
    >
      <header className="experiment-data-heading">
        <div>
          <h2 id="experiment-data-heading">
            {en ? "Experiment data" : "实验数据"}
          </h2>
          <p>
            {en
              ? "Inspect exact source points for one run and metric."
              : "查看单个运行和指标的精确原始数据点。"}
          </p>
        </div>
        {run && <RunStatusDot status={run.status} en={en} />}
      </header>
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
              onChange={setRunId}
              options={runs.map((item) => ({
                value: item.id,
                label: item.label,
              }))}
            />
            {metrics.isPending ? (
              <span className="research-hint">
                {en ? "Loading metrics…" : "正在读取指标…"}
              </span>
            ) : metricItems.length ? (
              <SelectMenu
                ariaLabel={en ? "Data metric" : "数据指标"}
                value={metric}
                onChange={setMetric}
                options={metricItems.map((item) => ({
                  value: item.key,
                  label: item.key,
                }))}
              />
            ) : (
              <span className="research-hint">
                {en
                  ? "No scalar metrics for this run."
                  : "这次运行没有标量指标。"}
              </span>
            )}
          </div>
          {series.isPending && (
            <LoadingSkeleton
              layout="rows"
              label={en ? "Loading source points…" : "正在读取原始数据点…"}
            />
          )}
          {series.error && <p role="alert">{series.error.message}</p>}
          {data && (
            <>
              <div className="experiment-data-meta">
                <span>
                  {data.xKey} · {data.metric}
                </span>
                <span>
                  {data.pointCount} {en ? "points" : "个数据点"}
                </span>
                {data.sampled && (
                  <span className="research-badge">
                    {en ? "Source sampled" : "来源已采样"}
                  </span>
                )}
              </div>
              <div className="research-table-wrap experiment-data-table">
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
                  disabled={!offset || series.isFetching}
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
                  disabled={data.nextOffset === null || series.isFetching}
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
    </section>
  );
}
