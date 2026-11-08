import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import type { ResearchObjectRef } from "@/features/research/model";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import {
  ExperimentPlots,
  type RecordPlot,
} from "@/features/experiments/ExperimentPlots";
import { ExperimentWorkbench } from "@/features/experiments/ExperimentWorkbench";
import type { ContentBlock } from "./ContentBlockRenderer";

export function ExperimentRecordBlock({
  block,
  owner,
  en,
  candidateId,
}: {
  block: ContentBlock;
  owner: ResearchObjectRef;
  en: boolean;
  candidateId?: string;
}) {
  const [following, setFollowing] = useState(true),
    [inView, setInView] = useState(typeof IntersectionObserver === "undefined");
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { rootMargin: "400px" },
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const status = useQuery<{
    durableWatermark: number;
    updatedAt: string | null;
  }>({
    queryKey: ["record-watermark", projectId(), block.id],
    enabled: !candidateId && inView,
    queryFn: ({ signal }) =>
      api(
        "/api/research/record-blocks/" +
          encodeURIComponent(block.id) +
          "/version",
        { signal },
      ),
    refetchInterval: following && inView ? 2000 : false,
    refetchIntervalInBackground: false,
  });
  const overview = useQuery<{ runs: { id: string }[] }>({
    gcTime: 0,
    queryKey: [
      "experiment-runs",
      projectId(),
      owner.id,
      block.id,
      status.data?.durableWatermark,
    ],
    placeholderData: (previous) => previous,
    enabled: !candidateId && inView,
    queryFn: ({ signal }) =>
      api(
        "/api/research-nodes/" +
          encodeURIComponent(owner.id) +
          "/experiment?blockId=" +
          encodeURIComponent(block.id),
        { signal },
      ),
  });
  const runs = candidateId
    ? (block.payload?.runs?.map((run: any) => ({ id: run.runId })) ?? [])
    : (overview.data?.runs ?? []);
  const selections: { nodeId: string; blockId: string; runId: string }[] = [
    ...new Map<string, { nodeId: string; blockId: string; runId: string }>(
      runs
        .filter((run: any) => run.id)
        .map((run: any) => [
          run.id,
          { nodeId: owner.id, blockId: block.id, runId: run.id },
        ]),
    ).values(),
  ];
  const query = useQuery<RecordPlot>({
    gcTime: 0,
    queryKey: [
      "experiment-record-plot",
      projectId(),
      owner.id,
      block.id,
      block.revision,
      candidateId,
      selections,
      status.data?.durableWatermark,
    ],
    enabled: selections.length > 0,
    placeholderData: (previous) => previous,
    queryFn: ({ signal }) =>
      api<RecordPlot>("/api/research/experiments/plot", {
        method: "POST",
        signal,
        body: JSON.stringify({
          nodeId: owner.id,
          blockId: block.id,
          blockRevision: block.revision,
          candidateId,
        }),
      }),
  });
  return (
    <div ref={host}>
      <ExperimentWorkbench
        nodeId={owner.id}
        block={block}
        en={en}
        candidateId={candidateId}
        latestWatermark={status.data?.durableWatermark}
      >
        <div className="experiment-record-head">
          <span className="experiment-record-meta">
            {runs.length} {en ? "runs" : "次运行"}
            {status.data?.updatedAt && (
              <> · {new Date(status.data.updatedAt).toLocaleTimeString()}</>
            )}
          </span>
          {!candidateId && (
            <button
              className="button"
              aria-pressed={following}
              onClick={() => setFollowing((value) => !value)}
            >
              {following
                ? en
                  ? "Pause updates"
                  : "暂停更新"
                : en
                  ? "Return to latest"
                  : "回到最新"}
            </button>
          )}
        </div>
        {(query.error || overview.error || status.error) && (
          <p role="alert">
            {query.error?.message ??
              overview.error?.message ??
              status.error?.message}
            <button
              className="button"
              onClick={() => {
                void status.refetch();
                void overview.refetch();
                void query.refetch();
              }}
            >
              {en ? "Retry" : "重试"}
            </button>
          </p>
        )}
        {!candidateId && overview.isPending ? (
          <LoadingSkeleton
            layout="cards"
            label={en ? "Loading records…" : "正在读取实验记录…"}
          />
        ) : !selections.length ? (
          <p className="research-empty">
            {en ? "Waiting for records" : "等待实验记录"}
          </p>
        ) : query.isPending ? (
          <LoadingSkeleton
            layout="cards"
            label={en ? "Loading curves…" : "正在读取曲线…"}
          />
        ) : (
          query.data && <ExperimentPlots plot={query.data} en={en} />
        )}
      </ExperimentWorkbench>
    </div>
  );
}
