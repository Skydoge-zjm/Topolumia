import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, CircleAlert, GitPullRequest, BookOpen, ListTodo, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { activityKinds } from "@domain/research/node-fields";
import { api, projectId } from "@/shared/lib/api";
import { PageHeader as Header } from "@/shared/layout/PageHeader";
import { useUiStore } from "@/shared/state/ui";
import type { CollaborationContext, ResearchContext } from "@/shared/types/api";
import { useAgentSessions } from "@/features/agents/sessions/agentQueries";
import { HistoryEntry } from "@/features/research/history/ResearchHistoryPanel";
import type { HistoryEvent } from "@/features/research/history/model";
import { nodeUrl, text, type ResearchRecord } from "@/features/research/model";
import { FAMILY_ORDER, familyColor, familyLabels } from "@/features/topology/model/nodeVisuals";
import { researchConnections, openActions, ratio, researchStructure, upcoming, type Topology } from "./overviewModel";
import styles from "./OverviewPage.module.css";

export function OverviewPage() {
  const en = useUiStore(state => state.locale) === "en";
  const project = projectId();
  const topology = useQuery({ queryKey: ["topology", project], queryFn: () => api<Topology>("/api/topology") });
  const history = useQuery({
    queryKey: ["research-history", project, "overview"],
    queryFn: () => api<{ items: HistoryEvent[]; total: number }>("/api/research-history?limit=8"),
    refetchInterval: 10000,
  });
  const records = useQuery({
    queryKey: ["research-records", project, "overview"],
    queryFn: () => api<{ items: ResearchRecord[]; total: number }>("/api/research-records?limit=100"),
  });
  const context = useQuery({ queryKey: ["research-context", project], queryFn: () => api<ResearchContext>("/api/research/context") });
  const sessions = useAgentSessions();
  const collaboration = useQuery({ queryKey: ["collaboration-context", project], queryFn: () => api<CollaborationContext>("/api/collaboration/context") });

  const graph: Topology = { nodes: topology.data?.nodes ?? [], edges: topology.data?.edges ?? [], groups: topology.data?.groups ?? [] };
  const structure = researchStructure(graph);
  const health = researchConnections(graph);
  const actions = openActions(records.data?.items ?? []);
  const planned = upcoming(records.data?.items ?? []).slice(0, 4);
  const notes = graph.nodes.filter(node => node.kind === "note").slice(0, 5);
  const pending = (context.data?.candidates ?? []).filter(item => ["pending", "deferred"].includes(String(item.status)));
  const running = (sessions.data?.sessions ?? []).filter(session => session.status === "running" && !session.archived);
  const overdue = actions.filter(action => action.overdue);
  const name = (id: string) => text(graph.nodes.find(node => node.id === id)?.label, en);
  const latest = history.data?.items[0]?.occurredAt;
  const time = (value: string) => new Date(value).toLocaleString(en ? "en-GB" : "zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

  return (
    <section className={styles.page}>
      <Header
        title="研究总览"
        action={
          <dl className={styles.meta}>
            <div><dt>{en ? "Project" : "项目"}</dt><dd>{collaboration.data?.project?.name ?? "—"}</dd></div>
            <div><dt>{en ? "Last change" : "最近变更"}</dt><dd>{latest ? time(latest) : "—"}</dd></div>
          </dl>
        }
      />
      <nav className={styles.attention} aria-label={en ? "Needs attention" : "待处理"}>
        <Signal icon={GitPullRequest} label={en ? "Changes to review" : "待审变更"} count={pending.length}
          to={pending[0] ? `/agents?candidate=${encodeURIComponent(String(pending[0].id))}` : "/agents"} />
        <Signal icon={Sparkles} label={en ? "Agents running" : "运行中的会话"} count={running.length} tone="live" to="/agents" />
        <Signal icon={ListTodo} label={en ? "Overdue actions" : "逾期行动"} count={overdue.length}
          to={overdue[0] ? `/records/${encodeURIComponent(overdue[0].recordId)}` : "/records"} />
        <Signal icon={CircleAlert} label={en ? "Contested objects" : "存在反驳的对象"} count={health.contested.length}
          to={health.contested[0] ? nodeUrl(health.contested[0]) : "/topology"} />
      </nav>
      <div className={styles.grid}>
        <div className={styles.column}>
          <section className={styles.panel} aria-labelledby="overview-structure">
            <header>
              <h2 id="overview-structure">{en ? "Research structure" : "研究结构"}</h2>
              <Link className="text-link" to="/topology">{en ? "Open topology" : "打开拓扑"}</Link>
            </header>
            <dl className={styles.totals}>
              <div><dt>{en ? "Objects" : "科研对象"}</dt><dd>{structure.nodes}</dd></div>
              <div><dt>{en ? "Node groups" : "节点组"}</dt><dd>{structure.groups}</dd></div>
              <div><dt>{en ? "Relations" : "科研关系"}</dt><dd>{structure.relations}</dd></div>
            </dl>
            {structure.nodes > 0 && (
              <>
                <div className={styles.composition} role="img"
                  aria-label={FAMILY_ORDER.map(family => `${familyLabels[family][en ? 1 : 0]} ${structure.families[family]}`).join(", ")}>
                  {FAMILY_ORDER.filter(family => structure.families[family]).map(family => (
                    <i key={family} style={{ flexGrow: structure.families[family], background: familyColor(family) }}
                      title={`${familyLabels[family][en ? 1 : 0]} · ${structure.families[family]}`} />
                  ))}
                </div>
                <ul className={styles.legend}>
                  {FAMILY_ORDER.map(family => (
                    <li key={family} data-empty={structure.families[family] ? undefined : "true"}>
                      <i style={{ background: familyColor(family) }} aria-hidden="true" />
                      <span>{familyLabels[family][en ? 1 : 0]}</span>
                      <b>{structure.families[family]}</b>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {!structure.nodes && !topology.isPending && <p className={styles.empty}>{en ? "No research objects yet." : "尚无科研对象。"}</p>}
          </section>
          <section className={styles.panel} aria-labelledby="overview-argument">
            <header><h2 id="overview-argument">{en ? "Object connections" : "对象关联"}</h2></header>
            <Meter label={en ? "Connected experiments" : "已关联的实验"} value={health.experiments} />
            <Meter label={en ? "Connected notes" : "已关联的笔记"} value={health.notes} />
            <Meter label={en ? "Objects in the graph" : "已接入关系或节点组的对象"} value={health.connected} />
            {health.isolated.length > 0 && (
              <p className={styles.isolated}>
                <span>{en ? "Unconnected" : "未接入"}</span>
                {health.isolated.slice(0, 4).map(id => <Link key={id} to={nodeUrl(id)}>{name(id)}</Link>)}
                {health.isolated.length > 4 && <span>+{health.isolated.length - 4}</span>}
              </p>
            )}
          </section>
          <section className={styles.panel} aria-labelledby="overview-history">
            <header>
              <h2 id="overview-history">{en ? "Recent research activity" : "最近科研活动"}</h2>
              <Link className="text-link" to="/records">{en ? "All history" : "全部历程"}</Link>
            </header>
            <div className={`research-history-list ${styles.history}`}>
              {history.data?.items.map(event => <HistoryEntry key={event.id} event={event} en={en} />)}
            </div>
            {!history.isPending && !history.data?.items.length && <p className={styles.empty}>{en ? "No research events yet." : "尚无科研事件。"}</p>}
          </section>
        </div>
        <aside className={styles.column}>
          <section className={styles.panel} aria-labelledby="overview-notes">
            <header><h2 id="overview-notes">{en ? "Research notes" : "研究笔记"}</h2></header>
            <ul className={styles.list}>
              {notes.map(node => (
                <li key={node.id}>
                  <BookOpen size={15} aria-hidden="true" />
                  <Link to={nodeUrl(node.id)}>{text(node.label, en)}</Link>
                </li>
              ))}
            </ul>
            {!notes.length && !topology.isPending && <p className={styles.empty}>{en ? "No notes recorded." : "尚未记录研究笔记。"}</p>}
          </section>
          <section className={styles.panel} aria-labelledby="overview-actions">
            <header>
              <h2 id="overview-actions">{en ? "Open actions" : "待办行动"}</h2>
              {actions.length > 0 && <span className={styles.count}>{actions.length}</span>}
            </header>
            <ul className={styles.list}>
              {actions.slice(0, 6).map((action, index) => (
                <li key={`${action.recordId}-${index}`} data-overdue={action.overdue || undefined}>
                  <ListTodo size={15} aria-hidden="true" />
                  <Link to={`/records/${encodeURIComponent(action.recordId)}`} title={action.recordTitle}>{action.text}</Link>
                  <small>{[action.assignee, action.dueDate].filter(Boolean).join(" · ")}</small>
                </li>
              ))}
            </ul>
            {!actions.length && !records.isPending && <p className={styles.empty}>{en ? "No open actions." : "没有待办行动。"}</p>}
          </section>
          <section className={styles.panel} aria-labelledby="overview-upcoming">
            <header><h2 id="overview-upcoming">{en ? "Upcoming" : "即将进行"}</h2></header>
            <ul className={styles.list}>
              {planned.map(record => (
                <li key={record.id}>
                  <CalendarClock size={15} aria-hidden="true" />
                  <Link to={`/records/${encodeURIComponent(record.id)}`}>{record.title}</Link>
                  <small>{activityKinds[record.type]?.[en ? 1 : 0]} · {time(record.scheduledAt!)}</small>
                </li>
              ))}
            </ul>
            {!planned.length && !records.isPending && <p className={styles.empty}>{en ? "Nothing scheduled." : "暂无安排。"}</p>}
          </section>
        </aside>
      </div>
    </section>
  );
}

function Meter({ label, value }: { label: string; value: { done: number; total: number } }) {
  const percent = ratio(value);
  return (
    <div className={styles.meter}>
      <span>{label}</span>
      <b>{value.total ? `${value.done} / ${value.total}` : "—"}</b>
      <i role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={value.total} aria-valuenow={value.done}>
        <em style={{ width: `${percent ?? 0}%` }} />
      </i>
    </div>
  );
}

function Signal({ icon: Icon, label, count, to, tone = "alert" }: { icon: LucideIcon; label: string; count: number; to: string; tone?: "alert" | "live" }) {
  return (
    <Link className={styles.signal} to={to} data-active={count > 0 ? tone : undefined}>
      <Icon size={16} aria-hidden="true" />
      <span>{label}</span>
      <strong>{count}</strong>
    </Link>
  );
}
