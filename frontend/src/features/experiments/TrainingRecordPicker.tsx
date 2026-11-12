import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { useResearchPermissions } from "@/features/research/useResearch";
import { environmentHeaders, sshOverviewKey, type SshOverview } from "@/features/environments/ssh/ssh";
import { RunStatusDot } from "./RunStatusDot";
import { MlflowImportDialog } from "./MlflowImportDialog";

import type { TrainingRun } from "./trainingRecords";

type RecordPage = { items: TrainingRun[]; total: number; nextOffset: number | null; sources: { id: string; provider: string; hostId: string; hostLabel: string; enabled: boolean }[] };

export function TrainingRecordPicker({ en, provider, onSelect, onClose }: { en: boolean; provider?: string; onSelect: (runs: TrainingRun[]) => void | Promise<void>; onClose: () => void }) {
  return <ResearchDialog title={en ? "Select training records" : "选择训练记录"} onClose={onClose}><TrainingRecordsBrowser en={en} provider={provider} onSelect={onSelect} onCancel={onClose} /></ResearchDialog>;
}

export function TrainingRecordsBrowser({ en, provider = "", initialHost = "", unassigned = false, onSelect, onCancel, actionLabel, canSelect = true }: { en: boolean; provider?: string; initialHost?: string; unassigned?: boolean; onSelect: (runs: TrainingRun[]) => void | Promise<void>; onCancel?: () => void; actionLabel?: string; canSelect?: boolean }) {
  const permissions = useResearchPermissions();
  const [mlflowImport, setMlflowImport] = useState(false);
  const [selected, setSelected] = useState<Record<string, TrainingRun>>({}), [tool, setTool] = useState(provider), [host, setHost] = useState(initialHost), [search, setSearch] = useState(""), [applied, setApplied] = useState(""), [offset, setOffset] = useState(0), [onlyUnassigned, setOnlyUnassigned] = useState(unassigned), [busy, setBusy] = useState(""), [error, setError] = useState("");
  useEffect(() => { const timer = setTimeout(() => { setApplied(search.trim()); setOffset(0); }, 250); return () => clearTimeout(timer); }, [search]);
  const params = new URLSearchParams({ offset: String(offset), limit: "50", q: applied, provider: tool, hostId: host, unassigned: String(onlyUnassigned) });
  const query = useQuery({ queryKey: ["training-records", projectId(), offset, applied, tool, host, onlyUnassigned], queryFn: ({ signal }) => api<RecordPage>("/api/research/training-records?" + params, { signal }), refetchInterval: 5000, refetchIntervalInBackground: false });
  const ssh = useQuery({ queryKey: sshOverviewKey(projectId(), permissions.actorId), queryFn: ({ signal }) => api<SshOverview>("/api/ssh/connections", { signal }), retry: false });
  const chosen = Object.values(selected), chosenTool = chosen[0]?.provider;
  const hosts = new Map<string, string>([["local", en ? "Local computer" : "本机"], ...(ssh.data?.connections.map(connection => [connection.id, connection.name] as [string, string]) ?? []), ...(query.data?.sources.map(source => [source.hostId, source.hostLabel] as [string, string]) ?? [])]);
  const enableHost = host || ssh.data?.current?.connectionId || "local";
  const connection = useQuery({ queryKey: ["record-collectors", projectId(), enableHost], enabled: Boolean(query.data && !query.data.items.length), queryFn: ({ signal }) => api<{ adapters: { provider: string; sources: { id: string; status: string; phase?: string; error?: string }[] }[] }>("/api/tools-environment/record-collectors", { signal, headers: environmentHeaders(projectId(), enableHost === "local" ? undefined : enableHost) }), refetchInterval: 3000, refetchIntervalInBackground: false });
  const enable = async (provider: string) => {
    if (busy) return; setBusy(provider); setError("");
    try { await api("/api/tools-environment/record-collectors/" + provider + "/enable", { method: "POST", headers: environmentHeaders(projectId(), enableHost === "local" ? undefined : enableHost), body: "{}" }); setError(en ? "Deployment started. New records will appear here." : "已开始部署，发现的记录会出现在这里。"); void query.refetch(); void connection.refetch(); }
    catch (cause) { setError((cause as Error).message); } finally { setBusy(""); }
  };
  return <div className="training-record-browser">
    <div className="experiment-run-toolbar"><input aria-label={en ? "Search training records" : "搜索训练记录"} placeholder={en ? "Run name or directory" : "运行名称或目录"} value={search} onChange={event => setSearch(event.target.value)} />
      {!provider && <SelectMenu ariaLabel={en ? "Recording tool" : "记录工具"} value={tool} onChange={value => { setTool(value); setOffset(0); }} options={[{ value: "", label: en ? "All tools" : "全部工具" }, { value: "wandb", label: "W&B" }, { value: "tensorboard", label: "TensorBoard" }, { value: "mlflow", label: "MLflow" }]} />}
      <SelectMenu ariaLabel={en ? "Record host" : "记录主机"} value={host} onChange={value => { setHost(value); setOffset(0); }} options={[{ value: "", label: en ? "All hosts" : "全部主机" }, ...[...hosts].map(([value, label]) => ({ value, label }))]} />
      <label><input type="checkbox" checked={onlyUnassigned} onChange={event => { setOnlyUnassigned(event.target.checked); setOffset(0); }} />{en ? "Unassigned only" : "仅未归入实验"}</label><button type="button" className="button" onClick={() => void query.refetch()}>{en ? "Refresh" : "刷新"}</button>
      {permissions.manageEnvironments && (!provider || provider === "mlflow") && <button type="button" className="button" disabled={Boolean(busy)} onClick={() => setMlflowImport(true)}>{en ? "Import from MLflow" : "从 MLflow 导入"}</button>}
    </div>
    {query.isPending && <LoadingSkeleton layout="rows" label={en ? "Loading training records…" : "正在读取训练记录…"} />}
    {query.error && <p role="alert">{query.error.message}</p>}
    {query.data && <><div className="research-table-wrap"><table className="research-table"><thead><tr><th>{en ? "Select" : "选择"}</th><th>{en ? "Run" : "运行"}</th><th>{en ? "Tool / host" : "工具 / 主机"}</th><th>{en ? "Directory" : "目录"}</th><th>{en ? "Status" : "状态"}</th></tr></thead><tbody>{query.data.items.map(run => <tr key={run.sourceId}><td><input type="checkbox" aria-label={run.label} checked={Boolean(selected[run.sourceId])} disabled={Boolean(chosenTool && chosenTool !== run.provider)} onChange={() => setSelected(current => { const next = { ...current }; if (next[run.sourceId]) delete next[run.sourceId]; else next[run.sourceId] = run; return next; })} /></td><td><strong>{run.label}</strong>{run.assigned && <small>{en ? "Already assigned" : "已归入实验"}</small>}</td><td>{run.provider === "wandb" ? "W&B" : run.provider === "mlflow" ? "MLflow" : "TensorBoard"} · {run.hostLabel}</td><td><code>{run.directory}</code></td><td><RunStatusDot en={en} status={run.status} /></td></tr>)}</tbody></table></div>
      {!query.data.items.length && <div className="record-source-actions"><span>{en ? "No matching training records" : "暂无符合条件的训练记录"}</span>{permissions.manageEnvironments && ["wandb", "tensorboard"].filter(value => (!provider || value === provider) && !query.data!.sources.some(source => source.hostId === enableHost && source.provider === value && source.enabled)).map(value => <button key={value} type="button" className="button" disabled={Boolean(busy)} onClick={() => void enable(value)}>{(en ? "Enable " : "启用 ") + (value === "wandb" ? "W&B" : "TensorBoard") + " · " + hosts.get(enableHost)}</button>)}<Link className="button" to={"/tools" + (enableHost !== "local" ? "?hostId=" + encodeURIComponent(enableHost) : "")}>{en ? "Tools & environment" : "工具与环境"}</Link></div>}
      {error && <p role="status">{error}</p>}
      {!query.data.items.length && connection.data?.adapters.filter(adapter => !provider || adapter.provider === provider).flatMap(adapter => adapter.sources.map(source => <div className="record-source-row" key={source.id}><span role="status">{adapter.provider === "wandb" ? "W&B" : "TensorBoard"} · {({ running: en ? "Running · waiting for records" : "运行中 · 等待记录", deploying: en ? "Deploying" : "部署中", starting: en ? "Starting" : "启动中", preparing: en ? "Preparing environment" : "准备环境", installing: en ? "Installing reader" : "安装读取器", paused: en ? "Paused" : "已暂停", waiting: en ? "Waiting for connection" : "等待连接", error: en ? "Error" : "异常" } as Record<string, string>)[source.phase ?? source.status] ?? source.status}{source.error && " · " + source.error}</span></div>))}
      <div className="experiment-run-toolbar"><button type="button" className="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{en ? "Previous" : "上一页"}</button><span>{query.data.total ? offset + 1 : 0}–{offset + query.data.items.length} / {query.data.total}</span><button type="button" className="button" disabled={query.data.nextOffset === null} onClick={() => setOffset(query.data!.nextOffset!)}>{en ? "Next" : "下一页"}</button></div></>}
    <footer className="record-source-actions">{onCancel && <button type="button" className="button" disabled={Boolean(busy)} onClick={onCancel}>{en ? "Cancel" : "取消"}</button>}{canSelect && <button type="button" className="button primary" disabled={!chosen.length || chosen.length > 200 || Boolean(busy)} onClick={async () => { setBusy("selection"); setError(""); try { await onSelect(chosen); } catch (cause) { setError((cause as Error).message); } finally { setBusy(""); } }}>{actionLabel ?? (en ? "Add selected runs" : "添加所选运行")} ({chosen.length})</button>}</footer>
    {mlflowImport && <MlflowImportDialog en={en} onClose={() => setMlflowImport(false)} />}
  </div>;
}
