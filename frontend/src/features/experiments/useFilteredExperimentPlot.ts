import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/shared/lib/api";
import type { RecordPlot } from "./ExperimentPlots";

const METRIC_LIMIT = 32;

/** Keep the complete metric directory available while reading curves outside the initial overview. */
export function useFilteredExperimentPlot({ queryKey, readScope = queryKey, input, enabled, filter, retainWhileUpdating = false }: {
  queryKey: readonly unknown[];
  /** Watermark changes may reuse a reading; object, revision and snapshot changes may not. */
  readScope?: readonly unknown[];
  input: Record<string, unknown>;
  enabled: boolean;
  filter: string;
  retainWhileUpdating?: boolean;
}) {
  const scope = JSON.stringify(readScope);
  const overview = useQuery<RecordPlot>({
    gcTime: 0,
    queryKey: [...queryKey, "overview"],
    enabled,
    meta: { plotReadScope: scope },
    placeholderData: retainWhileUpdating
      ? (previous, previousQuery) => previousQuery?.meta?.plotReadScope === scope ? previous : undefined
      : undefined,
    queryFn: ({ signal }) => api("/api/research/experiments/plot", { method: "POST", signal, body: JSON.stringify(input) }),
  });
  const needle = filter.trim().toLowerCase();
  const matching = useMemo(() => (overview.data?.metricKeys ?? []).filter(key => key.toLowerCase().includes(needle)), [overview.data?.metricKeys, needle]);
  const requested = matching.slice(0, METRIC_LIMIT);
  const loaded = new Set(overview.data?.series.map(line => line.key));
  const needsRead = Boolean(needle) && requested.some(key => !loaded.has(key));
  const filteredScope = JSON.stringify([readScope, requested]);
  const filtered = useQuery<RecordPlot>({
    gcTime: 0,
    queryKey: [...queryKey, "filtered", requested],
    enabled: enabled && needsRead,
    meta: { plotReadScope: filteredScope },
    placeholderData: retainWhileUpdating
      ? (previous, previousQuery) => previousQuery?.meta?.plotReadScope === filteredScope ? previous : undefined
      : undefined,
    queryFn: ({ signal }) => api("/api/research/experiments/plot", { method: "POST", signal, body: JSON.stringify({ ...input, metricKeys: requested }) }),
  });
  const plot = needsRead ? filtered : overview;
  const visibleMetrics = new Set(plot.data?.series.filter(line => line.key.toLowerCase().includes(needle)).map(line => line.key));
  return {
    plot,
    metricKeys: overview.data?.metricKeys ?? [],
    omittedMetricCount: needle ? Math.max(0, matching.length - visibleMetrics.size) : plot.data?.omittedMetricCount ?? 0,
  };
}
