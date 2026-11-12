import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { RunStatusDot } from "./RunStatusDot";

type MlflowCatalog = {
  runs: {
    runId: string;
    label: string;
    status: string;
    experimentName: string;
  }[];
};

export function MlflowImportDialog({
  en,
  onClose,
}: {
  en: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const catalog = useQuery({
    queryKey: ["mlflow-catalog", projectId()],
    queryFn: ({ signal }) =>
      api<MlflowCatalog>("/api/research/experiments/mlflow/catalog", {
        signal,
      }),
    retry: false,
  });
  const runs =
    catalog.data?.runs.filter((run) =>
      `${run.label} ${run.experimentName} ${run.runId}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? [];
  const submit = async () => {
    if (busy || !selected.length) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/research/experiments/mlflow/import", {
        method: "POST",
        body: JSON.stringify({ runIds: selected }),
      });
      await client.invalidateQueries({
        queryKey: ["training-records", projectId()],
      });
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ResearchDialog
      title={en ? "Import from MLflow" : "从 MLflow 导入"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div aria-busy={busy || catalog.isPending}>
        <div className="experiment-run-toolbar">
          <input
            aria-label={en ? "Search MLflow runs" : "搜索 MLflow 运行"}
            placeholder={en ? "Run or experiment name" : "运行或实验名称"}
            value={search}
            disabled={busy}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="button"
            className="button"
            disabled={busy || catalog.isFetching}
            onClick={() => void catalog.refetch()}
          >
            {en ? "Refresh" : "刷新"}
          </button>
          <Link
            className="button"
            to="/tools"
            aria-disabled={busy}
            onClick={(event) => {
              if (busy) event.preventDefault();
              else onClose();
            }}
          >
            {en ? "Tools & environment" : "工具与环境"}
          </Link>
        </div>
        {catalog.isPending && (
          <LoadingSkeleton
            layout="rows"
            label={en ? "Loading MLflow runs…" : "正在读取 MLflow 运行…"}
          />
        )}
        {catalog.error && <p role="alert">{catalog.error.message}</p>}
        {catalog.data && (
          <div className="research-table-wrap">
            <table className="research-table">
              <thead>
                <tr>
                  <th>{en ? "Select" : "选择"}</th>
                  <th>{en ? "Run" : "运行"}</th>
                  <th>{en ? "Experiment" : "实验"}</th>
                  <th>{en ? "Status" : "状态"}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.runId}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={run.label}
                        checked={selected.includes(run.runId)}
                        disabled={
                          busy ||
                          (selected.length >= 100 &&
                            !selected.includes(run.runId))
                        }
                        onChange={() =>
                          setSelected((current) =>
                            current.includes(run.runId)
                              ? current.filter((id) => id !== run.runId)
                              : [...current, run.runId],
                          )
                        }
                      />
                    </td>
                    <td><div>{run.label}</div><small><code>{run.runId}</code></small></td>
                    <td>{run.experimentName}</td>
                    <td>
                      <RunStatusDot en={en} status={run.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!runs.length && (
              <p className="research-empty">
                {en ? "No matching MLflow runs" : "暂无符合条件的 MLflow 运行"}
              </p>
            )}
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        {busy && (
          <p role="status">{en ? "Importing records…" : "正在导入记录…"}</p>
        )}
      </div>
      <footer className="record-source-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={onClose}
        >
          {en ? "Cancel" : "取消"}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || !selected.length}
          onClick={() => void submit()}
        >
          {en ? "Import selected" : "导入所选运行"} ({selected.length})
        </button>
      </footer>
    </ResearchDialog>
  );
}
