import { useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ArrowDown, FilePlus2, Pencil, Plus, Trash2 } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { objectBase } from "@/features/research/model";
import type { ResearchObjectRef } from "@/features/research/model";
import { ContentBlockEditor } from "./ContentBlockEditor";
import { ContentBlockRenderer } from "./ContentBlockRenderer";
import type { ContentBlock } from "./ContentBlockRenderer";
import { contentBlockIcon } from "./contentBlockPresentation";
import { useUnsavedChanges } from "@/features/research/useResearch";

type Directory = { data: { items: ContentBlock[] }; page: { nextCursor: string | null; total: number } };
export function ObjectContentWorkspace({ owner, en, canEdit, collectionRevision, onChanged }: { owner: ResearchObjectRef; en: boolean; canEdit: boolean; collectionRevision: number; onChanged: () => void }) {
  const client = useQueryClient(), base = objectBase(owner);
  const [adding, setAdding] = useState(false), [editing, setEditing] = useState<ContentBlock | null>(null), [error, setError] = useState("");
  useUnsavedChanges(adding || Boolean(editing));
  const query = useInfiniteQuery({ queryKey: ["research-blocks", projectId(), owner], initialPageParam: "", queryFn: ({ pageParam }) => api<Directory>(base + "/content-blocks?limit=20" + (pageParam ? "&cursor=" + encodeURIComponent(pageParam) : "")), getNextPageParam: page => page.page.nextCursor ?? undefined });
  const blocks = query.data?.pages.flatMap(page => page.data.items) ?? [];
  const refresh = () => { void client.invalidateQueries({ queryKey: ["research-blocks", projectId(), owner] }); void client.invalidateQueries({ queryKey: ["research-block", projectId(), owner] }); onChanged(); };
  const upload = async (file: File) => { const result = await api<{ asset: { id: string; originalName: string } }>("/api/research-assets", { method: "POST", body: file, headers: { "content-type": "application/octet-stream", "x-asset-name": encodeURIComponent(file.name), "x-asset-media-type": file.type || "application/octet-stream", "idempotency-key": crypto.randomUUID() } }); return { ...result.asset, preview: null }; };
  const save = async (value: unknown) => { await api(base + "/content-blocks" + (editing ? "/" + encodeURIComponent(editing.id) : ""), { method: editing ? "PATCH" : "POST", body: JSON.stringify(editing ? { patch: value, expectedRevision: editing.revision } : { ...(value as object), expectedCollectionRevision: collectionRevision }) }); setEditing(null); setAdding(false); refresh(); };
  const move = async (index: number, offset: number) => { setError(""); const ids = blocks.map(block => block.id); [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]]; try { await api(base + "/content-blocks/reorder", { method: "POST", body: JSON.stringify({ blockIds: ids, expectedCollectionRevision: collectionRevision }) }); refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  return <section className="content-block-workspace" translate="no"><header className="research-section-heading"><div><h2>{en ? "Research material" : "研究材料"}</h2></div>{canEdit && <button className="button primary" onClick={() => { setAdding(true); setEditing(null); }}><Plus size={15} />{en ? "Add content block" : "添加内容块"}</button>}</header>
    {(error || query.error) && <p role="alert">{error || query.error?.message}<button className="button" onClick={() => { setError(""); void query.refetch(); onChanged(); }}>{en ? "Reload latest content" : "载入最新内容"}</button></p>}
    {adding && <div className="content-block-editor-shell"><ContentBlockEditor en={en} onUpload={upload} onSave={save} onCancel={() => setAdding(false)} /></div>}
    {query.isPending && <p role="status">{en ? "Loading material…" : "载入研究材料…"}</p>}
    <div className="content-block-list">{blocks.map((block, index) => editing?.id === block.id ? <div key={block.id} className="content-block-editor-shell"><ContentBlockEditor en={en} initial={editing} onUpload={upload} onSave={save} onCancel={() => setEditing(null)} /></div> : <MaterialRow key={block.id + ":" + block.revision} owner={owner} block={block} en={en} canEdit={canEdit} onEdit={value => { setEditing(value); setAdding(false); }} onChanged={refresh} moveUp={index > 0 && !query.hasNextPage ? () => void move(index, -1) : undefined} moveDown={index < blocks.length - 1 && !query.hasNextPage ? () => void move(index, 1) : undefined} />)}</div>
    {query.hasNextPage && <button className="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{en ? "Load more material" : "加载更多材料"}</button>}
    {!query.isPending && !blocks.length && !adding && <div className="content-block-empty"><FilePlus2 size={28} /><h3>{en ? "No research material" : "暂无研究材料"}</h3></div>}
  </section>;
}
function MaterialRow({ owner, block, en, canEdit, onEdit, onChanged, moveUp, moveDown }: { owner: ResearchObjectRef; block: ContentBlock; en: boolean; canEdit: boolean; onEdit: (block: ContentBlock) => void; onChanged: () => void; moveUp?: () => void; moveDown?: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const query = useQuery({ queryKey: ["research-block", projectId(), owner, block.id, block.revision], queryFn: () => api<ContentBlock>(objectBase(owner) + "/content-blocks/" + encodeURIComponent(block.id)) });
  const Icon = contentBlockIcon(block.type);
  return <article className="content-block-card"><header><div className="content-block-title"><Icon size={17} /><h3>{block.title}</h3></div>{canEdit && <div className="content-block-actions"><button className="research-icon-button" disabled={!moveUp || busy} onClick={moveUp} aria-label={en ? "Move material up" : "上移内容块"}><ArrowUp size={14} /></button><button className="research-icon-button" disabled={!moveDown || busy} onClick={moveDown} aria-label={en ? "Move material down" : "下移内容块"}><ArrowDown size={14} /></button><button className="research-icon-button" disabled={!query.data || busy} onClick={() => query.data && onEdit(query.data)} aria-label={en ? "Edit content block" : "编辑内容块"}><Pencil size={14} /></button><button className="research-icon-button" disabled={busy} aria-label={en ? "Delete content block" : "删除内容块"} onClick={async () => { if (!window.confirm(en ? "Delete this material?" : "删除这个内容块？")) return; setBusy(true); setError(""); try { await api(objectBase(owner) + "/content-blocks/" + encodeURIComponent(block.id), { method: "DELETE", body: JSON.stringify({ expectedRevision: block.revision }) }); onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } }}><Trash2 size={14} /></button></div>}</header>
    {(error || query.error) && <p role="alert">{error || query.error?.message}<button className="button" onClick={() => { setError(""); onChanged(); }}>{en ? "Reload" : "载入最新内容"}</button></p>}
    {query.isPending && <p role="status">{en ? "Loading…" : "载入中…"}</p>}{query.data && <ContentBlockRenderer block={query.data} owner={owner} en={en} />}
  </article>;
}
