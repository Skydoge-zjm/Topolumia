import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import {
  useResearchPermissions,
  confirmUnsavedChanges,
} from "@/features/research/useResearch";
import type { ContentBlock } from "@/features/topology/details/ContentBlockRenderer";
import { ExperimentRunsPanel } from "./ExperimentRunsPanel";
import { ExperimentDataWorkspace } from "./ExperimentDataWorkspace";
import { RecordEventsPanel } from "./RecordEventsPanel";
import { RecordVersions } from "./RecordVersions";
import { RecordSelectionActions } from "./RecordSelectionActions";
import "./experiment-records.css";

/** Workbench belongs to one optional content block, never to the node. */
export function ExperimentWorkbench({
  nodeId,
  block,
  en,
  candidateId,
  latestWatermark,
  children,
}: {
  nodeId: string;
  block: ContentBlock;
  en: boolean;
  candidateId?: string;
  latestWatermark?: number;
  children: React.ReactNode;
}) {
  const [snapshotId, setSnapshotId] = useState<string>(),
    [tab, setTab] = useState("curves"),
    [expanded, setExpanded] = useState(false);
  const [freezing, setFreezing] = useState(false), [error, setError] = useState("");
  const permissions = useResearchPermissions(),
    client = useQueryClient();
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const host = navigation.current;
    if (!host) return;
    const reveal = () =>
      host
        .querySelector<HTMLElement>(".is-active")
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    reveal();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    observer?.observe(host);
    return () => observer?.disconnect();
  }, [tab]);
  const materials = useQuery({
    queryKey: ["record-materials", projectId(), nodeId],
    enabled: tab === "runs" && !candidateId,
    queryFn: () =>
      api<{ contentBlocks: ContentBlock[] }>(
        "/api/research-nodes/" + encodeURIComponent(nodeId),
      ),
  });
  const refresh = () => {
    for (const key of [
      "experiment-runs",
      "experiment-record-plot",
      "experiment-data-overview",
      "experiment-data-metrics",
      "experiment-data-table",
      "research-block",
      "research-node",
      "research-experiments",
      "record-materials",
      "record-watermark",
      "record-sources",
      "record-events",
      "research-blocks",
      "training-records",
    ])
      void client.invalidateQueries({ queryKey: [key, projectId()] });
  };
  const tabs = [
    ["curves", en ? "Curves" : "曲线"],
    ...(!candidateId
      ? [
          ["records", en ? "Events & files" : "事件与附件"],
          ["runs", en ? "Runs & materials" : "运行与材料"],
          ["data", en ? "Data table" : "数据表"],
        ]
      : []),
  ];
  const openSnapshot = (id: string) => { setSnapshotId(id); setTab("data"); };
  return (
    <section
      className={"record-block-workbench" + (expanded ? " is-expanded" : "")}
    >
      <div className="experiment-run-toolbar">
        <nav
          ref={navigation}
          className="research-tabs"
          aria-label={en ? "Record workspace" : "记录工作区"}
        >
          {tabs.map(([value, label]) => (
            <button
              key={value}
              className={tab === value ? "is-active" : ""}
              aria-pressed={tab === value}
              onClick={() => {
                if (confirmUnsavedChanges()) setTab(value);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <button
          className="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? en
              ? "Collapse"
              : "收起"
            : en
              ? "Expand workspace"
              : "展开工作区"}
        </button>
      </div>
      {!candidateId && <div className="experiment-run-toolbar">{permissions.nodes && <><RecordSelectionActions nodeId={nodeId} block={block} en={en} onChanged={refresh} /><button className="button" disabled={freezing} title={en ? "Later records will not change this version" : "后续新增数据不会改变此版本"} onClick={async () => { if (freezing) return; setFreezing(true); setError(""); try { const result = await api<{ id: string }>("/api/research/record-blocks/" + encodeURIComponent(block.id) + "/snapshots", { method: "POST", body: "{}" }); refresh(); openSnapshot(result.id); } catch (cause) { setError((cause as Error).message); } finally { setFreezing(false); } }}>{freezing ? en ? "Saving…" : "保存中…" : en ? "Save current version" : "固定当前版本"}</button></>}{error && <p role="alert">{error}</p>}</div>}
      <div hidden={tab !== "curves"}>{children}</div>
      {tab === "data" && (
        <ExperimentDataWorkspace
          key={snapshotId ?? "current"}
          nodeId={nodeId}
          blockId={block.id}
          snapshotId={snapshotId}
          latestWatermark={latestWatermark}
          en={en}
          onLatest={() => setSnapshotId(undefined)}
        />
      )}
      {tab === "runs" && (
        <ExperimentRunsPanel
          nodeId={nodeId}
          blockId={block.id}
          blocks={materials.data?.contentBlocks ?? []}
          en={en}
          canEdit={permissions.nodes}
          onChanged={refresh}
        />
      )}
      {tab === "records" && <RecordEventsPanel blockId={block.id} en={en} />}
      {!candidateId && <RecordVersions blockId={block.id} en={en} onSelect={openSnapshot} />}
    </section>
  );
}
