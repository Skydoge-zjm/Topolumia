import ELK from "elkjs/lib/elk-api.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { ArrowDownRight, ArrowLeft, ArrowUpLeft, ChevronDown, ChevronRight, ExternalLink, Focus, Layers, Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import { Link } from "react-router-dom";
import { nodeKinds } from "@domain/research/node-fields";
import { groupRef, objectKey } from "@domain/research/object-ref";
import { objectUrl, text } from "@/features/research/model";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { cameraForFrame, GROUP_PADDING, layoutBounds, layoutGroupContainers } from "./model/groupProjection";
import { chipWidth, familyColor, nodeVisual } from "./model/nodeVisuals";
import type { Arrange, Camera, ContainerLayout, DisplayNode, Frame, GraphEdge, GroupProjection } from "./model/groupProjection";

type Point = { x: number; y: number };
type GroupAction = { id: string; kind: "expand" | "collapse" | "focus" | "overview"; sequence: number; previousExpanded?: string[] };
type NavigationEntry = { id: string; camera: Camera; layout: ContainerLayout; previousFocus: string | null; collapseOnReturn: boolean; previousExpanded?: string[] };
type SavedPoint = Point & { parentId?: string };
const EMPTY_LAYOUT: ContainerLayout = { frames: {}, roots: [] };
const MIN_SCALE = 0.3, MAX_SCALE = 1.8;
const transform = (camera: Camera) => `translate(${camera.x}px,${camera.y}px) scale(${camera.scale})`;
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(Math.max(minimum, maximum), value));
/** World type scale that keeps on-screen text near constant: text is not magnified with the map. */
const typeScale = (scale: number) => clamp(0.4, 1.25, scale ** 0.8);

function isWithin(id: string, ancestor: string, frames: Record<string, Frame>) {
  let current: string | undefined = id;
  while (current) { if (current === ancestor) return true; current = frames[current]?.parentId; }
  return false;
}
function translateFrames(layout: ContainerLayout, id: string, dx: number, dy: number) {
  for (const [key, frame] of Object.entries(layout.frames)) if (isWithin(key, id, layout.frames)) { frame.x += dx; frame.y += dy; }
}
function applyPositions(layout: ContainerLayout, saved: Record<string, SavedPoint>) {
  const depth = (id: string) => { let n = 0, current = layout.frames[id]?.parentId; while (current) { n++; current = layout.frames[current]?.parentId; } return n; };
  for (const id of Object.keys(layout.frames).sort((a, b) => depth(a) - depth(b))) {
    const point = saved[id], frame = layout.frames[id];
    if (!point || point.parentId !== frame.parentId || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const parent = frame.parentId ? layout.frames[frame.parentId] : undefined;
    const x = parent ? parent.x + clamp(point.x, GROUP_PADDING.left, parent.width - GROUP_PADDING.right - frame.width) : point.x;
    const y = parent ? parent.y + clamp(point.y, GROUP_PADDING.top, parent.height - GROUP_PADDING.bottom - frame.height) : point.y;
    translateFrames(layout, id, x - frame.x, y - frame.y);
  }
}
function positionsOf(layout: ContainerLayout): Record<string, SavedPoint> {
  return Object.fromEntries(Object.entries(layout.frames).map(([id, frame]) => {
    const parent = frame.parentId ? layout.frames[frame.parentId] : undefined;
    return [id, { x: frame.x - (parent?.x ?? 0), y: frame.y - (parent?.y ?? 0), parentId: frame.parentId }];
  }));
}
function edgePoints(from: Frame, to: Frame) {
  const boundary = (a: Frame, b: Frame) => {
    const center = { x: a.x + a.width / 2, y: a.y + a.height / 2 }, dx = b.x + b.width / 2 - center.x, dy = b.y + b.height / 2 - center.y;
    const factor = 1 / Math.max(Math.abs(dx) / Math.max(1, a.width / 2), Math.abs(dy) / Math.max(1, a.height / 2), 0.001);
    return { x: center.x + dx * factor, y: center.y + dy * factor };
  };
  const a = boundary(from, to), b = boundary(to, from), horizontal = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
  const path = horizontal ? `M ${a.x} ${a.y} C ${(a.x + b.x) / 2} ${a.y},${(a.x + b.x) / 2} ${b.y},${b.x} ${b.y}` : `M ${a.x} ${a.y} C ${a.x} ${(a.y + b.y) / 2},${b.x} ${(a.y + b.y) / 2},${b.x} ${b.y}`;
  return { path, label: { x: (a.x + b.x) / 2 + 6, y: (a.y + b.y) / 2 - 8 } };
}

export function TopologyCanvas({ graph, en, onOpen, onExpand, storageScope, selection, onSelect, groupAction, onRestoreExpanded }: {
  graph: GroupProjection; storageScope: string; selection?: string[]; onSelect?: (id: string) => void;
  en: boolean; onOpen: (node: DisplayNode) => void; onExpand: (id: string) => void; groupAction?: GroupAction; onRestoreExpanded?: (ids: string[]) => void;
}) {
  const canvas = useRef<HTMLDivElement>(null), world = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<ContainerLayout>(EMPTY_LAYOUT), layoutRef = useRef(EMPTY_LAYOUT);
  const [camera, setCamera] = useState<Camera>({ x: 30, y: 30, scale: 1 }), cameraRef = useRef(camera), animation = useRef<number | null>(null);
  const cameraFrame = useRef<number | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 }), [moving, setMoving] = useState(false);
  const [loading, setLoading] = useState(true), [layoutError, setLayoutError] = useState(false), [resetRevision, setResetRevision] = useState(0);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null), [highlighted, setHighlighted] = useState<string | null>(null);
  const [focusedGroup, setFocusedGroup] = useState<string | null>(null), focusedRef = useRef<string | null>(null);
  const navigation = useRef<NavigationEntry[]>([]), [navigationDepth, setNavigationDepth] = useState(0);
  const processedAction = useRef(0), pendingAction = useRef<{ action: GroupAction; restore?: NavigationEntry } | null>(null);
  const resetEpoch = useRef(resetRevision), initialized = useRef(false);
  const layoutShape = useRef("");
  const previewPositions = useRef(new Map<string, Record<string, Point>>());
  const suppressClick = useRef(false), drag = useRef<{ start: Point; camera: Camera; id?: string; layout: ContainerLayout; moved: boolean } | null>(null);
  const storageKey = `topolumia-container-layout:${storageScope}`;
  const viewport = useCallback(() => ({ width: canvas.current?.clientWidth ?? 1, height: canvas.current?.clientHeight ?? 1 }), []);
  const setFocus = useCallback((id: string | null) => { focusedRef.current = id; setFocusedGroup(id); }, []);
  const cancelCamera = useCallback(() => { if (animation.current !== null) { cancelAnimationFrame(animation.current); setCamera({ ...cameraRef.current }); } animation.current = null; setMoving(false); }, []);
  const publishCamera = useCallback(() => {
    if (cameraFrame.current === null) cameraFrame.current = requestAnimationFrame(() => {
      cameraFrame.current = null;
      setCamera({ ...cameraRef.current });
    });
  }, []);
  const moveCamera = useCallback((next: Camera, animate = true) => {
    cancelCamera();
    const start = { ...cameraRef.current }, reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const apply = (value: Camera) => { cameraRef.current = value; if (world.current) world.current.style.transform = transform(value); };
    if (!animate || reduced) { apply(next); if (!initialized.current) setCamera(next); else publishCamera(); return; }
    const began = performance.now(); setMoving(true);
    const tick = (now: number) => {
      const progress = Math.min(1, (now - began) / 280), eased = 1 - (1 - progress) ** 3;
      const value = { x: start.x + (next.x - start.x) * eased, y: start.y + (next.y - start.y) * eased, scale: start.scale + (next.scale - start.scale) * eased };
      apply(value); setCamera(value);
      if (progress < 1) animation.current = requestAnimationFrame(tick);
      else { animation.current = null; setMoving(false); setCamera(next); }
    };
    animation.current = requestAnimationFrame(tick);
  }, [cancelCamera, publishCamera]);
  const rememberPreview = useCallback((scene: ContainerLayout, source: GroupProjection) => {
    for (const node of source.nodes) if (node.groupId && !node.collapsed && scene.frames[node.id]) {
      const container = scene.frames[node.id], points: Record<string, Point> = {};
      for (const member of node.previewNodes ?? []) {
        const frame = scene.frames[member.id];
        if (frame && isWithin(member.id, node.id, scene.frames)) points[member.id] = { x: clamp((frame.x + frame.width / 2 - container.x) / container.width, 0.03, 0.97), y: clamp((frame.y + frame.height / 2 - container.y - GROUP_PADDING.top) / Math.max(1, container.height - GROUP_PADDING.top), 0.03, 0.97) };
      }
      previewPositions.current.set(node.id, points);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true); setLayoutError(false);
    const reset = resetEpoch.current !== resetRevision; resetEpoch.current = resetRevision;
    const shape = JSON.stringify(graph.nodes.map(node => [node.id, node.layoutParentId, node.collapsed]));
    const shapeChanged = layoutShape.current !== shape; layoutShape.current = shape;
    if (groupAction && groupAction.sequence !== processedAction.current) {
      processedAction.current = groupAction.sequence; cancelCamera();
      const id = objectKey(groupRef(groupAction.id));
      if (groupAction.kind === "overview") { navigation.current=[]; pendingAction.current={action:groupAction}; setFocus(null); }
      else if (groupAction.kind === "collapse") {
        const index = navigation.current.map(entry => entry.id).lastIndexOf(id), restore = index >= 0 ? navigation.current[index] : undefined;
        if (index >= 0) navigation.current = navigation.current.slice(0, index);
        pendingAction.current = { action: groupAction, restore }; setFocus(restore?.previousFocus ?? null); if(restore?.previousExpanded)onRestoreExpanded?.(restore.previousExpanded);
      } else {
        if (Object.keys(layoutRef.current.frames).length && focusedRef.current !== id) navigation.current.push({ id, camera: { ...cameraRef.current }, layout: structuredClone(layoutRef.current), previousFocus: focusedRef.current, collapseOnReturn: true, previousExpanded: groupAction.previousExpanded });
        pendingAction.current = { action: groupAction }; setFocus(id);
      }
      setNavigationDepth(navigation.current.length);
    }
    const worker = new Worker(new URL("./topology-layout.worker.ts", import.meta.url), { type: "module" });
    const engine = new ELK({ workerFactory: () => worker });
    const arrange: Arrange = async (items, edges) => {
      const result = await engine.layout({ id: "scope", layoutOptions: { "elk.algorithm": "layered", "elk.direction": "DOWN", "elk.edgeRouting": "ORTHOGONAL", "elk.spacing.nodeNode": "48", "elk.layered.spacing.nodeNodeBetweenLayers": "90", "elk.aspectRatio": "1.5" }, children: items, edges: edges.map(edge => ({ id: edge.id, sources: [edge.from], targets: [edge.to] })) } as ElkNode);
      return { positions: Object.fromEntries((result.children ?? []).map(item => [item.id, { x: item.x ?? 0, y: item.y ?? 0 }])), width: result.width ?? 0, height: result.height ?? 0 };
    };
    const fallback: Arrange = async items => { const positions: Record<string, Point> = {}; let y = 0, width = 0; for (const item of items) { positions[item.id] = { x: 0, y }; y += item.height + 40; width = Math.max(width, item.width); } return { positions, width, height: Math.max(0, y - 40) }; };
    const finish = (scene: ContainerLayout) => {
      if (!alive) return;
      const pending = pendingAction.current;
      let saved: Record<string, SavedPoint> = {};
      if (pending?.restore) saved = positionsOf(pending.restore.layout);
      else if (!reset && !pending && (!initialized.current || !shapeChanged)) {
        if (initialized.current) saved = positionsOf(layoutRef.current);
        else try { saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}"); } catch { /* Use the measured layout. */ }
      }
      if (pending && !pending.restore && ["expand", "focus"].includes(pending.action.kind)) {
        try { const points: Record<string, SavedPoint> = JSON.parse(localStorage.getItem(storageKey) ?? "{}"); saved = Object.fromEntries(Object.entries(points).filter(([, point]) => Boolean(point.parentId))); }
        catch { /* Use freshly measured member positions. */ }
      }
      applyPositions(scene, saved); rememberPreview(scene, graph);
      if (pending?.restore) {
        let points: Record<string, SavedPoint> = {};
        try { points = JSON.parse(localStorage.getItem(storageKey) ?? "{}"); } catch { /* Replace unreadable saved coordinates. */ }
        localStorage.setItem(storageKey, JSON.stringify({ ...points, ...positionsOf(scene) }));
      }
      layoutRef.current = scene; setLayout(scene);
      if (pending?.restore) moveCamera(pending.restore.camera);
      else if (pending && ["expand","focus"].includes(pending.action.kind)) {
        const frame = scene.frames[objectKey(groupRef(pending.action.id))];
        if (frame) moveCamera(cameraForFrame(frame, viewport()));
      } else if (!initialized.current || reset || ["collapse","overview"].includes(pending?.action.kind ?? "")) moveCamera(cameraForFrame(layoutBounds(scene.frames, scene.roots), viewport(), 0.88, 1), initialized.current);
      else if (shapeChanged) { const active = focusedRef.current ? scene.frames[focusedRef.current] : undefined; moveCamera(cameraForFrame(active ?? layoutBounds(scene.frames, scene.roots), viewport(), active ? 0.8 : 0.88, active ? 1.8 : 1)); }
      initialized.current = true; pendingAction.current = null;
      if (reset) { navigation.current = []; setNavigationDepth(0); setFocus(null); }
      setLoading(false);
    };
    void layoutGroupContainers(graph, arrange).catch(() => { if (alive) setLayoutError(true); return layoutGroupContainers(graph, fallback); }).then(finish).finally(() => worker.terminate());
    return () => { alive = false; worker.terminate(); };
  }, [graph, groupAction, resetRevision, storageKey, cancelCamera, moveCamera, rememberPreview, setFocus, viewport, onRestoreExpanded]);
  useEffect(() => {
    const element = canvas.current; if (!element) return;
    const observer = new ResizeObserver(() => {
      const size = viewport(); setViewportSize(previous => previous.width === size.width && previous.height === size.height ? previous : size);
      const scene = layoutRef.current;
      if (!Object.keys(scene.frames).length) return;
      const frame = focusedRef.current ? scene.frames[focusedRef.current] : undefined;
      moveCamera(cameraForFrame(frame ?? layoutBounds(scene.frames, scene.roots), size, frame ? 0.8 : 0.88, frame ? 1.8 : 1), false);
    });
    observer.observe(element); return () => observer.disconnect();
  }, [moveCamera, viewport]);
  useEffect(() => {
    const element = canvas.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as Element).closest(".research-dialog, .research-canvas-controls, .topology-camera-trail")) return;
      event.preventDefault(); const rect = element.getBoundingClientRect(), current = cameraRef.current;
      const next = clamp(current.scale * Math.exp(-event.deltaY * 0.0017), MIN_SCALE, MAX_SCALE), point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      moveCamera({ scale: next, x: point.x - (point.x - current.x) * next / current.scale, y: point.y - (point.y - current.y) * next / current.scale }, false);
    };
    element.addEventListener("wheel", wheel, { passive: false }); return () => element.removeEventListener("wheel", wheel);
  }, [moveCamera]);
  useEffect(() => () => { if (animation.current !== null) cancelAnimationFrame(animation.current); if (cameraFrame.current !== null) cancelAnimationFrame(cameraFrame.current); }, []);

  const startDrag = (event: ReactPointerEvent<HTMLElement>, id?: string) => {
    if (event.button !== 0) return;
    event.stopPropagation(); cancelCamera(); suppressClick.current = false;
    drag.current = { start: { x: event.clientX, y: event.clientY }, camera: { ...cameraRef.current }, id, layout: structuredClone(layoutRef.current), moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const focus = (id: string) => {
    const frame = layoutRef.current.frames[id]; if (!frame) return;
    if (focusedRef.current !== id) navigation.current.push({ id, camera: { ...cameraRef.current }, layout: structuredClone(layoutRef.current), previousFocus: focusedRef.current, collapseOnReturn: false });
    setFocus(id); setNavigationDepth(navigation.current.length); moveCamera(cameraForFrame(frame, viewport()));
  };
  const goBack = () => {
    const entry = navigation.current.at(-1), node = graph.nodes.find(node => node.id === (entry?.id ?? focusedRef.current));
    if (entry?.collapseOnReturn && node?.groupId && !node.collapsed) { onExpand(node.groupId); return; }
    if (!entry && node?.groupId && !node.collapsed) { onExpand(node.groupId); return; }
    if (entry) { navigation.current.pop(); setNavigationDepth(navigation.current.length); setFocus(entry.previousFocus); moveCamera(entry.camera); }
    else { setFocus(null); moveCamera(cameraForFrame(layoutBounds(layoutRef.current.frames, layoutRef.current.roots), viewport(), 0.88, 1)); }
  };
  const zoom = (factor: number) => { const size = viewport(), current = cameraRef.current, next = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE); moveCamera({ scale: next, x: size.width / 2 - (size.width / 2 - current.x) * next / current.scale, y: size.height / 2 - (size.height / 2 - current.y) * next / current.scale }); };
  const focusedNode = graph.nodes.find(node => node.id === focusedGroup), activeFrame = focusedGroup ? layout.frames[focusedGroup] : undefined;
  const visible = useMemo(() => {
    const margin = 300 / camera.scale;
    const area = { left: -camera.x / camera.scale - margin, top: -camera.y / camera.scale - margin, right: (viewportSize.width - camera.x) / camera.scale + margin, bottom: (viewportSize.height - camera.y) / camera.scale + margin };
    const intersects = (left: number, top: number, right: number, bottom: number) => right >= area.left && left <= area.right && bottom >= area.top && top <= area.bottom;
    const nodes = graph.nodes.filter(node => {
      const frame = layout.frames[node.id];
      return frame && (node.id === drag.current?.id || intersects(frame.x, frame.y, frame.x + frame.width, frame.y + frame.height));
    });
    const edges = graph.edges.filter(edge => {
      const from = layout.frames[edge.from], to = layout.frames[edge.to];
      return from && to && intersects(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.max(from.x + from.width, to.x + to.width), Math.max(from.y + from.height, to.y + to.height));
    });
    return { nodes, edges };
  }, [camera, graph, layout, viewportSize]);
  const depth = (id: string) => { let count = 0, parent = layout.frames[id]?.parentId; while (parent) { count++; parent = layout.frames[parent]?.parentId; } return count; };
  const containers = visible.nodes.filter(node => node.groupId).sort((a, b) => depth(a.id) - depth(b.id));
  const labels = new Map(graph.nodes.map(node => [node.id, text(node.label, en)]));
  const contexts = new Map<string, { id: string; label: string; x: number; y: number; incoming: boolean }>();
  if (focusedGroup && activeFrame && !moving) for (const edge of graph.edges) {
    const fromInside = isWithin(edge.from, focusedGroup, layout.frames), toInside = isWithin(edge.to, focusedGroup, layout.frames);
    if (fromInside === toInside) continue;
    const id = fromInside ? edge.to : edge.from, frame = layout.frames[id]; if (!frame) continue;
    const point = { x: camera.x + (frame.x + frame.width / 2) * camera.scale, y: camera.y + (frame.y + frame.height / 2) * camera.scale };
    if (point.x > 20 && point.x < viewportSize.width - 20 && point.y > 20 && point.y < viewportSize.height - 20) continue;
    const center = { x: viewportSize.width / 2, y: viewportSize.height / 2 }, dx = point.x - center.x, dy = point.y - center.y;
    const factor = Math.min((viewportSize.width / 2 - 90) / Math.max(1, Math.abs(dx)), (viewportSize.height / 2 - 34) / Math.max(1, Math.abs(dy)));
    contexts.set(id, { id, label: labels.get(id) ?? id, x: clamp(center.x + dx * factor, 90, viewportSize.width - 90), y: clamp(center.y + dy * factor, 34, viewportSize.height - 34), incoming: toInside });
  }

  const zoomLevel = camera.scale < 0.45 ? "far" : camera.scale < 0.72 ? "near" : "full";
  return <div className="research-graph-canvas container-topology-canvas" ref={canvas} data-camera-moving={String(moving)} data-camera-scale={camera.scale} data-camera-x={camera.x} data-camera-y={camera.y} data-zoom-level={zoomLevel} data-focused-group={focusedNode?.groupId ?? ""} style={{ "--graph-zoom": typeScale(camera.scale) } as CSSProperties} aria-label={en ? "Research topology canvas" : "科研拓扑画布"}
    onPointerDown={event => { if ((event.target as Element).closest("button,a,input,[role=button],.research-dialog")) return; startDrag(event); }}
    onPointerMove={event => {
      const current = drag.current; if (!current) return;
      const dx = event.clientX - current.start.x, dy = event.clientY - current.start.y;
      if (Math.abs(dx) + Math.abs(dy) <= 4 && !current.moved) return;
      current.moved = true; suppressClick.current = true;
      if (!current.id) { moveCamera({ ...current.camera, x: current.camera.x + dx, y: current.camera.y + dy }, false); return; }
      const original = current.layout.frames[current.id]; if (!original) return;
      let offsetX = dx / cameraRef.current.scale, offsetY = dy / cameraRef.current.scale;
      const parent = original.parentId ? current.layout.frames[original.parentId] : undefined;
      if (parent) { offsetX = clamp(original.x + offsetX, parent.x + GROUP_PADDING.left, parent.x + parent.width - GROUP_PADDING.right - original.width) - original.x; offsetY = clamp(original.y + offsetY, parent.y + GROUP_PADDING.top, parent.y + parent.height - GROUP_PADDING.bottom - original.height) - original.y; }
      const next = structuredClone(current.layout); translateFrames(next, current.id, offsetX, offsetY); layoutRef.current = next; setLayout(next);
    }}
    onPointerUp={() => { const current = drag.current; if (current?.moved && current.id) { localStorage.setItem(storageKey, JSON.stringify(positionsOf(layoutRef.current))); rememberPreview(layoutRef.current, graph); } drag.current = null; }}
    onPointerCancel={() => { drag.current = null; }}
    onKeyDown={event => { if (event.key === "Escape" && !selectedEdge && !(event.target as Element).closest(".research-dialog")) { event.stopPropagation(); goBack(); } }}>
    {loading && <span className="research-layout-status" role="status">{en ? "Arranging research objects…" : "正在整理容器布局…"}</span>}
    {layoutError && <span className="research-layout-status">{en ? "Using a compact fallback layout." : "已使用紧凑备用布局。"}</span>}
    {focusedNode && <div className="topology-camera-trail"><button onClick={goBack} aria-label={en ? "Back to previous view" : "返回上一级视角"}><ArrowLeft size={15} />{navigationDepth > 1 ? (en ? "Parent view" : "上一级") : (en ? "Previous view" : "返回")}</button><ChevronRight size={13} /><span>{text(focusedNode.label, en)}</span><button onClick={() => focus(focusedNode.id)} aria-label={en ? "Refocus container" : "重新对准容器"}><Focus size={15} /></button></div>}
    <div className="research-graph-world" ref={world} style={{ transform: transform(cameraRef.current) }}>
      {containers.map(node => { const frame = layout.frames[node.id]; return <div key={node.id} aria-hidden="true" data-container-id={node.object.id} data-depth={depth(node.id)} className={`topology-container-surface ${node.collapsed ? "is-collapsed" : "is-expanded"} ${focusedGroup === node.id ? "is-focused" : ""}`} style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height, zIndex: depth(node.id) }} />; })}
      <svg className="research-graph-edges" aria-label={en ? "Research relations" : "科研关系"}>
        <defs>
          <marker id="research-arrow" markerWidth="9" markerHeight="9" refX="7.5" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor" /></marker>
          <marker id="research-arrow-primary" markerWidth="10" markerHeight="10" refX="8" refY="3.4" orient="auto"><path d="M0,0 L0,6.8 L9,3.4 z" fill="#178d70" /></marker>
        </defs>
        {visible.edges.map(edge => {
          const a = layout.frames[edge.from], b = layout.frames[edge.to]; if (!a || !b) return null;
          if (focusedGroup && !isWithin(edge.from, focusedGroup, layout.frames) && !isWithin(edge.to, focusedGroup, layout.frames)) return null;
          const points = edgePoints(a, b), related = !highlighted || edge.from === focusedGroup || edge.to === focusedGroup || isWithin(edge.from, highlighted, layout.frames) || isWithin(edge.to, highlighted, layout.frames);
          const body = text(edge.label, en) || edge.type, prefix = edge.projected ? (en ? "Members · " : "成员 · ") : "", suffix = edge.edgeIds.length > 1 ? ` ×${edge.edgeIds.length}` : "";
          const label = `${prefix}${body}${suffix}`, width = chipWidth(label) / typeScale(camera.scale), height = 18 / typeScale(camera.scale);
          return <g key={edge.id} className={`research-graph-edge ${edge.projected ? "is-projected" : ""} ${edge.primary ? "is-primary" : ""} ${related ? "" : "is-muted"}`} role="button" tabIndex={0} aria-label={(edge.projected ? (en ? "Member relations: " : "成员关系：") : "") + body} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setSelectedEdge(edge); }} onKeyDown={event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); setSelectedEdge(edge); } }}>
            <path className="topology-edge-hit" d={points.path} fill="none" stroke="transparent" strokeWidth={16} vectorEffect="non-scaling-stroke" />
            {edge.primary && <path className="topology-edge-glow" d={points.path} fill="none" vectorEffect="non-scaling-stroke" />}
            <path className="topology-edge-line" d={points.path} markerEnd={edge.primary ? "url(#research-arrow-primary)" : "url(#research-arrow)"} vectorEffect="non-scaling-stroke" />
            {(zoomLevel === "full" || edge.primary) && <g className="topology-edge-label" transform={`translate(${points.label.x},${points.label.y})`}>
              <rect x={0} y={-height / 2} width={width} height={height} rx={height / 2} vectorEffect="non-scaling-stroke" />
              <text x={width / 2} y={0} textAnchor="middle" dominantBaseline="central" style={{ fontSize: 11 / typeScale(camera.scale) }}>{label}</text>
            </g>}
          </g>;
        })}
      </svg>
      {visible.nodes.map(node => {
        const frame = layout.frames[node.id]; if (!frame) return null;
        const sharedNames = node.sharedGroupIds?.map(id => labels.get(objectKey(groupRef(id)))).filter(Boolean).join(en ? ", " : "、");
        if (node.groupId) return <section key={node.id} className={`research-graph-node is-group topology-group-container ${node.collapsed ? "is-collapsed" : "is-expanded"} ${focusedGroup === node.id ? "is-focused" : ""}`} style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }} data-object-kind="group" data-object-id={node.object.id} data-collapsed={String(Boolean(node.collapsed))} data-layout-parent={frame.parentId ?? ""} data-depth={depth(node.id)} aria-label={text(node.label, en)} onMouseEnter={() => setHighlighted(node.id)} onMouseLeave={() => setHighlighted(null)}>
          {node.collapsed ? <button className="topology-group-preview" aria-label={`${en ? "Expand" : "展开"} ${text(node.label, en)}`} aria-expanded={false} onPointerDown={event => startDrag(event, node.id)} onClick={event => { if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return; } onExpand(node.groupId!); }}>
            <span className="topology-group-preview-head"><Layers size={13} aria-hidden="true" /><strong className="topology-group-preview-title">{text(node.label, en)}</strong></span>
            {zoomLevel !== "far" && <Miniature node={node} positions={previewPositions.current.get(node.id)} en={en} />}
            {zoomLevel !== "far" && <span className="topology-group-preview-foot"><span>{node.memberCount} {en ? "nodes" : "个节点"}{node.sharedCount ? (en ? ` · ${node.sharedCount} shared` : ` · ${node.sharedCount} 个共享`) : ""}</span><span className="topology-group-enter">{en ? "Open" : "展开"}<ChevronRight size={13} /></span></span>}
          </button> : <>
            <div className="topology-container-header" onPointerDown={event => { if (!(event.target as Element).closest("button,a")) startDrag(event, node.id); }}>
              <div className="topology-container-title"><Layers size={14} aria-hidden="true" /><h3 title={text(node.label, en)}>{text(node.label, en)}</h3><span className="topology-container-count">{node.memberCount} {en ? "nodes" : "个节点"}</span></div>
              <div className="topology-container-actions"><button aria-label={`${en ? "Focus" : "聚焦"} ${text(node.label, en)}`} title={en ? "Focus container" : "对准容器"} onClick={() => focus(node.id)}><Focus size={15} /></button><button aria-label={`${en ? "Group details" : "查看组详情"} ${text(node.label, en)}`} title={en ? "Group details" : "查看详情"} onClick={() => onOpen(node)}><ExternalLink size={15} /></button><button className="topology-collapse" aria-label={`${en ? "Collapse" : "收起"} ${text(node.label, en)}`} aria-expanded={true} title={en ? "Collapse group" : "收起节点组"} onClick={() => onExpand(node.groupId!)}><ChevronDown size={15} /><span>{en ? "Collapse" : "收起"}</span></button></div>
            </div>
            {!node.memberCount && <p className="topology-empty-container">{en ? "No members" : "暂无成员"}</p>}
          </>}
        </section>;
        const visual = nodeVisual(node.kind), Icon = visual.icon, nested = Boolean(frame.parentId);
        return <div key={node.id} className={`research-graph-node topology-member-node ${node.sharedGroupIds?.length ? "is-shared" : ""} ${nested ? "is-nested" : "is-root"}`} data-object-kind="node" data-object-id={node.object.id} data-layout-parent={frame.parentId ?? ""} data-family={visual.family} style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height, "--family": familyColor(visual.family) } as CSSProperties} onMouseEnter={() => setHighlighted(node.id)} onMouseLeave={() => setHighlighted(null)}>
          <button className="research-graph-node-main" onPointerDown={event => startDrag(event, node.id)} onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onOpen(node); }}>
            <span className="topology-node-head">{zoomLevel !== "far" && <span className="topology-node-icon" aria-hidden="true"><Icon size={14} /></span>}<strong title={text(node.summary, en)}>{text(node.label, en)}</strong></span>
            {zoomLevel !== "far" && <span className="topology-node-meta">{(en ? nodeKinds[node.kind]?.en : nodeKinds[node.kind]?.label) ?? node.kind}<i aria-hidden="true">·</i>{node.status}{node.sharedGroupIds?.length ? <><i aria-hidden="true">·</i>{en ? "shared" : "共享"}</> : null}</span>}
            {zoomLevel === "full" && sharedNames && <span className="topology-shared-membership" title={sharedNames}>{sharedNames}</span>}
          </button>
          {onSelect && zoomLevel === "full" && <input className="graph-node-select" type="checkbox" aria-label={`${en ? "Select" : "选择"} ${text(node.label, en)}`} checked={selection?.includes(node.object.id) ?? false} onPointerDown={event => event.stopPropagation()} onChange={() => onSelect(node.object.id)} />}
        </div>;
      })}
    </div>
    {[...contexts.values()].slice(0, 6).map(context => <button className="topology-context-link" key={context.id} style={{ left: context.x, top: context.y }} aria-label={`${en ? "Locate external object" : "定位外部对象"} ${context.label}`} onClick={() => { const frame = layout.frames[context.id]; if (frame) moveCamera(cameraForFrame(frame, viewport(), 0.6)); }}>{context.incoming ? <ArrowUpLeft size={13} /> : <ArrowDownRight size={13} />}<span>{context.label}</span></button>)}
    {selectedEdge && <ResearchDialog title={selectedEdge.projected ? (en ? "Projected member relations" : "成员关系投影") : (en ? "Research relation" : "科研关系")}  onClose={() => setSelectedEdge(null)}>{selectedEdge.origins.map(edge => <div className="group-relation-path" key={edge.id}><Link to={objectUrl(edge.from)}>{edge.fromLabel}</Link><span>{text(edge.label, en) || edge.type} →</span><Link to={objectUrl(edge.to)}>{edge.toLabel}</Link></div>)}</ResearchDialog>}
    <div className="research-canvas-controls"><button className="button" aria-label={en ? "Zoom out" : "缩小"} onClick={() => zoom(1 / 1.15)}><Minus size={15} /></button><span>{Math.round(camera.scale * 100)}%</span><button className="button" aria-label={en ? "Zoom in" : "放大"} onClick={() => zoom(1.15)}><Plus size={15} /></button><button className="button" aria-label={en ? "Fit graph" : "适配视图"} onClick={() => moveCamera(cameraForFrame(activeFrame ?? layoutBounds(layout.frames, layout.roots), viewport(), activeFrame ? 0.8 : 0.88, activeFrame ? 1.8 : 1))}><Maximize2 size={15} /></button><button className="button" aria-label={en ? "Reset layout" : "重置布局"} onClick={() => { localStorage.removeItem(storageKey); setResetRevision(value => value + 1); }}><RotateCcw size={15} /></button></div>
  </div>;
}

function Miniature({ node, positions, en }: { node: DisplayNode; positions?: Record<string, Point>; en: boolean }) {
  const members = node.previewNodes ?? [], columns = Math.max(1, Math.ceil(Math.sqrt(members.length * 1.25))), rows = Math.max(1, Math.ceil(members.length / columns));
  return <svg className="topology-group-miniature" viewBox="0 0 208 68" preserveAspectRatio="xMidYMid meet" aria-label={en ? `${members.length} node previews` : `${members.length} 个节点的缩略预览`}>
    {members.map((member, index) => { const point = positions?.[member.id] ?? { x: ((index % columns) + 0.5) / columns, y: (Math.floor(index / columns) + 0.5) / rows }; return <circle key={member.id} data-preview-node-id={member.id} data-kind={member.kind} data-family={nodeVisual(member.kind).family} className={member.shared ? "is-shared" : ""} cx={12 + point.x * 184} cy={7 + point.y * 54} r={members.length > 150 ? 1.8 : members.length > 40 ? 2.6 : 3.8}><title>{member.label}</title></circle>; })}
    {!members.length && <text x="104" y="38" textAnchor="middle">{en ? "Empty group" : "尚无成员"}</text>}
  </svg>;
}
