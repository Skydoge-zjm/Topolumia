import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { ExperimentDataWorkspace } from "@/features/experiments/ExperimentDataWorkspace";
import { safeUrl } from "@/features/research/model";
import { paperIdentifierUrl } from "./paperIdentity";

type SourceRef = {
  id?: string;
  kind: string;
  value: string;
  label?: string;
  locator?: {
    page?: string;
    figure?: string;
    table?: string;
    section?: string;
    range?: string;
  };
};

const kindLabels: Record<string, [string, string]> = {
  experimentSnapshot: ["实验快照", "Experiment snapshot"],
  url: ["链接", "Link"],
  doi: ["DOI", "DOI"],
  arxiv: ["arXiv", "arXiv"],
  file: ["文件", "File"],
  page: ["页码", "Page"],
  figure: ["图", "Figure"],
  table: ["表", "Table"],
  section: ["章节", "Section"],
  range: ["范围", "Range"],
};
const locatorLabels: Array<
  [keyof NonNullable<SourceRef["locator"]>, string, string]
> = [
  ["page", "页", "p."],
  ["figure", "图", "Fig."],
  ["table", "表", "Table"],
  ["section", "节", "§"],
  ["range", "范围", "Range"],
];

function locatorText(source: SourceRef, en: boolean) {
  const locator = source.locator ?? {};
  return locatorLabels
    .flatMap(([key, zh, english]) => {
      const value = locator[key];
      if (!value) return [];
      if (key === "range" || key === "section")
        return `${en ? english : zh} ${value}`;
      return `${en ? english : zh}${en ? " " : ""}${value}`;
    })
    .join(en ? ", " : " · ");
}

/** Where a block came from: the original page, figure or table it was transcribed from. */
export function ContentBlockProvenance({
  sourceRefs,
  en,
}: {
  sourceRefs?: SourceRef[];
  en: boolean;
}) {
  const sources = (sourceRefs ?? []).filter((source) => source?.value);
  if (!sources.length) return null;
  return (
    <ul className="content-block-provenance">
      {sources.map((source, index) => {
        const href =
          source.kind === "url"
            ? safeUrl(source.value)
            : source.kind === "doi" || source.kind === "arxiv"
              ? paperIdentifierUrl(source.kind, source.value)
              : null;
        const locator = locatorText(source, en);
        return (
          <li key={source.id ?? index}>
            <span className="content-block-provenance-kind">
              {kindLabels[source.kind]?.[en ? 1 : 0] ?? source.kind}
            </span>
            {source.kind === "experimentSnapshot" ? (
              <SnapshotReference source={source} en={en} />
            ) : href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {source.label || source.value}
              </a>
            ) : (
              <span>{source.label || source.value}</span>
            )}
            {locator && (
              <span className="content-block-provenance-locator">
                {locator}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SnapshotReference({ source, en }: { source: SourceRef; en: boolean }) {
  const [open, setOpen] = useState(false);
  const query = useQuery<{
    data: { snapshot: { nodeId: string; blockId: string; id: string } };
  }>({
    queryKey: ["evidence-snapshot", projectId(), source.value],
    enabled: open,
    queryFn: ({ signal }) =>
      api("/api/research/experiments/read", {
        method: "POST",
        signal,
        body: JSON.stringify({ mode: "snapshot", snapshotId: source.value }),
      }),
  });
  return (
    <>
      <button className="button" onClick={() => setOpen(true)}>
        {source.label || (en ? "View snapshot" : "查看快照")}
      </button>
      {open && (
        <ResearchDialog
          title={source.label || (en ? "Experiment snapshot" : "实验快照")}
          onClose={() => setOpen(false)}
        >
          {query.error ? (
            <p role="alert">{query.error.message}</p>
          ) : query.data ? (
            <ExperimentDataWorkspace
              nodeId={query.data.data.snapshot.nodeId}
              blockId={query.data.data.snapshot.blockId}
              snapshotId={source.value}
              en={en}
            />
          ) : (
            <p role="status">{en ? "Loading snapshot…" : "正在读取快照…"}</p>
          )}
        </ResearchDialog>
      )}
    </>
  );
}
