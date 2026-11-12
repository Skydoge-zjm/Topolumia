import { useState } from "react";
import type { ReactNode } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { objectBase } from "@/features/research/model";
import type { ResearchObjectRef } from "@/features/research/model";
import { ConfirmDialog } from "@/features/research/components/ConfirmDialog";
import { ContentBlockEditor } from "./ContentBlockEditor";
import { ContentBlockRenderer } from "./ContentBlockRenderer";
import type { ContentBlock } from "./ContentBlockRenderer";
import { ContentBlockProvenance } from "./ContentBlockProvenance";
import { blockTypeChoices, contentBlockIcon, contentBlockLabel } from "./contentBlockPresentation";
import { useUnsavedChanges } from "@/features/research/useResearch";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import "./details.css";

type Directory = { data: { items: ContentBlock[] }; page: { nextCursor: string | null; total: number } };
const PAGE_SIZE = 20;
/** `after` names the block the new one follows; without it the block is appended. */
type Adding = { after?: string; type?: string };

/**
 * `initialBlocks` comes from the object detail response, which already carries every block with its payload.
 * Reuse those payloads while mounting only the current page of material.
 *
 * With `rail`, the material sits beside a block outline and whatever the page adds under it.
 */
export function ObjectContentWorkspace({ owner, en, canEdit, allowAdd = true, collectionRevision, initialBlocks, hiddenBlockIds = [], nodeKind, onChanged, lead, rail }: {
  owner: ResearchObjectRef; en: boolean; canEdit: boolean; allowAdd?: boolean; collectionRevision: number; initialBlocks?: ContentBlock[]; hiddenBlockIds?: string[]; nodeKind?: string; onChanged: () => void;
  /** Rendered at the top of the material column, before the blocks. */
  lead?: ReactNode;
  rail?: ReactNode;
}) {
  const client = useQueryClient(), base = objectBase(owner);
  const [adding, setAdding] = useState<Adding | null>(null), [editing, setEditing] = useState<ContentBlock | null>(null), [error, setError] = useState(""), [page, setPage] = useState(0);
  const [dragging, setDragging] = useState<string | null>(null), [dropTarget, setDropTarget] = useState<string | null>(null);
  useUnsavedChanges(Boolean(adding) || Boolean(editing));
  const directory = useInfiniteQuery({ queryKey: ["research-blocks", projectId(), owner], initialPageParam: "", enabled: initialBlocks === undefined, queryFn: ({ pageParam }) => api<Directory>(base + "/content-blocks?limit=20" + (pageParam ? "&cursor=" + encodeURIComponent(pageParam) : "")), getNextPageParam: page => page.page.nextCursor ?? undefined });
  const blocks = initialBlocks ?? directory.data?.pages.flatMap(page => page.data.items) ?? [];
  const materialBlocks = blocks.filter(block => !hiddenBlockIds.includes(block.id));
  const pages = initialBlocks ? Array.from({ length: Math.ceil(materialBlocks.length / PAGE_SIZE) }, (_, index) => materialBlocks.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE)) : directory.data?.pages.map(page => page.data.items.filter(block => !hiddenBlockIds.includes(block.id))) ?? [];
  const currentPage = Math.min(page, Math.max(0, pages.length - 1)), visible = pages[currentPage] ?? [];
  const offset = pages.slice(0, currentPage).reduce((count, items) => count + items.length, 0);
  const total = initialBlocks ? materialBlocks.length : directory.data?.pages[0]?.page.total ?? 0;
  const hasNextPage = currentPage < pages.length - 1 || initialBlocks === undefined && directory.hasNextPage;
  const nextPage = async () => {
    if (currentPage < pages.length - 1) { setPage(currentPage + 1); return; }
    const result = await directory.fetchNextPage();
    if ((result.data?.pages.length ?? 0) > currentPage + 1) setPage(currentPage + 1);
  };
  const refresh = () => { void client.invalidateQueries({ queryKey: ["research-blocks", projectId(), owner] }); void client.invalidateQueries({ queryKey: ["research-block", projectId(), owner] }); void client.invalidateQueries({ queryKey: ["research-chart-data", projectId(), owner] }); onChanged(); };
  const upload = async (file: File) => { const result = await api<{ asset: { id: string; originalName: string } }>("/api/research-assets", { method: "POST", body: file, headers: { "content-type": "application/octet-stream", "x-asset-name": encodeURIComponent(file.name), "x-asset-media-type": file.type || "application/octet-stream", "idempotency-key": crypto.randomUUID() } }); return { ...result.asset, preview: null }; };
  const save = async (value: unknown) => { await api(base + "/content-blocks" + (editing ? "/" + encodeURIComponent(editing.id) : ""), { method: editing ? "PATCH" : "POST", body: JSON.stringify(editing ? { patch: value, expectedRevision: editing.revision } : { ...(value as object), ...(adding?.after ? { insertAfterBlockId: adding.after } : {}), expectedCollectionRevision: collectionRevision }) }); setEditing(null); setAdding(null); refresh(); };
  /** Persist a new order of the visible material; hidden blocks keep their slots. */
  const reorder = async (visibleIds: string[]) => { setError(""); let at = 0; const ids = blocks.map(block => hiddenBlockIds.includes(block.id) ? block.id : visibleIds[at++]); try { await api(base + "/content-blocks/reorder", { method: "POST", body: JSON.stringify({ blockIds: ids, expectedCollectionRevision: collectionRevision }) }); refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  const move = (index: number, step: number) => { const ids = materialBlocks.map(block => block.id); [ids[index], ids[index + step]] = [ids[index + step], ids[index]]; void reorder(ids); };
  const dropOn = (targetId: string) => {
    const ids = materialBlocks.map(block => block.id), from = ids.indexOf(dragging ?? ""), to = ids.indexOf(targetId);
    setDragging(null); setDropTarget(null);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(to, 0, ...ids.splice(from, 1)); void reorder(ids);
  };
  const jump = (id: string) => {
    const targetPage = pages.findIndex(items => items.some(block => block.id === id));
    if (targetPage < 0 || targetPage !== currentPage && (adding || editing)) return;
    if (targetPage !== currentPage) setPage(targetPage);
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView?.({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
  };
  const complete = initialBlocks !== undefined || !directory.hasNextPage, loaded = initialBlocks === undefined ? !directory.isPending : true;
  const busy = Boolean(adding) || Boolean(editing), canInsert = canEdit && allowAdd && !busy;
  const experimentId = nodeKind === "experiment" ? owner.id : undefined;
  const tableBlocks = materialBlocks.filter(block => block.type === "table" && block.payload?.columns?.length).map(block => ({ id: block.id, title: block.title }));
  const editor = (initial?: ContentBlock | Partial<ContentBlock>) => <div className="content-block-editor-shell"><ContentBlockEditor en={en} experimentId={experimentId} tableBlocks={tableBlocks.filter(block => block.id !== initial?.id)} initial={initial} onUpload={upload} onSave={save} onCancel={() => { setAdding(null); setEditing(null); }} /></div>;
  const starters = blockTypeChoices.filter(choice => (nodeKind === "experiment" ? ["experimentRecord", "metric", "table", "file", "image", "richText"] : ["richText", "table", "image", "quote", "metric", "file"]).includes(choice.type));

  const material = (
    <section className="content-block-workspace" translate="no">
      {lead}
      {(error || directory.error) && <p role="alert">{error || directory.error?.message}<button className="button" onClick={() => { setError(""); void directory.refetch(); onChanged(); }}>{en ? "Reload latest content" : "载入最新内容"}</button></p>}
      {initialBlocks === undefined && directory.isPending && <LoadingSkeleton layout="cards" label={en ? "Loading material…" : "载入研究材料…"} />}
      <div className="content-block-list">
        {visible.map((block, index) => (
          <div className="content-block-slot" key={block.id}>
            {editing?.id === block.id ? editor(editing) : <MaterialRow owner={owner} block={block} initial={initialBlocks === undefined ? undefined : block} en={en} canEdit={canEdit} locked={busy} onEdit={value => { setEditing(value); setAdding(null); }} onChanged={refresh} moveUp={offset + index > 0 && complete ? () => move(offset + index, -1) : undefined} moveDown={offset + index < materialBlocks.length - 1 && complete ? () => move(offset + index, 1) : undefined} />}
            {adding?.after === block.id ? editor() : canInsert && !(index === visible.length - 1 && !hasNextPage) && <button type="button" className="content-block-insert" aria-label={(en ? "Insert a block after " : "在此后插入内容块：") + block.title} onClick={() => setAdding({ after: block.id })}><Plus size={13} /><span>{en ? "Insert here" : "在此插入"}</span></button>}
          </div>
        ))}
      </div>
      {(pages.length > 1 || hasNextPage) && <footer className="research-pagination" aria-label={en ? "Material pages" : "研究材料分页"}><button className="button" disabled={!currentPage || busy} onClick={() => setPage(currentPage - 1)}>{en ? "Previous material" : "上一页材料"}</button><span>{offset + 1}–{offset + visible.length} / {total}</span><button className="button" disabled={!hasNextPage || directory.isFetchingNextPage || busy} onClick={() => void nextPage()}>{en ? "Next material" : "下一页材料"}</button></footer>}
      {adding && !adding.after && editor(adding.type ? { type: adding.type } : undefined)}
      {loaded && !directory.error && !materialBlocks.length && !adding && (
        <div className="content-block-empty">
          <h3>{en ? "No research material" : "暂无研究材料"}</h3>
          {canEdit && allowAdd && <div className="content-block-starters">{starters.map(choice => { const Icon = contentBlockIcon(choice.type); return <button key={choice.type} type="button" className="block-type-choice" onClick={() => setAdding({ type: choice.type })}><Icon size={16} aria-hidden="true" /><strong>{choice.label[en ? 1 : 0]}</strong><small>{choice.holds[en ? 1 : 0]}</small></button>; })}</div>}
        </div>
      )}
      {canEdit && allowAdd && !adding && <div className="content-block-toolbar"><button className="button primary" disabled={Boolean(editing)} onClick={() => { setAdding({}); setEditing(null); }}><Plus size={15} />{en ? "Add content block" : "添加内容块"}</button></div>}
    </section>
  );
  if (rail === undefined) return material;
  return (
    <div className="detail-layout">
      {material}
      <aside className="detail-rail" translate="no">
        {materialBlocks.length > 0 && <nav className="detail-rail-section" aria-label={en ? "Material outline" : "材料大纲"}>
          <h2>{en ? "Material" : "研究材料"}<span className="count">{total || materialBlocks.length}</span></h2>
          <ol className="block-outline">
            {materialBlocks.map(block => { const Icon = contentBlockIcon(block.type), sortable = canEdit && complete && !busy; return (
              <li key={block.id} className={(dragging === block.id ? "is-dragging " : "") + (dropTarget === block.id && dragging !== block.id ? "is-drop-target" : "")}
                draggable={sortable}
                onDragStart={event => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", block.id); setDragging(block.id); }}
                onDragOver={event => { if (dragging) { event.preventDefault(); setDropTarget(block.id); } }}
                onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                onDrop={event => { event.preventDefault(); dropOn(block.id); }}>
                {sortable && <GripVertical size={13} className="block-outline-grip" aria-hidden="true" />}
                <button type="button" disabled={busy && !visible.some(item => item.id === block.id)} onClick={() => jump(block.id)} title={block.title}><Icon size={13} aria-hidden="true" /><span>{block.title}</span></button>
              </li>
            ); })}
          </ol>
        </nav>}
        {rail}
      </aside>
    </div>
  );
}

function MaterialRow({ owner, block, initial, en, canEdit, locked, onEdit, onChanged, moveUp, moveDown }: { owner: ResearchObjectRef; block: ContentBlock; initial?: ContentBlock; en: boolean; canEdit: boolean; locked: boolean; onEdit: (block: ContentBlock) => void; onChanged: () => void; moveUp?: () => void; moveDown?: () => void }) {
  const [collapsed, setCollapsed] = useState(false), [deleting, setDeleting] = useState(false);
  const query = useQuery({ queryKey: ["research-block", projectId(), owner, block.id, block.revision], queryFn: () => api<ContentBlock>(objectBase(owner) + "/content-blocks/" + encodeURIComponent(block.id)), initialData: initial, staleTime: initial ? 120_000 : 0 });
  const Icon = contentBlockIcon(block.type), data = query.data;
  return (
    <article id={block.id} className={"content-block-card" + (collapsed ? " is-collapsed" : "")} data-block-type={block.type} aria-label={block.title}>
      <header>
        <button type="button" className="content-block-fold" aria-expanded={!collapsed} aria-label={(collapsed ? (en ? "Expand " : "展开 ") : (en ? "Collapse " : "折叠 ")) + block.title} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</button>
        <div className="content-block-title"><Icon size={16} aria-hidden="true" /><h3>{block.title}</h3><span className="content-block-type">{contentBlockLabel(block.type, en)}</span></div>
        {canEdit && <div className="content-block-actions">
          <button className="research-icon-button" disabled={!moveUp || locked} onClick={moveUp} aria-label={en ? "Move material up" : "上移内容块"} title={en ? "Move up" : "上移"}><ArrowUp size={14} /></button>
          <button className="research-icon-button" disabled={!moveDown || locked} onClick={moveDown} aria-label={en ? "Move material down" : "下移内容块"} title={en ? "Move down" : "下移"}><ArrowDown size={14} /></button>
          <button className="research-icon-button" disabled={!data || locked} onClick={() => data && onEdit(data)} aria-label={en ? "Edit content block" : "编辑内容块"} title={en ? "Edit" : "编辑"}><Pencil size={14} /></button>
          <button className="research-icon-button is-danger" disabled={locked} aria-label={en ? "Delete content block" : "删除内容块"} title={en ? "Delete" : "删除"} onClick={() => setDeleting(true)}><Trash2 size={14} /></button>
        </div>}
      </header>
      {!collapsed && <>
        <ContentBlockProvenance sourceRefs={data?.sourceRefs as never} en={en} />
        {query.error && <p role="alert">{query.error.message}<button className="button" onClick={onChanged}>{en ? "Reload" : "载入最新内容"}</button></p>}
        {query.isPending && <LoadingSkeleton layout="rows" label={en ? "Loading…" : "载入中…"} />}
        {data && <ContentBlockRenderer block={data} owner={owner} en={en} />}
      </>}
      {deleting && <ConfirmDialog en={en} title={(en ? "Delete block: " : "删除内容块：") + block.title} confirmLabel={en ? "Delete block" : "删除内容块"} onClose={() => setDeleting(false)}
        onConfirm={async () => { await api(objectBase(owner) + "/content-blocks/" + encodeURIComponent(block.id), { method: "DELETE", body: JSON.stringify({ expectedRevision: block.revision }) }); setDeleting(false); onChanged(); }}>
        <p>{block.type === "experimentRecord"
          ? (en ? "The block leaves this experiment. Collected run records and source files are kept." : "内容块将从此实验中移除。已采集的运行记录和来源文件会保留。")
          : (en ? "The block leaves this page. Earlier versions stay in the research history." : "内容块将从页面中移除，此前的版本仍保留在科研历程中。")}</p>
      </ConfirmDialog>}
    </article>
  );
}
