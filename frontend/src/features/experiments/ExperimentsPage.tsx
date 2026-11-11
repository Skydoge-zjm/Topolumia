import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChartLine } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import { useResearchPermissions } from "@/features/research/useResearch";
import { nodeUrl } from "@/features/research/model";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { ExperimentCompareDialog } from "./ExperimentCompareDialog";
import type { ExperimentIndex } from "./ExperimentCompareDialog";
import { RunStrip } from "./RunStrip";
import { TrainingRecordsView } from "./TrainingRecordsView";
import "./experiment-records.css";


export function ExperimentsPage() {
  const [params, setParams] = useSearchParams();
  const recordsView = params.get("view") === "records";
  const en = useUiStore((state) => state.locale) === "en",
    permissions = useResearchPermissions();
  const [compare, setCompare] = useState(false),
    [filter, setFilter] = useState("all");
  const experiments = useQuery({
    queryKey: ["research-experiments", projectId()],
    queryFn: () => api<ExperimentIndex>("/api/research-experiments"),
  });
  const items = useMemo(
    () =>
      (experiments.data?.items ?? []).filter((node) => {
        if (filter === "failed") return node.runs.some((run) => run.status === "failed");
        if (filter === "no-runs") return !node.runs.length;
        if (filter === "running") return node.runs.some((run) => ["running", "queued"].includes(run.status));
        return true;
      }),
    [experiments.data?.items, filter],
  );
  return (
    <section translate="no" className="research-workspace">
      <header className="research-page-heading">
        <h1>{en ? "Experiments" : "实验"}</h1>
        <div className="research-actions">
          <button className="button" onClick={() => setCompare(true)}>
            <ChartLine size={15} />
            {en ? "Compare experiments" : "实验对比"}
          </button>
          {permissions.nodes && (
            <Link className="button primary" to="/topology/new?kind=experiment">
              {en ? "New experiment" : "新建实验"}
            </Link>
          )}
        </div>
      </header>
      <nav className="research-tabs"><button className={!recordsView ? "is-active" : ""} onClick={() => setParams({})}>{en ? "Experiments" : "实验"}</button><button className={recordsView ? "is-active" : ""} onClick={() => setParams({ view: "records" })}>{en ? "Training records" : "训练记录"}</button></nav>
      {recordsView ? <TrainingRecordsView en={en} hostId={params.get("hostId") ?? ""} canEdit={permissions.nodes} /> : <>
      <div className="experiment-run-toolbar">
        <SelectMenu
          ariaLabel={en ? "Filter experiments" : "筛选实验"}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: en ? "All experiments" : "全部实验" },
            { value: "failed", label: en ? "With failed runs" : "含失败运行" },
            { value: "running", label: en ? "Running now" : "正在运行" },
            { value: "no-runs", label: en ? "No runs yet" : "尚无运行" },
          ]}
        />
        <span className="research-hint">
          {items.length} / {experiments.data?.items.length ?? 0}
        </span>
      </div>
      {experiments.isPending && <LoadingSkeleton layout="rows" label={en ? "Loading experiments…" : "正在读取实验…"} />}
      {experiments.error && (
        <p role="alert">
          {experiments.error.message}
          <button className="button" onClick={() => void experiments.refetch()}>
            {en ? "Retry" : "重试"}
          </button>
        </p>
      )}
      <div className="research-card">
        {items.map((node) => {
          return (
            <Link className="research-object-row experiment-index-row" key={node.id} to={nodeUrl(node.id)}>
              <span>
                <strong>{node.name}</strong>
                {node.summary && <small>{node.summary}</small>}
              </span>
              <span className="experiment-index-meta">
                {node.runs.length > 0
                  ? <><RunStrip runs={node.runs} en={en} max={16} /><span className="count">{node.runs.length} {en ? "runs" : "次运行"}</span></>
                  : <span className="count">{en ? "No runs yet" : "尚无运行"}</span>}
              </span>
            </Link>
          );
        })}
        {experiments.data && !items.length && (
          <p className="research-empty">
            {filter === "all"
              ? en
                ? "No experiments recorded yet."
                : "尚未创建实验。"
              : en
                ? "No experiments match this filter."
                : "没有符合筛选条件的实验。"}
          </p>
        )}
      </div>
      </>}
      {compare && <ExperimentCompareDialog en={en} onClose={() => setCompare(false)} />}
    </section>
  );
}
