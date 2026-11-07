import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { normalizeRunStatus } from "@domain/research/experiment-records";
import { runStatusLabel } from "@/features/experiments/runPresentation";

export function ProviderRunPicker({
  provider,
  en,
  onSelect,
  onClose,
}: {
  provider: string;
  en: boolean;
  onSelect: (runs: any[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["provider-runs", projectId(), provider],
    queryFn: () =>
      api<{ items: any[] }>(
        "/api/experiments?provider=" +
          encodeURIComponent(provider) +
          "&limit=100",
      ),
  });
  const addSelected = () =>
    onSelect(
      (query.data?.items ?? [])
        .filter((run) => selected.includes(run.ref))
        .map((run) => ({
          sourceId: run.ref.slice((provider + ":run:").length),
          label: String(run.label ?? run.name ?? run.externalId),
          status: normalizeRunStatus(run.status),
          ref: run.ref,
          assetIds: [],
        })),
    );
  return (
    <ResearchDialog
      title={en ? "Select existing runs" : "选择已有运行"}
      onClose={onClose}
    >
      <input
        aria-label={en ? "Search runs" : "搜索运行"}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {query.isPending && (
        <LoadingSkeleton
          layout="rows"
          label={en ? "Loading runs…" : "正在读取运行…"}
        />
      )}
      {query.error && (
        <p role="alert">
          {query.error.message}
          <button className="button" onClick={() => void query.refetch()}>
            {en ? "Retry" : "重试"}
          </button>
        </p>
      )}
      <div className="research-table-wrap">
        <table className="research-table">
          <thead>
            <tr>
              <th>{en ? "Select" : "选择"}</th>
              <th>{en ? "Run" : "运行"}</th>
              <th>{en ? "Status" : "状态"}</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.items
              .filter((run) =>
                String(run.label ?? run.name ?? run.externalId)
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((run) => (
                <tr key={run.ref}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={run.label ?? run.name ?? run.externalId}
                      checked={selected.includes(run.ref)}
                      onChange={() =>
                        setSelected((current) =>
                          current.includes(run.ref)
                            ? current.filter((ref) => ref !== run.ref)
                            : [...current, run.ref],
                        )
                      }
                    />
                  </td>
                  <td>
                    {run.label ?? run.name ?? run.externalId}
                    {run.mode === "fixture" && (
                      <span className="research-badge">
                        {en ? "Sample" : "样例"}
                      </span>
                    )}
                  </td>
                  <td>{runStatusLabel(normalizeRunStatus(run.status), en)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {query.data && !query.data.items.length && (
        <p className="research-empty">
          {en ? "No connected runs." : "暂无已接入运行。"}
        </p>
      )}
      <footer>
        <button className="button" onClick={onClose}>
          {en ? "Cancel" : "取消"}
        </button>
        <button
          className="button primary"
          disabled={!selected.length}
          onClick={addSelected}
        >
          {en ? "Add" : "添加"} ({selected.length})
        </button>
      </footer>
    </ResearchDialog>
  );
}
