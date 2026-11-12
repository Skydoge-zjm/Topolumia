import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { environmentHeaders } from "./ssh/ssh";
import "@/features/experiments/experiment-records.css";

type Source = { id: string; directory: string; enabled: boolean; status: string; phase?: string; error?: string; checkedAt?: number | string; updatedAt?: string; queueBytes?: number; sync?: string; runCount: number };
type Inventory = { adapters: { provider: string; sources: Source[] }[] };
const statusNames: Record<string, [string, string]> = { running: ["运行中", "Running"], starting: ["启动中", "Starting"], paused: ["已暂停", "Paused"], waiting: ["等待连接", "Waiting for connection"], stopped: ["已停止", "Stopped"], error: ["异常", "Error"], preparing: ["准备环境", "Preparing environment"], installing: ["安装读取器", "Installing reader"], deploying: ["部署中", "Deploying"] };

export function RecordCollectorsPanel({ en, sshId = "", canManage, online }: { en: boolean; sshId?: string; canManage: boolean; online: boolean }) {
  const client = useQueryClient(), headers = environmentHeaders(projectId(), sshId), base = "/api/tools-environment/record-collectors";
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [editing, setEditing] = useState<string>(), [directories, setDirectories] = useState("");
  const query = useQuery({ queryKey: ["record-collectors", projectId(), sshId || "local"], queryFn: ({ signal }) => api<Inventory>(base, { headers, signal }), refetchInterval: 3000, refetchIntervalInBackground: false });
  const action = async (path: string, body: object = {}) => {
    if (busy) return;
    setBusy(path); setError("");
    try {
      await api(base + path, { method: "POST", headers, body: JSON.stringify(body) });
      await query.refetch(); setEditing(undefined);
      void client.invalidateQueries({ queryKey: ["training-records", projectId()] });
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(""); }
  };
  return <section className="record-collectors-section">
    <div className="experiment-run-toolbar"><h2>{en ? "Training record collection" : "实验记录采集"}</h2><Link className="button" to={"/experiments?view=records" + (sshId ? "&hostId=" + encodeURIComponent(sshId) : "&hostId=local")}>{en ? "View records" : "查看记录"}</Link></div>
    {query.isPending && <LoadingSkeleton layout="rows" label={en ? "Checking adapters…" : "正在检查采集适配器…"} />}
    {(error || query.error) && <p role="alert">{error || query.error?.message}<button className="button" onClick={() => void query.refetch()}>{en ? "Retry" : "重试"}</button></p>}
    <div className="research-table-wrap"><table className="research-table"><thead><tr><th>{en ? "Adapter" : "适配器"}</th><th>{en ? "Status" : "状态"}</th><th>{en ? "Directory" : "采集目录"}</th><th>{en ? "Runs" : "运行"}</th><th>{en ? "Actions" : "操作"}</th></tr></thead><tbody>
      {query.data?.adapters.flatMap(adapter => adapter.sources.length ? adapter.sources.map((source, index) => <tr key={source.id}>
        <td>{adapter.provider === "wandb" ? "W&B" : "TensorBoard"}</td><td><span role="status">{(statusNames[source.phase ?? source.status] ?? statusNames.waiting)[en ? 1 : 0]}</span>{source.sync === "waiting" && <span> · {en ? "Upload waiting" : "等待上传"}</span>}{source.error && <div role="alert">{source.error}</div>}{source.queueBytes ? <span> · {Math.ceil(source.queueBytes / 1024)} KiB {en ? "queued" : "待发送"}</span> : null}{source.updatedAt && <small>{en ? "Last received " : "最近接收 "}{new Date(source.updatedAt).toLocaleString()}</small>}</td><td><code>{source.directory}</code></td><td>{source.runCount}</td><td>{canManage && <div className="record-source-actions"><button type="button" className="button" disabled={Boolean(busy) || !online || ["deploying", "starting"].includes(source.status)} onClick={() => void action("/sources/" + encodeURIComponent(source.id) + (source.enabled && source.status !== "error" ? "/pause" : "/resume"))}>{source.status === "error" ? en ? "Retry deployment" : "重新部署" : source.enabled ? en ? "Pause" : "暂停" : en ? "Resume" : "继续采集"}</button>{index === 0 && <button type="button" className="button" disabled={Boolean(busy) || !online} onClick={() => { setEditing(adapter.provider); setDirectories((adapter.sources.some(source => source.enabled) ? adapter.sources.filter(source => source.enabled) : adapter.sources).map(source => source.directory).join("\n")); }}>{en ? "Directories" : "管理目录"}</button>}</div>}</td>
      </tr>) : [<tr key={adapter.provider}><td>{adapter.provider === "wandb" ? "W&B" : "TensorBoard"}</td><td>{en ? "Not enabled" : "未启用"}</td><td>{en ? "Project directory" : "当前项目目录"}</td><td>—</td><td>{canManage && <button type="button" className="button" disabled={Boolean(busy) || !online} onClick={() => void action("/" + adapter.provider + "/enable")}>{busy === "/" + adapter.provider + "/enable" ? en ? "Preparing…" : "正在准备…" : en ? "Deploy and enable" : "部署并启用"}</button>}</td></tr>])}
    </tbody></table></div>
    {editing && <ResearchDialog title={en ? "Record directories" : "采集目录"} onClose={() => !busy && setEditing(undefined)}><label>{en ? "Absolute directories, one per line" : "绝对目录，每行一个"}<textarea rows={5} value={directories} disabled={Boolean(busy)} onChange={event => setDirectories(event.target.value)} /></label>{error && <p role="alert">{error}</p>}<footer className="record-source-actions"><button type="button" className="button" disabled={Boolean(busy)} onClick={() => setEditing(undefined)}>{en ? "Cancel" : "取消"}</button><button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => void action("/" + editing + "/enable", { directories: directories.split(/\r?\n/).map(value => value.trim()).filter(Boolean) })}>{en ? "Save and enable" : "保存并启用"}</button></footer></ResearchDialog>}
  </section>;
}
