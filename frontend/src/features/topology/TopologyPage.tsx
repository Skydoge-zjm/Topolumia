import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChartLine, ChevronDown, Layers, PanelLeftClose, PanelLeftOpen, Plus, Search, X } from "lucide-react";
import { nodeRef, groupRef, objectKey } from "@domain/research/object-ref";
import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { useResearchPermissions } from "@/features/research/useResearch";
import { objectUrl, text } from "@/features/research/model";
import type { Group, ResearchNode, ResearchObjectRef } from "@/features/research/model";
import { ExperimentCompareDialog } from "@/features/experiments/ExperimentCompareDialog";
import type { ExperimentIndex } from "@/features/experiments/ExperimentCompareDialog";
import { RelationEditor } from "./details/RelationEditor";
import type { ResearchRelation } from "./details/RelationEditor";
import { GroupEditor } from "./groups/GroupEditor";
import { groupMembers, projectGroups } from "./model/groupProjection";
import { kindColor, kindIcon, kindLabel, NODE_KIND_ORDER } from "./model/nodeVisuals";
import { TopologyCanvas } from "./TopologyCanvas";
import type { GroupAction, LocateRequest } from "./TopologyCanvas";
import { TopologyInspector } from "./TopologyInspector";
import { TopologyOutline } from "./TopologyOutline";
import "./topology.css";

type Topology = { nodes: ResearchNode[]; edges: ResearchRelation[]; groups: Group[] };
const EMPTY_TOPOLOGY: Topology = { nodes: [], edges: [], groups: [] };
/** Records written before the three-kind model are read as notes. */
const kindOf = (kind: string) => (NODE_KIND_ORDER as readonly string[]).includes(kind) ? kind : "note";
const refOf = (key: string): ResearchObjectRef => { const [kind, id] = JSON.parse(key) as [ResearchObjectRef["kind"], string]; return { kind, id }; };

export function TopologyPage() { return <TopologyWorkspace key={projectId()} />; }

function TopologyWorkspace() {
  const en = useUiStore(state => state.locale) === "en", permissions = useResearchPermissions(), navigate = useNavigate(), client = useQueryClient(), [params, setParams] = useSearchParams();
  const query = useQuery({ queryKey: ["topology", projectId()], queryFn: () => api<Topology>("/api/topology") });
  const experiments = useQuery({ queryKey: ["research-experiments", projectId()], queryFn: () => api<ExperimentIndex>("/api/research-experiments") });
  const storageScope = permissions.actorId + ":" + projectId(), expandedKey = "topolumia-group-expanded:" + storageScope, outlineKey = "topolumia-topology-outline:" + storageScope;
  const [expanded, setExpanded] = useState<string[]>([]), [search, setSearch] = useState(""), [querySearch, setQuerySearch] = useState("");
  const [hiddenKinds, setHiddenKinds] = useState<string[]>([]), [selected, setSelected] = useState<string[]>([]), [outline, setOutline] = useState(true);
  const [groupEditor, setGroupEditor] = useState(false), [compareNodes, setCompareNodes] = useState<string[] | null>(null), [relating, setRelating] = useState<{ from: ResearchObjectRef; label: string; to?: ResearchObjectRef } | null>(null);
  const [groupAction, setGroupAction] = useState<GroupAction>(), [locate, setLocate] = useState<LocateRequest>();
  const actionSequence = useRef(0), handledFocusRequest = useRef<string | null>(null), searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem(expandedKey) ?? "[]"); setExpanded(Array.isArray(saved) ? saved : []); } catch { setExpanded([]); } }, [expandedKey]);
  useEffect(() => { setOutline(localStorage.getItem(outlineKey) !== "closed"); }, [outlineKey]);
  useEffect(() => { const timer = setTimeout(() => setQuerySearch(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || (event.target as Element).closest?.("input, textarea, [contenteditable], [role=dialog]")) return;
      event.preventDefault(); searchInput.current?.focus();
    };
    window.addEventListener("keydown", focusSearch); return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const focus = params.get("group") ?? "", { nodes, edges, groups } = query.data ?? EMPTY_TOPOLOGY;
  const persistExpanded = useCallback((ids: string[]) => { setExpanded(current => JSON.stringify(current) === JSON.stringify(ids) ? current : ids); localStorage.setItem(expandedKey, JSON.stringify(ids)); }, [expandedKey]);
  const ancestors = useCallback((groupId: string | null | undefined) => { const chain: string[] = []; let current = groupId; while (current && !chain.includes(current)) { chain.push(current); current = groups.find(group => group.id === current)?.parentId; } return chain; }, [groups]);

  // A link such as "focus in topology" opens the group and its ancestors, then frames it once.
  useEffect(() => {
    if (params.get("expand") !== "1") { handledFocusRequest.current = null; return; }
    if (!groups.some(group => group.id === focus) || handledFocusRequest.current === focus) return;
    handledFocusRequest.current = focus;
    const previousExpanded = [...expanded], next = [...new Set([...expanded, ...ancestors(focus)])];
    setExpanded(next); localStorage.setItem(expandedKey, JSON.stringify(next));
    setGroupAction({ id: focus, kind: "focus", sequence: ++actionSequence.current, previousExpanded });
    setParams({ group: focus }, { replace: true });
  }, [ancestors, expanded, expandedKey, focus, groups, params, setParams]);

  const kindCounts = useMemo(() => { const counts: Record<string, number> = {}; for (const node of nodes) counts[kindOf(node.kind)] = (counts[kindOf(node.kind)] ?? 0) + 1; return counts; }, [nodes]);
  const shownNodes = useMemo(() => hiddenKinds.length ? nodes.filter(node => !hiddenKinds.includes(kindOf(node.kind))) : nodes, [nodes, hiddenKinds]);
  const needle = querySearch.toLowerCase();
  const matchesText = useCallback((node: ResearchNode) => (text(node.label, en) + " " + text(node.summary, en) + " " + kindLabel(node.kind, en)).toLowerCase().includes(needle), [en, needle]);
  const graph = useMemo(() => {
    // Searching looks inside every group, so nothing stays folded while a query is active.
    const folding = needle ? [] : groups.filter(group => !expanded.includes(group.id)).map(group => group.id);
    const projection = projectGroups(shownNodes, edges, groups, folding);
    if (!needle) return projection;
    const matches = new Set(projection.nodes.filter(matchesText).map(node => node.id));
    for (const group of groups) {
      const members = groupMembers(group.id, groups), key = objectKey(groupRef(group.id));
      if (matches.has(key)) for (const id of members) matches.add(objectKey(nodeRef(id)));
      if (members.some(id => matches.has(objectKey(nodeRef(id))))) matches.add(key);
    }
    const nodesInView = projection.nodes.filter(node => matches.has(node.id)), visible = new Set(nodesInView.map(node => node.id));
    return { nodes: nodesInView, edges: projection.edges.filter(edge => visible.has(edge.from) && visible.has(edge.to)) };
  }, [shownNodes, edges, groups, expanded, needle, matchesText]);
  const outlineNodes = useMemo(() => needle ? shownNodes.filter(matchesText) : shownNodes, [shownNodes, needle, matchesText]);
  const runsByNode = useMemo(() => new Map((experiments.data?.items ?? []).map(item => [item.id, item.runs])), [experiments.data]);

  const toggleGroup = (id: string) => {
    const closing = expanded.includes(id), next = closing ? expanded.filter(item => item !== id) : [...new Set([...expanded, ...ancestors(id)])];
    setExpanded(next); localStorage.setItem(expandedKey, JSON.stringify(next));
    setGroupAction({ id, kind: closing ? "collapse" : "expand", sequence: ++actionSequence.current, previousExpanded: [...expanded] });
  };
  const select = useCallback((key: string | null, additive: boolean) => {
    setSelected(current => key === null ? [] : additive ? (current.includes(key) ? current.filter(item => item !== key) : [...current, key]) : current.length === 1 && current[0] === key ? current : [key]);
  }, []);
  /** Select an object from a list and make sure the canvas can show it. */
  const reveal = (object: ResearchObjectRef, additive = false) => {
    const key = objectKey(object);
    if (additive) { select(key, true); return; }
    const containing = object.kind === "group" ? groups.find(group => group.id === object.id)?.parentId : groups.find(group => group.members.some(member => member.nodeId === object.id))?.id;
    const chain = ancestors(containing);
    if (chain.some(id => !expanded.includes(id))) persistExpanded([...new Set([...expanded, ...chain])]);
    setSelected([key]); setLocate({ id: key, sequence: ++actionSequence.current });
  };
  const toggleKind = (kind: string) => setHiddenKinds(current => current.includes(kind) ? current.filter(item => item !== kind) : [...current, kind]);
  const toggleOutline = () => { localStorage.setItem(outlineKey, outline ? "closed" : "open"); setOutline(!outline); };

  const selectedRefs = selected.map(refOf), selectedNodeIds = selectedRefs.filter(ref => ref.kind === "node").map(ref => ref.id);
  const selectedExperiments = selectedNodeIds.filter(id => nodes.some(node => node.id === id && node.kind === "experiment"));
  const inspected = selected.length === 1 ? selectedRefs[0] : null;
  const filtered = Boolean(needle) || hiddenKinds.length > 0;
  const loadingGraph = query.isPending || Boolean(query.error && !query.data);

  return (
    <section translate="no" className={"research-workspace topology-workspace" + (outline ? "" : " is-outline-closed")}>
      <header className="topology-bar">
        <h1>{en ? "Research topology" : "科研拓扑"}</h1>
        <div className="topology-search">
          <Search size={15} aria-hidden="true" />
          <input ref={searchInput} aria-label={en ? "Search research objects" : "搜索科研对象"} placeholder={en ? "Search names and summaries" : "搜索名称、概要"} value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === "Escape" && search) { event.stopPropagation(); setSearch(""); } }} />
          {search ? <button className="research-icon-button" aria-label={en ? "Clear search" : "清除搜索"} onClick={() => { setSearch(""); searchInput.current?.focus(); }}><X size={14} /></button> : <kbd aria-hidden="true">/</kbd>}
        </div>
        <div className="topology-kinds" role="group" aria-label={en ? "Shown node types" : "显示的节点类型"}>
          {NODE_KIND_ORDER.map(kind => { const Icon = kindIcon(kind); return (
            <button key={kind} className="topology-kind" aria-pressed={!hiddenKinds.includes(kind)} style={{ "--kind": kindColor(kind) } as CSSProperties} onClick={() => toggleKind(kind)}>
              <Icon size={14} aria-hidden="true" /><span>{kindLabel(kind, en)}</span><span className="count">{kindCounts[kind] ?? 0}</span>
            </button>
          ); })}
        </div>
        {permissions.nodes && <div className="topology-bar-actions">
          <button className="button" onClick={() => setGroupEditor(true)}><Layers size={15} />{en ? "New group" : "新建节点组"}</button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild><button className="button primary"><Plus size={15} />{en ? "New node" : "新建节点"}<ChevronDown size={14} /></button></DropdownMenu.Trigger>
            <DropdownMenu.Portal><DropdownMenu.Content className="research-menu" align="end" sideOffset={6}>
              {NODE_KIND_ORDER.map(kind => { const Icon = kindIcon(kind); return <DropdownMenu.Item key={kind} className="research-menu-item" style={{ "--kind": kindColor(kind) } as CSSProperties} onSelect={() => navigate("/topology/new?kind=" + kind)}><Icon size={15} className="kind-icon" />{kindLabel(kind, en)}</DropdownMenu.Item>; })}
            </DropdownMenu.Content></DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>}
      </header>
      {query.error && <p role="alert">{query.error.message}<button className="button" onClick={() => void query.refetch()}>{en ? "Retry" : "重试"}</button></p>}

      <div className="topology-stage">
        {outline && <aside className="topology-rail">
          {query.isPending ? <LoadingSkeleton layout="rows" label={en ? "Loading outline…" : "正在读取大纲…"} />
            : <TopologyOutline nodes={outlineNodes} groups={groups} expanded={needle ? groups.map(group => group.id) : expanded} selection={selected} en={en} onToggle={toggleGroup} onPick={reveal} />}
          {!query.isPending && !outlineNodes.length && !groups.length && <p className="research-hint">{filtered ? (en ? "Nothing matches." : "没有匹配的对象。") : (en ? "Nothing here yet." : "还没有对象。")}</p>}
        </aside>}
        <div className="research-graph-panel">
          <button className="topology-rail-toggle" aria-label={outline ? (en ? "Hide outline" : "隐藏大纲") : (en ? "Show outline" : "显示大纲")} aria-expanded={outline} title={outline ? (en ? "Hide outline" : "隐藏大纲") : (en ? "Show outline" : "显示大纲")} onClick={toggleOutline}>{outline ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}</button>
          {loadingGraph ? <div className="research-graph-canvas container-topology-canvas">{query.isPending && <span className="research-layout-status" role="status">{en ? "Loading research topology…" : "正在读取科研拓扑…"}</span>}</div>
            : graph.nodes.length ? <TopologyCanvas graph={graph} en={en} storageScope={storageScope} groupAction={groupAction} locate={locate} runsByNode={runsByNode} selection={selected} onSelect={select} onRestoreExpanded={persistExpanded} onOpen={node => navigate(objectUrl(node.object))} onExpand={toggleGroup} onConnect={permissions.nodes ? (from, to) => { const source = graph.nodes.find(node => node.id === objectKey(from)); setRelating({ from, to, label: source ? text(source.label, en) : from.id }); } : undefined} />
            : <div className="research-graph-empty">
                {filtered ? <>
                  <h2>{en ? "No objects match this view" : "当前筛选下没有对象"}</h2>
                  <button className="button" onClick={() => { setSearch(""); setHiddenKinds([]); }}>{en ? "Clear search and filters" : "清除搜索与筛选"}</button>
                </> : <>
                  <h2>{en ? "Start the research graph" : "从第一个科研对象开始"}</h2>
                  {permissions.nodes && <div className="research-actions">{NODE_KIND_ORDER.map(kind => { const Icon = kindIcon(kind); return <button key={kind} className="button" style={{ "--kind": kindColor(kind) } as CSSProperties} onClick={() => navigate("/topology/new?kind=" + kind)}><Icon size={15} className="kind-icon" />{en ? "New " + kindLabel(kind, en).toLowerCase() : "新建" + kindLabel(kind, en)}</button>; })}</div>}
                </>}
              </div>}
          {selected.length > 1 && <div className="topology-selection-bar" role="toolbar" aria-label={en ? "Selected objects" : "已选对象"}>
            <span>{en ? `${selected.length} selected` : `已选 ${selected.length} 个`}</span>
            {permissions.nodes && selectedNodeIds.length > 0 && <button className="button" onClick={() => setGroupEditor(true)}><Layers size={15} />{en ? `Group ${selectedNodeIds.length} nodes` : `组成节点组（${selectedNodeIds.length}）`}</button>}
            {selectedExperiments.length >= 2 && <button className="button primary" onClick={() => setCompareNodes(selectedExperiments)}><ChartLine size={15} />{en ? `Compare ${selectedExperiments.length} experiments` : `进入比较（${selectedExperiments.length}）`}</button>}
            <button className="research-icon-button" aria-label={en ? "Clear selection" : "清除选择"} onClick={() => setSelected([])}><X size={15} /></button>
          </div>}
          {inspected && !loadingGraph && <TopologyInspector key={objectKey(inspected)} object={inspected} en={en} canEdit={permissions.nodes} runs={inspected.kind === "node" ? runsByNode.get(inspected.id) : undefined} expanded={inspected.kind === "group" && expanded.includes(inspected.id)} memberships={inspected.kind === "node" ? groups.filter(group => group.members.some(member => member.nodeId === inspected.id)) : groups.filter(group => group.id === groups.find(item => item.id === inspected.id)?.parentId)} onClose={() => setSelected([])} onNavigate={reveal} onToggleGroup={toggleGroup} onRelate={(from, label) => setRelating({ from, label })} />}
        </div>
      </div>

      {groupEditor && <GroupEditor groups={groups} nodes={nodes} initialMembers={selectedNodeIds} en={en} onClose={() => setGroupEditor(false)} onSaved={group => { setGroupEditor(false); setSelected([]); void client.invalidateQueries({ queryKey: ["topology", projectId()] }); navigate(objectUrl(groupRef(group.id))); }} />}
      {compareNodes && <ExperimentCompareDialog en={en} nodeIds={compareNodes} onClose={() => setCompareNodes(null)} />}
      {relating && <RelationEditor owner={relating.from} label={relating.label} initialTarget={relating.to} en={en} onClose={() => setRelating(null)} onSaved={() => { setRelating(null); for (const key of ["topology", "object-relations", "research-node", "research-group"]) void client.invalidateQueries({ queryKey: [key, projectId()] }); }} />}
    </section>
  );
}
