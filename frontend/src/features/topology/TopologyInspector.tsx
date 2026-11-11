import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronsDownUp, ChevronsUpDown, Layers, Spline, X } from "lucide-react";
import { Link } from "react-router-dom";
import { sameObject } from "@domain/research/object-ref";
import { api, projectId } from "@/shared/lib/api";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { objectUrl, text } from "@/features/research/model";
import type { Group, ResearchNode, ResearchObjectRef } from "@/features/research/model";
import { RunStatusDot } from "@/features/experiments/RunStatusDot";
import { RunStatusCounts } from "@/features/experiments/RunStrip";
import { contentBlockIcon, contentBlockLabel } from "./details/contentBlockPresentation";
import { PaperCitation } from "./details/PaperBibliography";
import { relationTypeLabel } from "./details/relationTypes";
import { kindColor, kindIcon, kindLabel } from "./model/nodeVisuals";

type RelationView = { id: string; from: ResearchObjectRef; to: ResearchObjectRef; type: string; label?: ResearchNode["label"]; other: { object: ResearchObjectRef; label: string; kind: string } };
type BlockView = { id: string; title: string; type: string; role?: string };
type NodeDetail = { node: ResearchNode; core: Record<string, any>; contentBlocks: BlockView[]; relations: RelationView[]; pendingCandidates?: unknown[] };
type GroupDetail = { group: Group; contentBlocks: BlockView[]; blockCount: number; relations: RelationView[]; counts: { directNodes: number; childGroups: number; recursiveUniqueNodes: number }; pendingCandidates?: unknown[] };
export type IndexedRun = { id: string; label: string; status: string };

/** A reading of one object beside the graph: enough to decide whether to open it. */
export function TopologyInspector({ object, en, runs, memberships = [], expanded, canEdit, onClose, onNavigate, onToggleGroup, onRelate }: {
  object: ResearchObjectRef; en: boolean; runs?: IndexedRun[];
  /** Groups that directly contain this object. */
  memberships?: Group[];
  expanded?: boolean; canEdit: boolean;
  onClose: () => void; onNavigate: (object: ResearchObjectRef) => void; onToggleGroup: (id: string) => void; onRelate: (object: ResearchObjectRef, label: string) => void;
}) {
  const group = object.kind === "group";
  // Shares its cache entry with the detail page, so opening the object afterwards is immediate.
  const query = useQuery({
    queryKey: [group ? "research-group" : "research-node", projectId(), object.id],
    queryFn: () => api<NodeDetail | GroupDetail>((group ? "/api/research-groups/" : "/api/research-nodes/") + encodeURIComponent(object.id)),
  });
  const data = query.data, kind = group ? "group" : (data as NodeDetail | undefined)?.node.kind ?? "note";
  const core: Record<string, any> = data ? (group ? (data as GroupDetail).group.core : (data as NodeDetail).core) : {};
  const title = (kind === "paper" && typeof core.paperTitle === "string" && core.paperTitle.trim()) || core.nodeName || (data && !group ? text((data as NodeDetail).node.label, en) : "");
  const summary = String((kind === "paper" ? core.abstract : core.summary) ?? "").trim();
  const tags: string[] = Array.isArray(core.tags) ? core.tags : [];
  const blocks = (data?.contentBlocks ?? []).filter(block => block.role !== "body"), blockTotal = group ? (data as GroupDetail | undefined)?.blockCount ?? blocks.length : blocks.length;
  const relations = data?.relations ?? [], pending = data?.pendingCandidates?.length ?? 0;
  const Icon = kindIcon(kind);
  return (
    <aside className="topology-inspector" translate="no" aria-label={en ? "Object preview" : "对象预览"} style={{ "--kind": kindColor(kind) } as CSSProperties}>
      <header className="topology-inspector-head">
        <span className="kind-mark"><Icon size={14} aria-hidden="true" />{kindLabel(kind, en)}</span>
        <button className="research-icon-button" aria-label={en ? "Close preview" : "关闭预览"} onClick={onClose}><X size={16} /></button>
      </header>
      {query.isPending && <LoadingSkeleton layout="rows" label={en ? "Loading preview…" : "正在读取预览…"} />}
      {query.error && !data && <p role="alert">{query.error.message}<button className="button" onClick={() => void query.refetch()}>{en ? "Retry" : "重试"}</button></p>}
      {data && <div className="topology-inspector-body">
        <h2>{title}</h2>
        {kind === "paper" && <PaperCitation core={core} en={en} />}
        {summary && <p className="topology-inspector-summary">{summary}</p>}
        {tags.length > 0 && <ul className="tag-list" aria-label={en ? "Tags" : "标签"}>{tags.map(tag => <li key={tag}>{tag}</li>)}</ul>}
        {pending > 0 && <p className="topology-inspector-pending">{en ? `${pending} proposed change(s) await review` : `${pending} 项待审变更`}</p>}

        {group && <dl className="topology-inspector-facts">
          <div><dt>{en ? "Direct members" : "直接成员"}</dt><dd>{(data as GroupDetail).counts.directNodes}</dd></div>
          <div><dt>{en ? "Subgroups" : "子组"}</dt><dd>{(data as GroupDetail).counts.childGroups}</dd></div>
          <div><dt>{en ? "Nodes in scope" : "范围内节点"}</dt><dd>{(data as GroupDetail).counts.recursiveUniqueNodes}</dd></div>
        </dl>}

        {kind === "experiment" && <section>
          <h3>{en ? "Runs" : "运行"}<span className="count">{runs?.length ?? 0}</span></h3>
          {runs?.length ? <>
            <RunStatusCounts runs={runs} en={en} />
            <ul className="topology-inspector-runs">{runs.slice(0, 8).map(run => <li key={run.id}><RunStatusDot status={run.status} en={en} withLabel={false} /><span>{run.label}</span></li>)}</ul>
            {runs.length > 8 && <p className="research-hint">{en ? `${runs.length - 8} more in the experiment` : `另有 ${runs.length - 8} 次，见实验详情`}</p>}
          </> : <p className="research-hint">{en ? "No run records. Results can still be kept as tables, figures or metrics." : "没有运行记录。结果仍可用表格、图片或指标保存。"}</p>}
        </section>}

        <section>
          <h3>{en ? "Relations" : "关系"}<span className="count">{relations.length}</span></h3>
          {relations.length ? <ul className="topology-inspector-relations">{relations.slice(0, 12).map(edge => {
            const outgoing = sameObject(edge.from, object), OtherIcon = kindIcon(edge.other.kind);
            return <li key={edge.id}>
              {outgoing ? <ArrowRight size={13} aria-label={en ? "to" : "指向"} /> : <ArrowLeft size={13} aria-label={en ? "from" : "来自"} />}
              <span className="relation-type">{text(edge.label, en) || relationTypeLabel(edge.type, en)}</span>
              <button className="object-link" style={{ "--kind": kindColor(edge.other.kind) } as CSSProperties} onClick={() => onNavigate(edge.other.object)}><OtherIcon size={13} aria-hidden="true" /><span>{edge.other.label}</span></button>
            </li>;
          })}</ul> : <p className="research-hint">{en ? "Not connected to other objects yet." : "尚未与其他对象建立关系。"}</p>}
          {relations.length > 12 && <p className="research-hint">{en ? `${relations.length - 12} more` : `另有 ${relations.length - 12} 条`}</p>}
        </section>

        {memberships.length > 0 && <section>
          <h3>{group ? (en ? "Parent group" : "上级组") : (en ? "In groups" : "所属节点组")}{!group && <span className="count">{memberships.length}</span>}</h3>
          <ul className="topology-inspector-relations">{memberships.map(item => <li key={item.id}><button className="object-link" style={{ "--kind": kindColor("group") } as CSSProperties} onClick={() => onNavigate({ kind: "group", id: item.id })}><Layers size={13} aria-hidden="true" /><span>{item.core.nodeName}</span></button></li>)}</ul>
        </section>}

        <section>
          <h3>{en ? "Material" : "研究材料"}<span className="count">{blockTotal}</span></h3>
          {blocks.length ? <ul className="topology-inspector-blocks">{blocks.slice(0, 8).map(block => { const BlockIcon = contentBlockIcon(block.type); return <li key={block.id}><BlockIcon size={13} aria-hidden="true" /><span>{block.title}</span><small>{contentBlockLabel(block.type, en)}</small></li>; })}</ul> : <p className="research-hint">{en ? "No material blocks." : "还没有内容块。"}</p>}
          {blockTotal > Math.min(8, blocks.length) && blocks.length > 0 && <p className="research-hint">{en ? `${blockTotal - Math.min(8, blocks.length)} more` : `另有 ${blockTotal - Math.min(8, blocks.length)} 个`}</p>}
        </section>
      </div>}
      <footer className="topology-inspector-actions">
        <Link className="button primary" to={objectUrl(object)}><ArrowUpRight size={15} />{en ? "Open details" : "打开详情"}</Link>
        {group && <button className="button" onClick={() => onToggleGroup(object.id)}>{expanded ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}{expanded ? (en ? "Collapse" : "收起") : (en ? "Expand" : "展开")}</button>}
        {canEdit && data && <button className="button" onClick={() => onRelate(object, title)}><Spline size={15} />{en ? "Add relation" : "添加关系"}</button>}
      </footer>
    </aside>
  );
}
