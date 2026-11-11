import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { groupRef, nodeRef, objectKey } from "@domain/research/object-ref";
import { text } from "@/features/research/model";
import type { Group, ResearchNode, ResearchObjectRef } from "@/features/research/model";
import { groupMembers } from "./model/groupProjection";
import { kindColor, kindIcon } from "./model/nodeVisuals";

const UNGROUPED_LIMIT = 60;

/**
 * The graph as a list. An open group here is an expanded group on the canvas, so
 * every row that is listed can also be located.
 */
export function TopologyOutline({ nodes, groups, expanded, selection, en, onToggle, onPick }: {
  /** Nodes that pass the current search and kind filters. */
  nodes: ResearchNode[]; groups: Group[]; expanded: string[]; selection: string[]; en: boolean;
  onToggle: (groupId: string) => void; onPick: (object: ResearchObjectRef, additive: boolean) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const grouped = useMemo(() => new Set(groups.flatMap(group => group.members.map(member => member.nodeId))), [groups]);
  const roots = groups.filter(group => !group.parentId || !groups.some(parent => parent.id === group.parentId));
  const ungrouped = nodes.filter(node => !grouped.has(node.id));
  const additive = (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => event.ctrlKey || event.metaKey || event.shiftKey;

  const nodeRow = (node: ResearchNode, depth: number, keyPrefix = "") => {
    const Icon = kindIcon(node.kind), key = objectKey(nodeRef(node.id));
    return (
      <li key={keyPrefix + node.id}>
        <button className={"topology-outline-row" + (selection.includes(key) ? " is-selected" : "")} style={{ paddingLeft: 10 + depth * 14, "--kind": kindColor(node.kind) } as CSSProperties} aria-current={selection.includes(key) || undefined} onClick={event => onPick(nodeRef(node.id), additive(event))}>
          <Icon size={13} aria-hidden="true" /><span>{text(node.label, en)}</span>
        </button>
      </li>
    );
  };
  const groupRow = (group: Group, depth: number, seen: Set<string>): React.ReactNode => {
    if (seen.has(group.id)) return null;
    const open = expanded.includes(group.id), key = objectKey(groupRef(group.id)), name = group.core.nodeName;
    const children = groups.filter(child => child.parentId === group.id), members = group.members.map(member => byId.get(member.nodeId)).filter((node): node is ResearchNode => Boolean(node));
    const inScope = groupMembers(group.id, groups).filter(id => byId.has(id)).length;
    return (
      <li key={group.id}>
        <div className={"topology-outline-group" + (selection.includes(key) ? " is-selected" : "")} style={{ paddingLeft: 4 + depth * 14 }}>
          <button className="topology-outline-toggle" aria-expanded={open} aria-label={(open ? (en ? "Collapse " : "收起 ") : (en ? "Expand " : "展开 ")) + name} onClick={() => onToggle(group.id)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
          <button className="topology-outline-name" aria-current={selection.includes(key) || undefined} onClick={event => onPick(groupRef(group.id), additive(event))}><span>{name}</span></button>
          <span className="count">{inScope}</span>
        </div>
        {open && (children.length > 0 || members.length > 0) && <ul>
          {children.map(child => groupRow(child, depth + 1, new Set([...seen, group.id])))}
          {members.map(node => nodeRow(node, depth + 1, group.id + ":"))}
        </ul>}
      </li>
    );
  };

  return (
    <nav className="topology-outline" aria-label={en ? "Graph outline" : "拓扑大纲"}>
      {groups.length > 0 && <>
        <h2>{en ? "Node groups" : "节点组"}<span className="count">{groups.length}</span></h2>
        <ul className="topology-outline-tree">{roots.map(group => groupRow(group, 0, new Set()))}</ul>
      </>}
      {ungrouped.length > 0 && <>
        <h2>{groups.length ? (en ? "Ungrouped" : "未分组") : (en ? "Nodes" : "节点")}<span className="count">{ungrouped.length}</span></h2>
        <ul className="topology-outline-tree">{(showAll ? ungrouped : ungrouped.slice(0, UNGROUPED_LIMIT)).map(node => nodeRow(node, 0))}</ul>
        {!showAll && ungrouped.length > UNGROUPED_LIMIT && <button className="topology-outline-more" onClick={() => setShowAll(true)}>{en ? `Show all ${ungrouped.length}` : `显示全部 ${ungrouped.length} 个`}</button>}
      </>}
    </nav>
  );
}
