import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { ExperimentPlots } from "./ExperimentPlots";
import { RunStatusDot } from "./RunStatusDot";
import { X } from "lucide-react";
import type { RecordPlot } from "./ExperimentPlots";

export type RunSelection = { nodeId: string; runId: string };
export type ExperimentIndex = {
  items: {
    id: string;
    name: string;
    summary: string;
    runs: { id: string; label: string; status: string }[];
  }[];
};
const selectionKey = (value: RunSelection) =>
  JSON.stringify([value.nodeId, value.runId]);

export function ExperimentCompareDialog({
  initial = [],
  en,
  onClose,
}: {
  initial?: RunSelection[];
  en: boolean;
  onClose: () => void;
}) {
  const [selections, setSelections] = useState(initial),
    [metric, setMetric] = useState(""),
    [search, setSearch] = useState("");
  const [picking, setPicking] = useState(initial.length === 0);
  const index = useQuery({
    queryKey: ["research-experiments", projectId()],
    enabled: picking,
    queryFn: () => api<ExperimentIndex>("/api/research-experiments"),
  });
  const plot = useQuery({
    queryKey: ["temporary-experiment-compare", projectId(), selections, metric],
    enabled: selections.length > 0 && !picking,
    queryFn: () =>
      api<RecordPlot>("/api/research/experiments/plot", {
        method: "POST",
        body: JSON.stringify({
          selections,
          ...(metric ? { metricKeys: [metric] } : {}),
        }),
      }),
  });
  const toggle = (value: RunSelection) =>
    setSelections((current) =>
      current.some((item) => selectionKey(item) === selectionKey(value))
        ? current.filter((item) => selectionKey(item) !== selectionKey(value))
        : current.length < 24
          ? [...current, value]
          : current,
    );
  return (
    <ResearchDialog
      title={en ? "Compare experiments" : "实验对比"}
      onClose={onClose}
    >
      <div className="experiment-run-toolbar">
        <button className="button" onClick={() => setPicking(true)}>
          {en ? "Select runs" : "选择运行"} ({selections.length})
        </button>
        {picking && (
          <input
            aria-label={en ? "Find experiments and runs" : "查找实验与运行"}
            placeholder={en ? "Search experiments and runs" : "搜索实验与运行"}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
      </div>
      {selections.length > 0 && (
        <ul className="experiment-compare-chips" aria-label={en ? "Selected runs" : "已选运行"}>
          {selections.map((value) => {
            const node = index.data?.items.find((item) => item.id === value.nodeId);
            const run = node?.runs.find((item) => item.id === value.runId);
            return (
              <li key={selectionKey(value)}>
                <span>
                  {node?.name ?? value.nodeId} · {run?.label ?? value.runId}
                </span>
                <button
                  type="button"
                  className="research-icon-button"
                  aria-label={(en ? "Remove " : "移除 ") + (run?.label ?? value.runId)}
                  onClick={() => toggle(value)}
                >
                  <X size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {selections.length >= 24 && (
        <p className="research-hint" role="status">
          {en ? "24 runs is the comparison limit." : "对比最多同时显示 24 次运行。"}
        </p>
      )}
      {picking && index.isPending && (
        <LoadingSkeleton
          layout="rows"
          label={en ? "Loading experiments…" : "正在读取实验…"}
        />
      )}
      {picking && index.error && (
        <p role="alert">
          {index.error.message}
          <button className="button" onClick={() => void index.refetch()}>
            {en ? "Retry" : "重试"}
          </button>
        </p>
      )}
      {picking && (
        <>
          <div className="experiment-compare-picker">
            <div className="research-table-wrap">
              <table className="research-table">
                <thead>
                  <tr>
                    <th>{en ? "Select" : "选择"}</th>
                    <th>{en ? "Experiment" : "实验"}</th>
                    <th>{en ? "Run" : "运行"}</th>
                  </tr>
                </thead>
                <tbody>
                  {index.data?.items.flatMap((node) =>
                    node.runs
                      .filter((run) =>
                        (node.name + " " + run.label)
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                      )
                      .map((run) => {
                        const value = { nodeId: node.id, runId: run.id },
                          checked = selections.some(
                            (item) =>
                              selectionKey(item) === selectionKey(value),
                          );
                        return (
                          <tr key={selectionKey(value)}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={node.name + " · " + run.label}
                                checked={checked}
                                disabled={!checked && selections.length >= 24}
                                onChange={() => toggle(value)}
                              />
                            </td>
                            <td>{node.name}</td>
                            <td>
                              {run.label}
                              <RunStatusDot status={run.status} en={en} />
                            </td>
                          </tr>
                        );
                      }),
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <button
            className="button primary"
            disabled={!selections.length}
            onClick={() => setPicking(false)}
          >
            {en ? "View comparison" : "查看对比"}
          </button>
        </>
      )}
      {!picking && plot.isPending && selections.length > 0 && (
        <LoadingSkeleton
          layout="cards"
          label={en ? "Loading comparison…" : "正在读取对比…"}
        />
      )}
      {!picking && plot.error && (
        <p role="alert">
          {plot.error.message}
          <button className="button" onClick={() => void plot.refetch()}>
            {en ? "Retry" : "重试"}
          </button>
        </p>
      )}
      {!picking && plot.data && (
        <>
          <div className="experiment-run-toolbar">
            <SelectMenu
              ariaLabel={en ? "Comparison metric" : "对比指标"}
              value={metric}
              onChange={setMetric}
              options={[
                { value: "", label: en ? "Metric overview" : "指标概览" },
                ...plot.data.metricKeys.map((value) => ({
                  value,
                  label: value,
                })),
              ]}
            />
          </div>
          <ExperimentPlots plot={plot.data} en={en} />
        </>
      )}
    </ResearchDialog>
  );
}
