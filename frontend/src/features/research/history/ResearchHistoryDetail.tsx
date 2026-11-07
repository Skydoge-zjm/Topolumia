import { ExperimentMetadataSnapshot } from "@/features/experiments/ExperimentMetadataSnapshot";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { historyKinds, historyOutcomes } from "@domain/research/research-history";
import { nodeKinds } from "@domain/research/node-fields";
import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import { MarkdownBody, MetricTable, LinkList } from "../components/ResearchUi";
import { text } from "../model";
import type { HistoryEvent } from "./model";
import { subjectUrl } from "./model";
import { HistoryEntry } from "./ResearchHistoryPanel";
export function ResearchHistoryDetail() {
  const { id } = useParams(), en = useUiStore(state => state.locale) === "en";
  const query = useQuery({ queryKey: ["research-history-event", projectId(), id], queryFn: () => api<HistoryEvent>(`/api/research-history/${id}`) });
  if (query.isPending) return <div className="loading">{en ? "Loading research event…" : "载入科研事件…"}</div>;
  if (query.error || !query.data) return <section className="research-workspace"><p role="alert">{query.error?.message}</p><Link to="/records">{en ? "Research records" : "研究记录"}</Link></section>;
  const event = query.data;
  return <section translate="no" className="research-workspace research-detail"><Link className="research-back" to="/records">← {en ? "Research records" : "研究记录"}</Link><header className="research-page-heading"><div><h1>{historyKinds[event.kind]?.[en ? "en" : "zh"]}</h1></div><span className="research-badge">{historyOutcomes[event.outcome]?.[en ? 1 : 0]}</span></header>
    <section className="research-card"><h2>{en ? "People and decision" : "参与方与处理结果"}</h2><dl className="research-field-details"><div><dt>{en?"Time":"时间"}</dt><dd>{new Date(event.occurredAt).toLocaleString(en?"en-GB":"zh-CN")}</dd></div><div><dt>{en ? "Performed by" : "操作方"}</dt><dd>{event.actor.name} · {event.actor.type}</dd></div>{event.initiatedBy && <div><dt>{en ? "Initiated by" : "发起方"}</dt><dd>{event.initiatedBy.name} · {event.initiatedBy.type}{event.initiatedBy.model ? ` · ${event.initiatedBy.model}` : ""}</dd></div>}<div><dt>{en ? "Reason" : "处理理由"}</dt><dd>{event.reason || "—"}</dd></div>{event.proposalReason && <div><dt>{en ? "Proposal rationale" : "提议理由"}</dt><dd>{event.proposalReason}</dd></div>}</dl>{event.proposal && <p className="research-hint">{en ? "Proposal" : "提议"} v{event.proposal.revision} · {event.proposal.id}</p>}{event.planned && <p className="research-warning">{en ? "These are proposed changes. This event did not apply them to the research graph." : "以下为提议内容；本次事件没有将这些变更写入正式科研拓扑。"}</p>}{event.causedBy && <Link className="button" to={`/records/history/${event.causedBy}`}>{en ? "View triggering research action" : "查看触发此调整的科研行为"}</Link>}</section>
    {event.changes.map((change, index) => {
      const url = event.liveObjects?.includes(`${change.subject.type}:${change.subject.id}`) ? subjectUrl(change.subject) : null;
      return <section className="research-card" key={index}><header className="research-section-heading"><div><h2>{text(change.subject.label, en)}</h2></div>{url && <Link className="button" to={url}>{en ? "Open current object" : "查看当前对象"}</Link>}</header><dl className="research-field-details"><div><dt>{en?"Action":"行为"}</dt><dd>{historyKinds[change.action]?.[en?"en":"zh"]??change.action}</dd></div></dl><div className="research-history-comparison">{change.before && <div><h3>{en ? "Before this action" : "操作前快照"}</h3><ObjectSnapshot object={change.before} type={change.subject.type} en={en} /></div>}{change.after ? <div><h3>{event.planned ? (en ? "Proposed state" : "提议状态") : (en ? "After this action" : "操作后快照")}</h3><ObjectSnapshot object={change.after} type={change.subject.type} en={en} /></div> : <p className="research-warning">{event.planned ? (en ? "Proposed removal" : "拟移除此对象") : (en ? "Object removed; its historical snapshot is retained here." : "对象已移除，其历史快照保存在此处。")}</p>}</div></section>;
    })}
    {(event.related?.length ?? 0) > 1 && <section className="research-card"><h2>{en ? "Proposal lifecycle" : "提议处理过程"}</h2>{event.related?.filter(item => item.id !== event.id).map(item => <HistoryEntry key={item.id} event={item} en={en} />)}</section>}
  </section>;
}
function ObjectSnapshot({ object, type, en }: { object: any; type: string; en: boolean }) {
  const inherited = object.kind === "experiment" ? {
    ...(object.data?.purpose ? { purpose: text(object.data.purpose, en) } : {}),
    ...(object.data?.design ? { design: Object.entries(object.data.design).map(([key, value]) => `${key}: ${value}`).join("\n") } : {}),
  } : {};
  const fields = { ...inherited, ...object.data?.details }, body = object.data?.body ?? object.data?.noteMarkdown ?? object.body ?? "";
  const metrics = object.data?.metrics ?? object.metrics ?? Object.entries(object.data?.keyMetrics ?? {}).filter(([, value]) => typeof value === "number").map(([name, value]) => ({ name, value: Number(value), unit: "", split: "", direction: "none" }));
  return <div className="research-history-snapshot"><strong>{text(object.label, en) || object.core?.nodeName || object.title || ""}</strong><p>{text(object.summary, en) || object.core?.summary || object.description || object.agenda || ""}</p><dl className="research-field-details"><div><dt>{en ? "Type" : "类型"}</dt><dd>{(en ? nodeKinds[object.kind]?.en : nodeKinds[object.kind]?.label) ?? object.kind ?? object.type ?? type}</dd></div><div><dt>{en ? "Status" : "状态"}</dt><dd>{object.status ?? (object.active === undefined ? "—" : object.active ? (en ? "Enabled" : "启用") : (en ? "Paused" : "停用"))}</dd></div>{Object.entries(fields).map(([key, value]) => <div key={key}><dt>{nodeKinds[object.kind]?.fields.find(field => field.key === key)?.[en ? "en" : "label"] ?? key}</dt><dd>{String(value)}</dd></div>)}{["scheduledAt", "occurredAt", "timezone", "frequency", "interval", "startDate", "localTime", "parentId"].filter(key => object[key] != null).map(key => <div key={key}><dt>{en ? key : ({ scheduledAt: "计划时间", occurredAt: "发生时间", timezone: "时区", frequency: "重复周期", interval: "间隔", startDate: "起始日期", localTime: "当地时间", parentId: "上级组" } as Record<string, string>)[key]}</dt><dd>{String(object[key])}</dd></div>)}</dl>{body && <MarkdownBody body={body} en={en} />}
    {object.kind === "experiment" && Array.isArray(object.runs) && <ExperimentMetadataSnapshot runs={object.runs} links={object.materialLinks} en={en} />}
    {metrics.length > 0 && <MetricTable metrics={metrics} en={en} />}{(object.data?.links?.length ?? object.links?.length ?? 0) > 0 && <LinkList links={object.data?.links ?? object.links} en={en} />}
    {object.nodeIds && <p>{en ? "Members: " : "成员："}{object.nodeIds.join(" · ") || "—"}</p>}{object.from && <p>{typeof object.from === "object" ? `${object.from.kind}: ${object.from.id}` : String(object.from)} → {typeof object.to === "object" ? `${object.to.kind}: ${object.to.id}` : String(object.to)} · {object.type}</p>}{object.members?.length > 0 && <div className="research-table-wrap"><table className="research-table"><thead><tr><th>{en ? "Member" : "成员"}</th><th>{en ? "Role" : "角色"}</th><th>{en ? "Note" : "说明"}</th></tr></thead><tbody>{object.members.map((member: any) => <tr key={member.nodeId}><td>{member.label || member.nodeId}</td><td>{member.role || "—"}</td><td>{member.note || "—"}</td></tr>)}</tbody></table></div>}{object.contentBlockVersions?.length > 0 && <div><h3>{en ? "Material versions" : "研究材料版本"}</h3>{object.contentBlockVersions.map((block: any) => <p key={block.id}>{block.title} · v{block.revision} · {block.lifecycle}</p>)}</div>}{object.participants?.length > 0 && <p>{en ? "Participants: " : "参与者："}{object.participants.join(" · ")}</p>}{object.decisions?.length > 0 && <ul>{object.decisions.map((decision: string, index: number) => <li key={index}>{decision}</li>)}</ul>}
    {object.openQuestions?.length > 0 && <div><h3>{en ? "Open questions" : "未决问题"}</h3><ul>{object.openQuestions.map((question: string, index: number) => <li key={index}>{question}</li>)}</ul></div>}
    {object.actions?.length > 0 && <div><h3>{en ? "Follow-up actions" : "后续行动"}</h3>{object.actions.map((action: any, index: number) => <p key={index}>{action.text} · {action.assignee || "—"} · {action.dueDate || "—"} · {action.status}</p>)}</div>}
    <small>{en ? "Object ID: " : "对象 ID："}{object.id}</small>
  </div>;
}
