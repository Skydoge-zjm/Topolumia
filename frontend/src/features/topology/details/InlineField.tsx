import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { useUnsavedChanges } from "@/features/research/useResearch";

/**
 * Text that is edited where it is read. Enter saves (Ctrl+Enter when multiline), Escape cancels,
 * leaving the field saves a changed value. A failed save keeps the draft and says why.
 */
export function InlineField({ value, label, placeholder, multiline = false, required = false, maxLength, canEdit, en, className = "", as: Tag = "p", onSave }: {
  value: string; label: string; placeholder?: string; multiline?: boolean; required?: boolean; maxLength?: number; canEdit: boolean; en: boolean; className?: string;
  as?: "h1" | "p"; onSave: (value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(value), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const dirty = editing && draft !== value;
  useUnsavedChanges(dirty && !saving);
  useEffect(() => { if (editing) { field.current?.focus(); field.current?.select?.(); } }, [editing]);
  const start = () => { setDraft(value); setError(""); setEditing(true); };
  const cancel = () => { setEditing(false); setError(""); };
  const commit = async () => {
    const next = draft.trim();
    if (next === value.trim()) { cancel(); return; }
    if (required && !next) { setError(en ? "This cannot be empty." : "此项不能为空。"); return; }
    setSaving(true); setError("");
    try { await onSave(next); setEditing(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  if (!editing) {
    if (!canEdit) return value ? <Tag className={className}>{value}</Tag> : null;
    // The heading stays a heading; the edit affordance is the text itself.
    return <Tag className={className + " inline-field" + (value ? "" : " is-empty")}><button type="button" className="inline-field-display" aria-label={label + (value ? "：" + value : "")} title={label} onClick={start}>{value || placeholder || label}</button></Tag>;
  }
  const shared = {
    ref: field, value: draft, "aria-label": label, maxLength, disabled: saving, placeholder,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: () => { if (!saving && !error) void commit(); },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
      else if (event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) { event.preventDefault(); void commit(); }
    },
  };
  return (
    <div className={className + " inline-field is-editing"}>
      {multiline ? <textarea rows={Math.min(8, Math.max(2, draft.split("\n").length + 1))} {...shared} /> : <input {...shared} />}
      {error && <p role="alert">{error}<button type="button" className="button" onClick={() => void commit()}>{en ? "Save again" : "重新保存"}</button><button type="button" className="button" onClick={cancel}>{en ? "Discard edit" : "放弃修改"}</button></p>}
    </div>
  );
}

/** Free tags: remove with the cross, add by typing; commas and Enter separate tags. */
export function TagEditor({ tags, canEdit, en, onSave }: { tags: string[]; canEdit: boolean; en: boolean; onSave: (tags: string[]) => Promise<void> }) {
  const [adding, setAdding] = useState(false), [draft, setDraft] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (adding) input.current?.focus(); }, [adding]);
  const save = async (next: string[]) => {
    setBusy(true); setError("");
    try { await onSave(next); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setBusy(false); }
  };
  const add = async () => {
    const next = draft.split(/[,，\n]/).map(tag => tag.trim()).filter(tag => tag && !tags.includes(tag));
    if (!next.length) { setDraft(""); setAdding(false); return; }
    if (await save([...tags, ...next])) setDraft("");
  };
  if (!tags.length && !canEdit) return null;
  return (
    <div className="tag-editor">
      <ul className="tag-list" aria-label={en ? "Tags" : "标签"}>
        {tags.map(tag => <li key={tag}>{tag}{canEdit && <button type="button" disabled={busy} aria-label={(en ? "Remove tag " : "移除标签 ") + tag} onClick={() => void save(tags.filter(item => item !== tag))}><X size={12} /></button>}</li>)}
      </ul>
      {canEdit && (adding
        ? <input ref={input} className="tag-editor-input" aria-label={en ? "New tag" : "新标签"} placeholder={en ? "Tag" : "标签"} maxLength={80} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} onBlur={() => void add()} onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === "Enter" || event.key === "," || event.key === "，") { event.preventDefault(); void add(); } else if (event.key === "Escape") { event.stopPropagation(); setDraft(""); setAdding(false); } }} />
        : <button type="button" className="tag-editor-add" onClick={() => setAdding(true)}><Plus size={12} />{en ? "Tag" : "标签"}</button>)}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
