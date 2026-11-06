import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, CalendarDays, FileText } from "lucide-react";
import { activityKinds, recordStatuses } from "@domain/research/node-fields";
import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { useResearchPermissions } from "../useResearch";
import type { ResearchRecord } from "../model";
import { SeriesManager } from "./SeriesManager";
import { ResearchHistoryPanel } from "../history/ResearchHistoryPanel";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
export function ResearchRecordsPage() {
  const en = useUiStore(state => state.locale) === "en", permissions = useResearchPermissions();
  const [tab, setTab] = useState("history"), [search, setSearch] = useState(""), [type, setType] = useState(""), [status, setStatus] = useState(""), [offset, setOffset] = useState(0);
  const query = useQuery({ queryKey: ["research-records", projectId(), search, type, status, offset], queryFn: () => api<{ items: ResearchRecord[]; total: number; nextOffset: number | null }>(`/api/research-records?${new URLSearchParams({ q: search, type, status, offset: String(offset) })}`) });
  return <section translate="no" className="research-workspace research-records-page"><header className="research-page-heading"><div><h1>{en ? "Research records" : "研究记录"}</h1></div>{permissions.records && <Link className="button primary" to="/records/new"><Plus size={16} />{en ? "New record" : "新建记录"}</Link>}</header>
    <nav className="research-tabs" aria-label={en ? "Research record views" : "研究记录视图"}><button className={tab === "history" ? "is-active" : ""} onClick={() => setTab("history")}>{en ? "Research history" : "科研历程"}</button><button className={tab === "records" ? "is-active" : ""} onClick={() => setTab("records")}><FileText size={16} />{en ? "Minutes and notes" : "纪要与记录"}</button><button className={tab === "series" ? "is-active" : ""} onClick={() => setTab("series")}><CalendarDays size={16} />{en ? "Recurring activities" : "周期活动"}</button></nav>
    {tab === "history" ? <ResearchHistoryPanel en={en} /> : tab === "series" ? <SeriesManager en={en} canEdit={permissions.records} /> : <><div className="research-toolbar"><input aria-label={en ? "Search research records" : "搜索研究记录"} placeholder={en ? "Search minutes, conclusions or participants…" : "搜索纪要、结论或参与者…"} value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} /><SelectMenu ariaLabel={en ? "Filter activity type" : "筛选活动类型"} value={type} onChange={value => { setType(value); setOffset(0); }} options={[{ value: "", label: en ? "All activity types" : "全部活动类型" }, ...Object.entries(activityKinds).map(([value, labels]) => ({ value, label: labels[en ? 1 : 0] }))]} /><SelectMenu ariaLabel={en ? "Filter record status" : "筛选记录状态"} value={status} onChange={value => { setStatus(value); setOffset(0); }} options={[{ value: "", label: en ? "All statuses" : "全部状态" }, ...Object.entries(recordStatuses).map(([value, labels]) => ({ value, label: labels[en ? 1 : 0] }))]} /><span>{query.data?.total ?? 0} {en ? "records" : "条记录"}</span></div>
      {query.error && <p role="alert">{query.error.message}<button className="button" onClick={() => void query.refetch()}>{en ? "Retry" : "重试"}</button></p>}{query.isPending && <LoadingSkeleton layout="rows" label={en ? "Loading records…" : "载入研究记录…"} />}
      <div className="research-record-timeline">{query.data?.items.map(record => <Link className="research-record-card" key={record.id} to={`/records/${record.id}`}><div className="research-record-date"><CalendarDays size={17} /><time dateTime={record.occurredAt ?? record.scheduledAt ?? record.createdAt}>{new Date(record.occurredAt ?? record.scheduledAt ?? record.createdAt).toLocaleDateString(en ? "en-GB" : "zh-CN", { timeZone: record.timezone, year: "numeric", month: "2-digit", day: "2-digit" })}</time></div><div><h2>{record.title}</h2>{record.excerpt && <p title={record.excerpt}>{record.excerpt}</p>}<footer><div className="research-record-labels"><span className="research-badge">{activityKinds[record.type]?.[en ? 1 : 0]}</span><span className="research-badge">{recordStatuses[record.status]?.[en ? 1 : 0]}</span>{record.seriesId && <small>{en ? "Recurring activity" : "周期活动场次"}</small>}</div><span>{record.participants.join(" · ") || record.author?.name}</span><span>{record.actions.filter(action => action.status === "open").length} {en ? "open actions" : "项待完成行动"}</span></footer></div></Link>)}</div>
      {!query.isPending && !query.error && !query.data?.items.length && <div className="research-empty research-record-empty"><FileText size={32} /><h2>{en ? "No research records" : "暂无研究记录"}</h2>{permissions.records && <Link className="button" to="/records/new">{en ? "Create record" : "新建记录"}</Link>}</div>}
      <footer className="research-pagination"><button className="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 40))}>{en ? "Previous" : "上一页"}</button><button className="button" disabled={query.data?.nextOffset == null} onClick={() => setOffset(query.data!.nextOffset!)}>{en ? "Next" : "下一页"}</button></footer>
    </>}
  </section>;
}
