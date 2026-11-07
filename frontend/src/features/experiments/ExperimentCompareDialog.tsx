import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { ExperimentPlots } from "./ExperimentPlots";
import type { RecordPlot } from "./ExperimentPlots";

export type ExperimentIndex = {
  items: {
    id: string;
    name: string;
    summary: string;
    runs: { id: string; label: string; status: string }[];
  }[];
};

export function ExperimentCompareDialog({
  nodeIds,
  en,
  onClose,
}: {
  nodeIds?: string[];
  en: boolean;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(() => [...new Set(nodeIds ?? [])]);
  const [picking, setPicking] = useState(!nodeIds?.length);
  const [metric, setMetric] = useState("");
  const [search, setSearch] = useState("");
  const index = useQuery({
    queryKey: ["research-experiments", projectId()],
    queryFn: ({ signal }) =>
      api<ExperimentIndex>("/api/research-experiments", { signal }),
  });
  const selectedItems = useMemo(
    () => index.data?.items.filter((item) => selected.includes(item.id)) ?? [],
    [index.data?.items, selected],
  );
  const runCount = selectedItems.reduce(
    (count, item) => count + item.runs.length,
    0,
  );
  const plot = useQuery({
    queryKey: ["temporary-experiment-compare", projectId(), selected, metric],
    enabled: selected.length >= 2 && !picking,
    queryFn: ({ signal }) =>
      api<RecordPlot>("/api/research/experiments/plot", {
        method: "POST",
        signal,
        body: JSON.stringify({
          nodeIds: selected,
          ...(metric ? { metricKeys: [metric] } : {}),
        }),
      }),
  });
  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  return (
    <ResearchDialog
      title={en ? "Compare experiments" : "实验对比"}
      onClose={onClose}
    >
      <div className="experiment-run-toolbar experiment-compare-toolbar">
        <button
          className="button"
          onClick={() => setPicking((value) => !value)}
        >
          {en ? "Select experiments" : "选择实验"} ({selected.length})
        </button>
        {index.data && (
          <span className="research-hint">
            {runCount} {en ? "runs" : "次运行"}
          </span>
        )}
        {picking && (
          <input
            aria-label={en ? "Find experiments" : "查找实验"}
            placeholder={en ? "Search experiments" : "搜索实验"}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
      </div>
      {selectedItems.length > 0 && (
        <ul
          className="experiment-compare-chips"
          aria-label={en ? "Selected experiments" : "已选实验"}
        >
          {selectedItems.map((item) => (
            <li key={item.id}>
              <span>
                {item.name} · {item.runs.length} {en ? "runs" : "次运行"}
              </span>
              <button
                type="button"
                className="research-icon-button"
                aria-label={(en ? "Remove " : "移除 ") + item.name}
                onClick={() => toggle(item.id)}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {index.isPending && (
        <LoadingSkeleton
          layout="rows"
          label={en ? "Loading experiments…" : "正在读取实验…"}
        />
      )}
      {index.error && (
        <p role="alert">
          {index.error.message}
          <button className="button" onClick={() => void index.refetch()}>
            {en ? "Retry" : "重试"}
          </button>
        </p>
      )}
      {picking && index.data && (
        <>
          <div className="experiment-compare-picker research-table-wrap">
            <table className="research-table">
              <thead>
                <tr>
                  <th>{en ? "Select" : "选择"}</th>
                  <th>{en ? "Experiment" : "实验"}</th>
                  <th>{en ? "Runs" : "运行"}</th>
                </tr>
              </thead>
              <tbody>
                {index.data.items
                  .filter((item) =>
                    item.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((item) => (
                    <tr key={item.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={item.name}
                          checked={selected.includes(item.id)}
                          onChange={() => toggle(item.id)}
                        />
                      </td>
                      <td>{item.name}</td>
                      <td>{item.runs.length}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <button
            className="button primary"
            disabled={selected.length < 2}
            onClick={() => setPicking(false)}
          >
            {en ? "View comparison" : "查看对比"}
          </button>
        </>
      )}
      {!picking && selected.length < 2 && (
        <p className="research-empty">
          {en ? "Select at least two experiments." : "请选择至少两个实验。"}
        </p>
      )}
      {!picking && selected.length >= 2 && plot.isPending && (
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
      {!picking && selected.length >= 2 && plot.data && (
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
