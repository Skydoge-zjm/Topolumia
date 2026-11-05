import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText, GitPullRequest, Layers, Network, Trash2 } from "lucide-react";
import { historyKinds, historyCategories, historyOutcomes } from "@domain/research/research-history";
import { api, projectId } from "@/shared/lib/api";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { text } from "../model";
import type { HistoryEvent } from "./model";
export function ResearchHistoryPanel({ en }: { en: boolean }) {
  const [search, setSearch] = useState(""), [category, setCategory] = useState(""), [actor, setActor] = useState(""), [outcome, setOutcome] = useState(""), [offset, setOffset] = useState(0);
  const query = useQuery({ queryKey: ["research-history", projectId(), search, category, actor, outcome, offset], queryFn: () => api<{ items: HistoryEvent[]; total: number; nextOffset: number | null }>(`/api/research-history?${new URLSearchParams({ q: search, category, actor, outcome, offset: String(offset) })}`), refetchInterval: 10000 });
  return <div><div className="research-toolbar"><input aria-label={en ? "Search research history" : "搜索科研历程"} placeholder={en ? "Search actions, objects or participants…" : "搜索行为、科研对象或参与者…"} value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} />
    <SelectMenu ariaLabel={en ? "History category" : "科研事件类型"} value={category} onChange={value => { setCategory(value); setOffset(0); }} options={[{ value: "", label: en ? "All research events" : "全部科研事件" }, ...Object.entries(historyCategories).map(([value, labels]) => ({ value, label: labels[en ? 1 : 0] }))]} />
    <SelectMenu ariaLabel={en ? "Participants" : "事件参与方"} value={actor} onChange={value => { setActor(value); setOffset(0); }} options={[{ value: "", label: en ? "All participants" : "全部参与方" }, { value: "human", label: en ? "Researchers" : "研究者" }, { value: "agent", label: "Agent" }, { value: "system", label: en ? "System" : "系统" }]} />
    <SelectMenu ariaLabel={en ? "Event outcome" : "科研事件结果"} value={outcome} onChange={value => { setOutcome(value); setOffset(0); }} options={[{ value: "", label: en ? "All outcomes" : "全部结果" }, ...Object.entries(historyOutcomes).map(([value, labels]) => ({ value, label: labels[en ? 1 : 0] }))]} /><span>{query.data?.total ?? 0} {en ? "events" : "项事件"}</span></div>
    {query.error && <p role="alert">{query.error.message}</p>}{query.isPending && <p role="status">{en ? "Reading research history…" : "载入科研历程…"}</p>}
    <div className="research-history-list">{query.data?.items.map(event => <HistoryEntry key={event.id} event={event} en={en} />)}</div>
    {!query.isPending && !query.data?.items.length && <div className="research-empty research-record-empty"><Network size={30} /><h2>{en ? "No research events" : "暂无科研事件"}</h2></div>}
    <footer className="research-pagination"><button className="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 40))}>{en ? "Previous" : "上一页"}</button><button className="button" disabled={query.data?.nextOffset == null} onClick={() => setOffset(query.data!.nextOffset!)}>{en ? "Next" : "下一页"}</button></footer>
  </div>;
}
export function HistoryEntry({ event, en }: { event: HistoryEvent; en: boolean }) {
  const Icon = event.kind.endsWith("deleted") ? Trash2 : event.category === "proposals" ? GitPullRequest : event.category === "groups" ? Layers : event.category === "records" || event.category === "series" ? FileText : Network;
  const subjects = event.changes.slice(0, 3).map(change => text(change.subject.label, en)).join(" · ");
  const initiator = event.initiatedBy && (event.initiatedBy.id !== event.actor.id || event.initiatedBy.type !== event.actor.type) ? event.initiatedBy : null;
  return <Link to={`/records/history/${event.id}`} className={`research-history-entry outcome-${event.outcome}`}><span className="research-history-icon" aria-hidden="true"><Icon size={17} /></span><div><header><strong title={event.actor.name}>{event.actor.name}</strong><span className="research-history-action">{historyKinds[event.kind]?.[en ? "en" : "zh"] ?? event.kind}</span><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString(en ? "en-GB" : "zh-CN")}</time><span className="research-badge">{historyOutcomes[event.outcome]?.[en ? 1 : 0] ?? event.outcome}</span></header>
    <div className="research-history-details"><span className="research-history-subjects" title={subjects}>{subjects}{event.changeCount > 3 && ` +${event.changeCount - 3}`}</span>{event.reason && <span className="research-history-reason" title={event.reason}>{event.reason}</span>}{initiator && <span className="research-history-origin">{en ? "Initiated by " : "发起方："}{initiator.name}{initiator.type === "agent" ? " · Agent" : ""}</span>}{event.proposal && <span className="research-history-proposal">{en ? "Proposal" : "提议"} v{event.proposal.revision}</span>}</div>
  </div></Link>;
}
