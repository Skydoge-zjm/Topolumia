import { useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ArrowDown, FilePlus2, Pencil, Plus, Trash2 } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { objectBase } from "@/features/research/model";
import type { ResearchObjectRef } from "@/features/research/model";
import { ContentBlockEditor } from "./ContentBlockEditor";
import { ContentBlockRenderer } from "./ContentBlockRenderer";
import type { ContentBlock } from "./ContentBlockRenderer";
import { ContentBlockProvenance } from "./ContentBlockProvenance";
import { contentBlockIcon, contentBlockLabel } from "./contentBlockPresentation";
import { useUnsavedChanges } from "@/features/research/useResearch";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";

type Directory = { data: { items: ContentBlock[] }; page: { nextCursor: string | null; total: number } };
const PAGE_SIZE = 20;

/**
 * `initialBlocks` comes from the object detail response, which already carries every block with its payload.
 * Reuse those payloads while mounting only the current page of material.
 */
export function ObjectContentWorkspace({ owner, en, canEdit, collectionRevision, initialBlocks, onChanged }: { owner: ResearchObjectRef; en: boolean; canEdit: boolean; collectionRevision: number; initialBlocks?: ContentBlock[]; onChanged: () => void }) {
  const client = useQueryClient(), base = objectBase(owner);
  const [adding, setAdding] = useState(false), [editing, setEditing] = useState<ContentBlock | null>(null), [error, setError] = useState(""), [page, setPage] = useState(0);
  useUnsavedChanges(adding || Boolean(editing));
  const directory = useInfiniteQuery({ queryKey: ["research-blocks", projectId(), owner], initialPageParam: "", enabled: initialBlocks === undefined, queryFn: ({ pageParam }) => api<Directory>(base + "/content-blocks?limit=20" + (pageParam ? "&cursor=" + encodeURIComponent(pageParam) : "")), getNextPageParam: page => page.page.nextCursor ?? undefined });
  const blocks = initialBlocks ?? directory.data?.pages.flatMap(page => page.data.items) ?? [];
  const pages = initialBlocks ? Array.from({ length: Math.ceil(blocks.length / PAGE_SIZE) }, (_, index) => blocks.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE)) : directory.data?.pages.map(page => page.data.items) ?? [];
  const currentPage = Math.min(page, Math.max(0, pages.length - 1)), visible = pages[currentPage] ?? [];
  const offset = pages.slice(0, currentPage).reduce((count, items) => count + items.length, 0);
  const total = initialBlocks?.length ?? directory.data?.pages[0]?.page.total ?? 0;
  const hasNextPage = currentPage < pages.length - 1 || initialBlocks === undefined && directory.hasNextPage;
  const nextPage = async () => {
    if (currentPage < pages.length - 1) { setPage(currentPage + 1); return; }
    const result = await directory.fetchNextPage();
    if ((result.data?.pages.length ?? 0) > currentPage + 1) setPage(currentPage + 1);
  };
  const refresh = () => { void client.invalidateQueries({ queryKey: ["research-blocks", projectId(), owner] }); void client.invalidateQueries({ queryKey: ["research-block", projectId(), owner] }); onChanged(); };
  const upload = async (file: File) => { const result = await api<{ asset: { id: string; originalName: string } }>("/api/research-assets", { method: "POST", body: file, headers: { "content-type": "application/octet-stream", "x-asset-name": encodeURIComponent(file.name), "x-asset-media-type": file.type || "application/octet-stream", "idempotency-key": crypto.randomUUID() } }); return { ...result.asset, preview: null }; };
  const save = async (value: unknown) => { await api(base + "/content-blocks" + (editing ? "/" + encodeURIComponent(editing.id) : ""), { method: editing ? "PATCH" : "POST", body: JSON.stringify(editing ? { patch: value, expectedRevision: editing.revision } : { ...(value as object), expectedCollectionRevision: collectionRevision }) }); setEditing(null); setAdding(false); refresh(); };
  const move = async (index: number, offset: number) => { setError(""); const ids = blocks.map(block => block.id); [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]]; try { await api(base + "/content-blocks/reorder", { method: "POST", body: JSON.stringify({ blockIds: ids, expectedCollectionRevision: collectionRevision }) }); refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  const complete = initialBlocks !== undefined || !directory.hasNextPage, loaded = initialBlocks === undefined ? !directory.isPending : true;
  return <section className="content-block-workspace" translate="no">{canEdit && <header className="content-block-toolbar"><button className="button primary" onClick={() => { setAdding(true); setEditing(null); }}><Plus size={15} />{en ? "Add content block" : "添加内容块"}</button></header>}
    {(error || directory.error) && <p role="alert">{error || directory.error?.message}<button className="button" onClick={() => { setError(""); void directory.refetch(); onChanged(); }}>{en ? "Reload latest content" : "载入最新内容"}</button></p>}
    {adding && <div className="content-block-editor-shell"><ContentBlockEditor en={en} onUpload={upload} onSave={save} onCancel={() => setAdding(false)} /></div>}
    {initialBlocks === undefined && directory.isPending && <LoadingSkeleton layout="cards" label={en ? "Loading material…" : "载入研究材料…"} />}
    <div className="content-block-list">{visible.map((block, index) => editing?.id === block.id ? <div key={block.id} className="content-block-editor-shell"><ContentBlockEditor en={en} initial={editing} onUpload={upload} onSave={save} onCancel={() => setEditing(null)} /></div> : <MaterialRow key={block.id + ":" + block.revision} owner={owner} block={block} initial={initialBlocks === undefined ? undefined : block} en={en} canEdit={canEdit} onEdit={value => { setEditing(value); setAdding(false); }} onChanged={refresh} moveUp={offset + index > 0 && complete ? () => void move(offset + index, -1) : undefined} moveDown={offset + index < blocks.length - 1 && complete ? () => void move(offset + index, 1) : undefined} />)}</div>
    {(pages.length > 1 || hasNextPage) && <footer className="research-pagination" aria-label={en ? "Material pages" : "研究材料分页"}><button className="button" disabled={!currentPage || adding || Boolean(editing)} onClick={() => setPage(currentPage - 1)}>{en ? "Previous material" : "上一页材料"}</button><span>{offset + 1}–{offset + visible.length} / {total}</span><button className="button" disabled={!hasNextPage || directory.isFetchingNextPage || adding || Boolean(editing)} onClick={() => void nextPage()}>{en ? "Next material" : "下一页材料"}</button></footer>}
    {loaded && !directory.error && !blocks.length && !adding && <div className="content-block-empty"><FilePlus2 size={28} /><h3>{en ? "No research material" : "暂无研究材料"}</h3></div>}
  </section>;
}

function MaterialRow({ owner, block, initial, en, canEdit, onEdit, onChanged, moveUp, moveDown }: { owner: ResearchObjectRef; block: ContentBlock; initial?: ContentBlock; en: boolean; canEdit: boolean; onEdit: (block: ContentBlock) => void; onChanged: () => void; moveUp?: () => void; moveDown?: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const query = useQuery({ queryKey: ["research-block", projectId(), owner, block.id, block.revision], queryFn: () => api<ContentBlock>(objectBase(owner) + "/content-blocks/" + encodeURIComponent(block.id)), initialData: initial, staleTime: initial ? 120_000 : 0 });
  const Icon = contentBlockIcon(block.type), data = query.data;
  return <article className="content-block-card"><header><div className="content-block-title"><Icon size={17} /><h3>{block.title}</h3><span className="content-block-type">{contentBlockLabel(block.type, en)}</span></div>{canEdit && <div className="content-block-actions"><button className="research-icon-button" disabled={!moveUp || busy} onClick={moveUp} aria-label={en ? "Move material up" : "上移内容块"}><ArrowUp size={14} /></button><button className="research-icon-button" disabled={!moveDown || busy} onClick={moveDown} aria-label={en ? "Move material down" : "下移内容块"}><ArrowDown size={14} /></button><button className="research-icon-button" disabled={!data || busy} onClick={() => data && onEdit(data)} aria-label={en ? "Edit content block" : "编辑内容块"}><Pencil size={14} /></button><button className="research-icon-button" disabled={busy} aria-label={en ? "Delete content block" : "删除内容块"} onClick={async () => { if (!window.confirm(en ? "Delete this material?" : "删除这个内容块？")) return; setBusy(true); setError(""); try { await api(objectBase(owner) + "/content-blocks/" + encodeURIComponent(block.id), { method: "DELETE", body: JSON.stringify({ expectedRevision: block.revision }) }); onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } }}><Trash2 size={14} /></button></div>}</header>
    <ContentBlockProvenance sourceRefs={data?.sourceRefs as never} en={en} />
    {(error || query.error) && <p role="alert">{error || query.error?.message}<button className="button" onClick={() => { setError(""); onChanged(); }}>{en ? "Reload" : "载入最新内容"}</button></p>}
    {query.isPending && <LoadingSkeleton layout="rows" label={en ? "Loading…" : "载入中…"} />}{data && <ContentBlockRenderer block={data} owner={owner} en={en} />}
  </article>;
}
