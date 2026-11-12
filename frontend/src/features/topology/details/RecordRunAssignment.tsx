import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { SelectMenu } from "@/shared/ui/SelectMenu";

export function RecordRunAssignment({
  experimentId,
  blockId,
  runId,
  en,
  onChange,
}: {
  experimentId: string;
  blockId: string;
  runId?: string;
  en: boolean;
  onChange: (runId?: string) => void;
}) {
  const query = useQuery({
    queryKey: ["experiment-runs", projectId(), experimentId, blockId],
    queryFn: () =>
      api<{ runs: { id: string; label: string; firstWatermark?: number }[] }>(
        "/api/research-nodes/" +
          encodeURIComponent(experimentId) +
          "/experiment?blockId=" + encodeURIComponent(blockId),
      ),
  });
  if (query.error)
    return (
      <span role="alert">
        {query.error.message}
        <button
          type="button"
          className="button"
          onClick={() => void query.refetch()}
        >
          {en ? "Retry" : "重试"}
        </button>
      </span>
    );
  return (
    <SelectMenu
      ariaLabel={en ? "Execution identity" : "执行身份"}
      value={runId ?? ""}
      onChange={(value) => onChange(value || undefined)}
      disabled={query.isPending}
      options={[
        { value: "", label: en ? "Identify by source" : "按来源识别" },
        ...(query.data?.runs ?? []).filter(run => run.firstWatermark === undefined).map((run) => ({
          value: run.id,
          label: run.label,
        })),
      ]}
    />
  );
}
