import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import type { ResearchObjectRef } from "@/features/research/model";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { ExperimentPlots } from "@/features/experiments/ExperimentPlots";
import type { RecordPlot } from "@/features/experiments/ExperimentPlots";
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
  const [metric, setMetric] = useState("");
  const selections = (block.payload?.runs ?? [])
    .filter((run: any) => run.runId)
    .map((run: any) => ({ nodeId: owner.id, runId: run.runId }));
  const query = useQuery({
    queryKey: [
      "experiment-record-plot",
      projectId(),
      owner.id,
      block.id,
      block.revision,
      candidateId,
      block.payload,
      metric,
    ],
    enabled: selections.length > 0,
    queryFn: () =>
      api<RecordPlot>("/api/research/experiments/plot", {
        method: "POST",
        body: JSON.stringify({
          selections,
          blockId: block.id,
          blockRevision: block.revision,
          candidateId,
          ...(metric ? { metricKeys: [metric] } : {}),
        }),
      }),
  });
  if (!selections.length)
    return (
      <p className="research-empty">
        {en ? "No linked run records." : "尚无关联的运行记录。"}
      </p>
    );
  if (query.isPending)
    return (
      <LoadingSkeleton
        layout="cards"
        label={en ? "Loading training curves…" : "正在读取训练曲线…"}
      />
    );
  return (
    <div className="experiment-records-panel">
      {query.error && (
        <p role="alert">
          {query.error.message}
          <button className="button" onClick={() => void query.refetch()}>
            {en ? "Retry" : "重试"}
          </button>
        </p>
      )}
      {query.data && (
        <>
          <div className="experiment-run-toolbar">
            <span className="research-badge">
              {block.payload.provider === "wandb"
                ? "W&B"
                : block.payload.provider === "tensorboard"
                  ? "TensorBoard"
                  : "MLflow"}
            </span>
            <span>
              {query.data.runs.length} {en ? "runs" : "次运行"}
            </span>
            <SelectMenu
              ariaLabel={en ? "Curve metric" : "曲线指标"}
              value={metric}
              onChange={setMetric}
              options={[
                { value: "", label: en ? "Metric overview" : "指标概览" },
                ...query.data.metricKeys.map((value) => ({
                  value,
                  label: value,
                })),
              ]}
            />
          </div>
          <ExperimentPlots
            plot={query.data}
            en={en}
            blockId={block.id}
            blockRevision={block.revision}
            candidateId={candidateId}
          />
        </>
      )}
    </div>
  );
}
