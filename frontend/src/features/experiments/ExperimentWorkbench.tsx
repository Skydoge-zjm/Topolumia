import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Maximize2, Minimize2, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { useResearchPermissions, confirmUnsavedChanges } from "@/features/research/useResearch";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import type { ContentBlock } from "@/features/topology/details/ContentBlockRenderer";
import { ExperimentDataWorkspace } from "./ExperimentDataWorkspace";
import { ExperimentPlots, type RecordPlot } from "./ExperimentPlots";
import { RecordEventsPanel } from "./RecordEventsPanel";
import { RecordActionsMenu } from "./RecordSelectionActions";
import { ChartControls } from "./ChartControls";
import { useChartPrefs } from "./chartPrefs";
import { RunLedger, type LedgerRun } from "./RunLedger";
import { MaterialEditor, MaterialVersionViewer, RemoveRunDialog, RunEditor, type ExperimentMaterialLinkView, type ExperimentOverview, type ExperimentRunOverview } from "./RunDialogs";
import { assignRunColors, latestValues, runKey } from "./chartModel";
import { providerLabel } from "./runPresentation";
import "./experiment-records.css";

type Snapshot = { id: string; createdAt: string };
type PinnedRun = { id: string; label: string; status: string };
const INVALIDATED = ["experiment-runs", "experiment-record-plot", "experiment-data-overview", "experiment-data-metrics", "experiment-data-table", "research-block", "research-node", "research-experiments", "record-materials", "record-watermark", "record-sources", "record-events", "research-blocks", "training-records"];

/**
 * One record block's workspace: the run ledger, the curves it controls, exact data and raw events.
 * It belongs to the block, never to the node, so two record blocks on a page stay independent.
 */
export function ExperimentWorkbench({ nodeId, block, en, candidateId }: { nodeId: string; block: ContentBlock; en: boolean; candidateId?: string }) {
  const [tab, setTab] = useState("curves"), [expanded, setExpanded] = useState(false), [snapshotId, setSnapshotId] = useState<string>();
  const [following, setFollowing] = useState(true), [inView, setInView] = useState(typeof IntersectionObserver === "undefined");
  const [hidden, setHidden] = useState<string[]>([]), [emphasis, setEmphasis] = useState<string | null>(null), [filter, setFilter] = useState("");
  const [freezing, setFreezing] = useState(false), [error, setError] = useState("");
  const [editor, setEditor] = useState<ExperimentRunOverview | "new" | null>(null), [removing, setRemoving] = useState<ExperimentRunOverview | null>(null), [linkRun, setLinkRun] = useState<string | null>(null), [viewMaterial, setViewMaterial] = useState<ExperimentMaterialLinkView | null>(null);
  const [prefs, setPrefs] = useChartPrefs();
  const permissions = useResearchPermissions(), client = useQueryClient(), canEdit = permissions.nodes && !candidateId && !snapshotId;
  const host = useRef<HTMLElement>(null);
  const blockPath = "/api/research/record-blocks/" + encodeURIComponent(block.id), experimentPath = "/api/research-nodes/" + encodeURIComponent(nodeId) + "/experiment";
  useEffect(() => {
    if (!host.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { rootMargin: "400px" });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector("[role=dialog]")) setExpanded(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);

  // The stored watermark tells every view of this block when new records have arrived.
  const status = useQuery<{ durableWatermark: number; updatedAt: string | null }>({
    queryKey: ["record-watermark", projectId(), block.id],
    enabled: !candidateId && inView,
    queryFn: ({ signal }) => api(blockPath + "/version", { signal }),
    refetchInterval: following && inView && !snapshotId ? 2000 : false,
    refetchIntervalInBackground: false,
  });
  const watermark = status.data?.durableWatermark;
  const overview = useQuery<ExperimentOverview>({
    gcTime: 0,
    queryKey: ["experiment-runs", projectId(), nodeId, block.id, watermark],
    placeholderData: (previous) => previous,
    enabled: !candidateId && inView,
    queryFn: ({ signal }) => api(experimentPath + "?blockId=" + encodeURIComponent(block.id), { signal }),
  });
  const versions = useQuery<{ snapshots: Snapshot[] }>({
    queryKey: ["record-sources", projectId(), block.id],
    enabled: !candidateId && inView,
    queryFn: ({ signal }) => api(blockPath + "/status", { signal }),
  });
  const materials = useQuery({
    queryKey: ["record-materials", projectId(), nodeId],
    enabled: Boolean(linkRun),
    queryFn: () => api<{ contentBlocks: ContentBlock[] }>("/api/research-nodes/" + encodeURIComponent(nodeId)),
  });
  // A saved version keeps its own run list: runs added later are not part of it.
  const pinned = useQuery<PinnedRun[]>({
    queryKey: ["record-version-runs", projectId(), block.id, snapshotId],
    enabled: Boolean(snapshotId),
    queryFn: async ({ signal }) => {
      const runs: PinnedRun[] = []; let cursor: string | null = null;
      do {
        const page: { data: { items: PinnedRun[] }; page: { nextCursor: string | null } } = await api("/api/research/experiments/read", { method: "POST", signal, body: JSON.stringify({ mode: "runs", nodeId, blockId: block.id, snapshotId, limit: 100, maxChars: 16000, ...(cursor ? { cursor } : {}) }) });
        runs.push(...page.data.items); cursor = page.page.nextCursor;
      } while (cursor);
      return runs;
    },
  });
  const liveRuns = useMemo(() => overview.data?.runs ?? [], [overview.data?.runs]);
  const runIds = useMemo(() => candidateId
    ? [...new Set<string>((block.payload?.runs ?? []).map((run: { runId?: string }) => run.runId).filter(Boolean))]
    : [...new Set((snapshotId ? pinned.data ?? [] : liveRuns).map((run) => run.id))], [candidateId, block.payload?.runs, snapshotId, pinned.data, liveRuns]);
  const plot = useQuery<RecordPlot>({
    gcTime: 0,
    queryKey: ["experiment-record-plot", projectId(), nodeId, block.id, block.revision, candidateId, runIds, snapshotId ?? watermark],
    enabled: runIds.length > 0,
    placeholderData: (previous) => previous,
    queryFn: ({ signal }) => api<RecordPlot>("/api/research/experiments/plot", {
      method: "POST", signal,
      body: JSON.stringify(snapshotId
        // A saved version is read through explicit selections so every run is pinned to it.
        ? { blockId: block.id, selections: runIds.map((runId) => ({ nodeId, blockId: block.id, runId, snapshotId })) }
        : { nodeId, blockId: block.id, blockRevision: block.revision, candidateId }),
    }),
  });

  const identity = (runId: string) => runKey({ nodeId, blockId: block.id, runId });
  const ledgerRuns: LedgerRun[] = useMemo(() => {
    // A proposal and a saved version list the runs they contain; the live block lists its own.
    if (candidateId) return (plot.data?.runs ?? []).map((run) => ({ key: runKey({ nodeId: run.nodeId, blockId: block.id, runId: run.runId }), label: run.runLabel }));
    if (snapshotId) return (pinned.data ?? []).map((run) => ({ key: runKey({ nodeId, blockId: block.id, runId: run.id }), label: run.label, status: run.status }));
    const links = overview.data?.materialLinks ?? [];
    return liveRuns.map((run) => ({ key: runKey({ nodeId, blockId: block.id, runId: run.id }), label: run.label, status: run.status, materialCount: links.filter((link) => link.runId === run.id).length }));
  }, [snapshotId, candidateId, plot.data?.runs, pinned.data, overview.data?.materialLinks, liveRuns, nodeId, block.id]);
  const colors = useMemo(() => assignRunColors([...ledgerRuns.map((run) => { const [node, blockId, runId] = JSON.parse(run.key) as string[]; return { nodeId: node, blockId, runId }; }), ...(plot.data?.series ?? [])]), [ledgerRuns, plot.data?.series]);
  const metrics = useMemo(() => latestValues(plot.data?.series ?? [], 6, filter), [plot.data?.series, filter]);
  const runOf = (key: string) => liveRuns.find((run) => identity(run.id) === key);

  const refresh = () => { for (const key of INVALIDATED) void client.invalidateQueries({ queryKey: [key, projectId()] }); };
  const save = async (patch: object, expectedRevision = overview.data!.revision) => {
    const result = await api<ExperimentOverview>(experimentPath, { method: "PATCH", body: JSON.stringify({ blockId: block.id, expectedExperimentRevision: expectedRevision, patch }) });
    client.setQueryData(["experiment-runs", projectId(), nodeId, block.id, watermark], result);
    refresh();
  };
  const freeze = async () => {
    if (freezing) return;
    setFreezing(true); setError("");
    try { const result = await api<{ id: string }>(blockPath + "/snapshots", { method: "POST", body: "{}" }); refresh(); setSnapshotId(result.id); setTab("data"); }
    catch (cause) { setError((cause as Error).message); } finally { setFreezing(false); }
  };
  const toggle = (key: string) => setHidden((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  const only = (key: string) => setHidden((current) => { const others = ledgerRuns.map((run) => run.key).filter((item) => item !== key); return current.length === others.length && !current.includes(key) ? [] : others; });

  const snapshots = versions.data?.snapshots ?? [], provider = block.payload?.provider ? providerLabel(String(block.payload.provider)) : "";
  const updated = status.data?.updatedAt ? new Date(status.data.updatedAt) : null;
  const tabs = [["curves", en ? "Curves" : "曲线"], ...(!candidateId ? [["data", en ? "Data table" : "数据表"], ["records", en ? "Events & files" : "事件与附件"]] : [])];
  const loadError = plot.error ?? pinned.error ?? overview.error ?? status.error ?? versions.error;
  const waiting = !candidateId && (snapshotId ? pinned.isPending : overview.isPending), empty = !waiting && !runIds.length;

  return (
    <section ref={host} className={"record-block-workbench" + (expanded ? " is-expanded" : "")} data-reading={snapshotId ? "version" : "latest"}>
      <div className="record-bar">
        <div className="record-bar-facts">
          {provider && <span className="record-provider">{provider}</span>}
          {!candidateId && !snapshotId && <span className={"record-live" + (following ? " is-following" : "")}>
            <span className="record-live-dot" aria-hidden="true" />
            {following ? (en ? "Following" : "实时跟随") : (en ? "Paused" : "已暂停")}
            {updated && <time dateTime={updated.toISOString()}>{updated.toLocaleTimeString(en ? "en-GB" : "zh-CN")}</time>}
          </span>}
          {!candidateId && snapshots.length > 0 && <SelectMenu className="record-version" ariaLabel={en ? "Record version" : "记录版本"} value={snapshotId ?? ""} onChange={(value) => setSnapshotId(value || undefined)} options={[{ value: "", label: en ? "Latest records" : "最新记录" }, ...snapshots.map((snapshot) => ({ value: snapshot.id, label: (en ? "Version of " : "固定于 ") + new Date(snapshot.createdAt).toLocaleString(en ? "en-GB" : "zh-CN") }))]} />}
        </div>
        <div className="record-bar-actions">
          {!candidateId && !snapshotId && <button className="button" aria-pressed={following} onClick={() => setFollowing((value) => !value)}>{following ? <Pause size={14} /> : <Play size={14} />}{following ? (en ? "Pause updates" : "暂停更新") : (en ? "Return to latest" : "回到最新")}</button>}
          {snapshotId && <button className="button" onClick={() => setSnapshotId(undefined)}>{en ? "Read latest data" : "读取最新数据"}</button>}
          {canEdit && <RecordActionsMenu nodeId={nodeId} block={block} en={en} freezing={freezing} onChanged={refresh} onAddRun={() => setEditor("new")} onFreeze={() => void freeze()} />}
          <button className="button record-expand" aria-expanded={expanded} aria-label={expanded ? (en ? "Collapse" : "收起") : (en ? "Expand workspace" : "展开工作区")} title={expanded ? (en ? "Collapse" : "收起") : (en ? "Expand workspace" : "展开工作区")} onClick={() => setExpanded((value) => !value)}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
        </div>
      </div>
      {(error || loadError) && <p role="alert">{error || loadError?.message}<button className="button" onClick={() => { setError(""); void status.refetch(); void overview.refetch(); void versions.refetch(); if (snapshotId) void pinned.refetch(); void plot.refetch(); }}>{en ? "Retry" : "重试"}</button></p>}

      {waiting ? <LoadingSkeleton layout="rows" label={en ? "Loading records…" : "正在读取实验记录…"} />
        : empty ? <p className="research-empty">{en ? "Waiting for records" : "等待实验记录"}</p>
        : ledgerRuns.length > 0 && <RunLedger runs={ledgerRuns} colors={colors} hidden={hidden} metrics={metrics} en={en}
            onToggle={toggle} onOnly={only} onShowAll={() => setHidden([])} onEmphasis={setEmphasis}
            renderActions={canEdit ? (item) => { const run = runOf(item.key); return run ? <>
              <button className="research-icon-button" aria-label={en ? "Link material" : "关联材料"} title={en ? "Link material" : "关联材料"} onClick={() => setLinkRun(run.id)}><Link2 size={14} /></button>
              <button className="research-icon-button" aria-label={(en ? "Edit " : "编辑 ") + run.label} title={en ? "Edit run" : "编辑运行"} onClick={() => setEditor(run)}><Pencil size={14} /></button>
              <button className="research-icon-button is-danger" aria-label={(en ? "Delete " : "删除 ") + run.label} title={en ? "Remove run" : "删除运行"} onClick={() => setRemoving(run)}><Trash2 size={14} /></button>
            </> : null; } : undefined}
            renderDetail={snapshotId || candidateId ? undefined : (item) => { const run = runOf(item.key); return run ? <RunDetail run={run} links={(overview.data?.materialLinks ?? []).filter((link) => link.runId === run.id)} en={en} canEdit={canEdit} onView={setViewMaterial} onLink={() => setLinkRun(run.id)} onUnlink={(link) => void save({ removeLinkIds: [link.id] }).catch((cause) => setError(cause.message))} /> : null; }} />}

      {!waiting && !empty && <>
        <div className="record-view-bar">
          <nav className="segmented" aria-label={en ? "Record workspace" : "记录工作区"}>
            {tabs.map(([value, label]) => <button key={value} className={tab === value ? "is-active" : ""} aria-pressed={tab === value} onClick={() => { if (confirmUnsavedChanges()) setTab(value); }}>{label}</button>)}
          </nav>
          {tab === "curves" && plot.data && <ChartControls prefs={prefs} onChange={setPrefs} filter={filter} onFilter={setFilter} metricCount={new Set(plot.data.series.map((line) => line.key)).size} en={en} />}
        </div>
        <div hidden={tab !== "curves"}>
          {plot.isPending ? <LoadingSkeleton layout="cards" label={en ? "Loading curves…" : "正在读取曲线…"} />
            : plot.data && <ExperimentPlots plot={plot.data} en={en} colors={colors} hidden={hidden} onToggle={toggle} emphasis={emphasis} showLegend={false} smoothing={prefs.smoothing} logScale={prefs.logScale} columns={prefs.columns} filter={filter} />}
          {plot.data && plot.data.omittedMetricCount > 0 && <p className="research-hint">{en ? `${plot.data.omittedMetricCount} more metrics are available in the data table.` : `另有 ${plot.data.omittedMetricCount} 项指标，可在数据表中查看。`}</p>}
        </div>
        {tab === "data" && <ExperimentDataWorkspace key={snapshotId ?? "current"} nodeId={nodeId} blockId={block.id} snapshotId={snapshotId} latestWatermark={watermark} en={en} onLatest={() => setSnapshotId(undefined)} />}
        {tab === "records" && <RecordEventsPanel blockId={block.id} en={en} />}
      </>}

      {editor && overview.data && <RunEditor run={editor === "new" ? undefined : editor} en={en} revision={overview.data.revision} onClose={() => { setEditor(null); void overview.refetch(); }}
        onSave={async (value, revision) => { await save(editor === "new" ? { addRuns: [value] } : { updateRuns: [{ ...value, id: editor.id }] }, revision); setEditor(null); }} />}
      {removing && overview.data && <RemoveRunDialog run={removing} links={overview.data.materialLinks.filter((link) => link.runId === removing.id)} en={en} revision={overview.data.revision} onClose={() => setRemoving(null)}
        onConfirm={async (alsoRemoveLinks) => {
          await save({ ...(alsoRemoveLinks && removing.records.length === 0 ? { removeLinkIds: overview.data!.materialLinks.filter((link) => link.runId === removing.id).map((link) => link.id) } : {}), removeRunIds: [removing.id] });
          setRemoving(null); void overview.refetch();
        }} />}
      {linkRun && overview.data && materials.data && <MaterialEditor run={overview.data.runs.find((run) => run.id === linkRun)!} blocks={materials.data.contentBlocks} en={en} revision={overview.data.revision} onClose={() => { setLinkRun(null); void overview.refetch(); }}
        onSave={async (value, revision) => { await save({ addLinks: [value] }, revision); setLinkRun(null); }} />}
      {viewMaterial && <MaterialVersionViewer nodeId={nodeId} link={viewMaterial} en={en} onClose={() => setViewMaterial(null)} />}
    </section>
  );
}

/** What stands behind one run: its note, where the record came from, and the material tied to it. */
function RunDetail({ run, links, en, canEdit, onView, onLink, onUnlink }: {
  run: ExperimentRunOverview; links: ExperimentMaterialLinkView[]; en: boolean; canEdit: boolean;
  onView: (link: ExperimentMaterialLinkView) => void; onLink: () => void; onUnlink: (link: ExperimentMaterialLinkView) => void;
}) {
  const item = (link: ExperimentMaterialLinkView) => link.selection.kind === "row" || link.selection.kind === "assetRow"
    ? (en ? "Row " : "第 ") + (link.selection.rowIndex + 1) + (en ? "" : " 行")
    : link.selection.kind === "asset" ? (link.item?.label ?? (en ? "File" : "文件")) : en ? "Whole block" : "整个内容块";
  return (
    <div className="run-detail">
      {run.note && <p className="run-detail-note">{run.note}</p>}
      <dl className="run-detail-facts">
        <div><dt>{en ? "Source" : "来源"}</dt><dd>{run.sources.length ? run.sources.map((source) => <span key={source.provider + source.sourceId} className="run-detail-source"><span>{providerLabel(source.provider)}</span><code title={source.sourceId}>{source.sourceId}</code></span>) : (en ? "Recorded by hand" : "手工记录")}</dd></div>
      </dl>
      <div className="run-detail-materials">
        <h5>{en ? "Linked material" : "关联材料"}<span className="count">{links.length}</span></h5>
        {links.length > 0 && <ul>{links.map((link) => (
          <li key={link.id}>
            <button className="button run-detail-material" onClick={() => onView(link)}>{link.title}</button>
            <span className="run-detail-material-item">{item(link)}</span>
            <span className="count">v{link.blockRevision}</span>
            {link.archived && <span className="relation-type">{en ? "Archived" : "已归档"}</span>}
            {canEdit && <button className="research-icon-button is-danger" aria-label={(en ? "Unlink " : "解除关联 ") + link.title} title={en ? "Unlink" : "解除关联"} onClick={() => onUnlink(link)}><Trash2 size={14} /></button>}
          </li>
        ))}</ul>}
        {canEdit && <button className="button" onClick={onLink}><Link2 size={14} />{en ? "Link material" : "关联材料"}</button>}
        {!links.length && !canEdit && <p className="research-hint">{en ? "No material linked to this run." : "这次运行没有关联材料。"}</p>}
      </div>
    </div>
  );
}
