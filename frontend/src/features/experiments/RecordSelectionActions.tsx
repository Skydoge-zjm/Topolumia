import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { objectBase } from "@/features/research/model";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { ContentBlockEditor } from "@/features/topology/details/ContentBlockEditor";
import type { ContentBlock } from "@/features/topology/details/ContentBlockRenderer";
import { TrainingRecordPicker } from "./TrainingRecordPicker";
import { asRecordEntry, type TrainingRun } from "./trainingRecords";

export function RecordSelectionActions({ nodeId, block, en, onChanged }: { nodeId: string; block: ContentBlock; en: boolean; onChanged: () => void }) {
  const [mode, setMode] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const base = objectBase({ kind: "node", id: nodeId }) + "/content-blocks/" + encodeURIComponent(block.id);
  const save = async (patch: unknown) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await api(base, { method: "PATCH", body: JSON.stringify({ patch, expectedRevision: block.revision }) }); setMode(""); onChanged(); }
    catch (cause) { setError((cause as Error).message); throw cause; } finally { setBusy(false); }
  };
  const choose = async (runs: TrainingRun[]) => {
    const entries = [...new Map([...(block.payload?.runs ?? []), ...runs.map(asRecordEntry)].map(run => [run.sourceId, run])).values()];
    await save({ payload: { ...block.payload, provider: runs[0].provider, runs: entries } });
  };
  const upload = async (file: File) => {
    const result = await api<{ asset: { id: string; originalName: string } }>("/api/research-assets", { method: "POST", body: file, headers: { "content-type": "application/octet-stream", "x-asset-name": encodeURIComponent(file.name), "x-asset-media-type": file.type || "application/octet-stream", "idempotency-key": crypto.randomUUID() } });
    return { ...result.asset, preview: null };
  };
  return <><button className="button" onClick={() => setMode("select")}>{en ? "Add runs" : "添加运行"}</button><button className="button" onClick={() => setMode("import")}>{en ? "Import record files" : "导入记录文件"}</button><button className="button" onClick={() => setMode("follow")}>{en ? "Auto-assignment" : "自动归入"}</button>
    {error && !mode && <p role="alert">{error}</p>}
    {mode === "select" && <TrainingRecordPicker en={en} provider={block.payload?.runs?.length || block.payload?.followSources?.length ? String(block.payload?.provider) : undefined} onClose={() => !busy && setMode("")} onSelect={choose} />}
    {mode === "import" && <ResearchDialog title={en ? "Import record files" : "导入记录文件"} onClose={() => !busy && setMode("")}><ContentBlockEditor initial={block} initialRecordImport experimentId={nodeId} en={en} onSave={save} onUpload={upload} onCancel={() => setMode("")} /></ResearchDialog>}
    {mode === "follow" && <FollowRules en={en} block={block} busy={busy} error={error} onSave={rules => save({ payload: { ...block.payload, followSources: rules } })} onClose={() => !busy && setMode("")} />}
  </>;
}

type Rule = { sourceId: string; directory: string };
function FollowRules({ en, block, busy, error, onSave, onClose }: { en: boolean; block: ContentBlock; busy: boolean; error: string; onSave: (rules: Rule[]) => Promise<void>; onClose: () => void }) {
  const rules: Rule[] = block.payload?.followSources ?? [];
  const [sourceId, setSourceId] = useState(""), [directory, setDirectory] = useState("");
  const query = useQuery({ queryKey: ["training-record-sources", projectId(), block.payload?.provider], queryFn: () => api<{ sources: { id: string; hostLabel: string; provider: string; directory: string }[] }>("/api/research/training-records?limit=1") });
  const sources = query.data?.sources.filter(source => source.provider === block.payload?.provider) ?? [], selectedId = sourceId || sources[0]?.id || "";
  const submit = (value: Rule[]) => void onSave(value).catch(() => {});
  return <ResearchDialog title={en ? "Automatically assign future runs" : "自动归入后续运行"} onClose={onClose}>
    <label>{en ? "Record source" : "记录来源"}<SelectMenu ariaLabel={en ? "Record source" : "记录来源"} value={selectedId} disabled={busy} onChange={setSourceId} options={sources.map(source => ({ value: source.id, label: source.hostLabel + " · " + source.directory }))} /></label>
    <label>{en ? "Experiment subdirectory" : "实验专属子目录"}<input value={directory} disabled={busy} onChange={event => setDirectory(event.target.value)} placeholder="experiments/rank4" /></label>
    {rules.map(rule => <div className="record-source-row" key={rule.sourceId + ":" + rule.directory}><code>{rule.directory}</code><button type="button" className="button" disabled={busy} onClick={() => submit(rules.filter(item => item !== rule))}>{en ? "Stop auto-assignment" : "停止自动归入"}</button></div>)}
    {(error || query.error) && <p role="alert">{error || query.error?.message}</p>}<footer className="record-source-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>{en ? "Close" : "关闭"}</button><button type="button" className="button primary" disabled={busy || !selectedId || !directory.trim()} onClick={() => submit([...rules.filter(rule => rule.sourceId !== selectedId || rule.directory !== directory.trim()), { sourceId: selectedId, directory: directory.trim() }])}>{en ? "Enable rule" : "启用规则"}</button></footer>
  </ResearchDialog>;
}
