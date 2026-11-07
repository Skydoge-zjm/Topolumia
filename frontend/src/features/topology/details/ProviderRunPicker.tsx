import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { normalizeRunStatus } from "@domain/research/experiment-records";
import { RunStatusDot } from "@/features/experiments/RunStatusDot";

const PAGE_SIZE = 50;
const runName = (run: any) =>
  String(run.label ?? run.name ?? run.externalId ?? "");
type ProviderRunsPage = { items: any[]; nextCursor?: string | null };

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
    [search, setSearch] = useState(""),
    [applied, setApplied] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setApplied(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const query = useInfiniteQuery({
    queryKey: ["provider-runs", projectId(), provider],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<ProviderRunsPage>(
        "/api/experiments?provider=" +
          encodeURIComponent(provider) +
          "&limit=" +
          PAGE_SIZE +
          (pageParam ? "&cursor=" + encodeURIComponent(pageParam) : ""),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  // The gateway returns bounded cursor pages; search narrows the pages already loaded here.
  const scoped = items.filter((run) =>
    runName(run).toLowerCase().includes(applied.toLowerCase()),
  );
  const addSelected = () =>
    onSelect(
      items
        .filter((run) => selected.includes(run.ref))
        .map((run) => ({
          sourceId: run.ref.slice((provider + ":run:").length),
          label: runName(run) || run.externalId,
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
        placeholder={en ? "Filter by run name" : "按运行名称筛选"}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <p className="research-hint" role="status">
        {scoped.length} / {items.length}
      </p>
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
            {scoped.map((run) => (
              <tr key={run.ref}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={runName(run) || run.externalId}
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
                  {runName(run) || run.externalId}
                  {run.mode === "fixture" && (
                    <span className="research-badge">
                      {en ? "Sample" : "样例"}
                    </span>
                  )}
                </td>
                <td>
                  <RunStatusDot
                    status={normalizeRunStatus(run.status)}
                    en={en}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {query.data && !scoped.length && (
        <p className="research-empty">
          {en
            ? "No connected runs match this filter."
            : "没有符合筛选的已接入运行。"}
        </p>
      )}
      {query.hasNextPage && (
        <button
          className="button"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {en ? "Load more" : "载入更多"}
        </button>
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
