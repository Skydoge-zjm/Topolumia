import { api } from "@/shared/lib/api";

export async function inspectRecordAssets(
  provider: string,
  representations: any[],
  previousRuns: any[] = [],
) {
  const assetIds = representations
    .filter((rep) => rep.kind === "asset")
    .map((rep) => rep.assetId);
  const runs: any[] = [];
  let cursor: string | null = null;
  do {
    const response: {
      data: { items: any[] };
      page: { nextCursor: string | null };
    } = await api("/api/research/experiments/read", {
      method: "POST",
      body: JSON.stringify({
        mode: "inspect",
        provider,
        assetIds,
        limit: 100,
        maxChars: 16000,
        ...(cursor ? { cursor } : {}),
      }),
    });
    for (const item of response.data.items) {
      const previous = previousRuns.find(
        (run) => run.sourceId === item.sourceId,
      );
      runs.push({
        sourceId: item.sourceId,
        label: previous?.label ?? item.label,
        status: item.status,
        assetIds: item.assetIds,
        ...(previous?.runId ? { runId: previous.runId } : {}),
        ...(previous?.ref ? { ref: previous.ref } : {}),
      });
    }
    cursor = response.page.nextCursor;
  } while (cursor);
  for (const run of previousRuns)
    if (run.ref && !runs.some((item) => item.sourceId === run.sourceId))
      runs.push(run);
  return { provider, runs };
}
