import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { nodeUrl } from "@/features/research/model";
import { TrainingRecordsBrowser } from "./TrainingRecordPicker";
import type { TrainingRun } from "./trainingRecords";

export function TrainingRecordsView({ en, hostId = "", canEdit }: { en: boolean; hostId?: string; canEdit: boolean }) {
  const [runs, setRuns] = useState<TrainingRun[]>();
  return <><TrainingRecordsBrowser en={en} initialHost={hostId} unassigned canSelect={canEdit} onSelect={value => setRuns(value)} actionLabel={en ? "Assign to experiment" : "加入实验"} />{runs && <AssignRuns en={en} runs={runs} onClose={() => setRuns(undefined)} />}</>;
}

function AssignRuns({ en, runs, onClose }: { en: boolean; runs: TrainingRun[]; onClose: () => void }) {
  const [target, setTarget] = useState("new"), [name, setName] = useState(runs[0]?.label ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const navigate = useNavigate(), client = useQueryClient();
  const experiments = useQuery({ queryKey: ["research-experiments", projectId()], queryFn: () => api<{ items: { id: string; name: string }[] }>("/api/research-experiments") });
  const detail = useQuery({ queryKey: ["research-node", projectId(), target], enabled: target !== "new", queryFn: () => api<{ blockCollectionRevision: number }>("/api/research-nodes/" + encodeURIComponent(target)) });
  const submit = async () => {
    if (busy) return; setBusy(true); setError("");
    try {
      const result = await api<{ nodeId: string; blockId: string }>("/api/research/training-records/assign", { method: "POST", body: JSON.stringify({ runs: runs.map(run => run.projectSource), ...(target === "new" ? { nodeName: name } : { nodeId: target, expectedCollectionRevision: detail.data?.blockCollectionRevision }) }) });
      void client.invalidateQueries({ queryKey: ["research-experiments", projectId()] }); void client.invalidateQueries({ queryKey: ["training-records", projectId()] });
      navigate(nodeUrl(result.nodeId)); onClose();
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  };
  return <ResearchDialog title={en ? "Assign training records" : "将训练记录加入实验"} onClose={() => !busy && onClose()}><label>{en ? "Experiment" : "实验"}<SelectMenu ariaLabel={en ? "Target experiment" : "目标实验"} value={target} onChange={setTarget} disabled={busy} options={[{ value: "new", label: en ? "Create experiment" : "新建实验" }, ...(experiments.data?.items.map(node => ({ value: node.id, label: node.name })) ?? [])]} /></label>{target === "new" && <label>{en ? "Experiment name" : "实验名称"}<input value={name} maxLength={240} disabled={busy} onChange={event => setName(event.target.value)} /></label>}<p>{runs.length} {en ? "selected runs" : "次所选运行"}</p>{(error || detail.error) && <p role="alert">{error || detail.error?.message}</p>}<footer className="record-source-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>{en ? "Cancel" : "取消"}</button><button type="button" className="button primary" disabled={busy || target === "new" && !name.trim() || target !== "new" && !detail.data} onClick={() => void submit()}>{busy ? en ? "Saving…" : "保存中…" : en ? "Confirm" : "确认加入"}</button></footer></ResearchDialog>;
}
