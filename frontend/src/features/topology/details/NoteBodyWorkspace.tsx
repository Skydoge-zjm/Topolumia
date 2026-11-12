import { useEffect, useState } from "react";
import { Eye, Pencil } from "lucide-react";
import { api } from "@/shared/lib/api";
import { objectBase } from "@/features/research/model";
import type { ResearchObjectRef } from "@/features/research/model";
import { useUnsavedChanges } from "@/features/research/useResearch";
import { ContentBlockRenderer } from "./ContentBlockRenderer";
import { ContentBlockProvenance } from "./ContentBlockProvenance";
import type { ContentBlock } from "./ContentBlockRenderer";

const DEFAULT_BODY_TITLE = "正文";

export function NoteBodyWorkspace({
  owner,
  block,
  collectionRevision,
  en,
  canEdit,
  onChanged,
}: {
  owner: ResearchObjectRef;
  block?: ContentBlock;
  collectionRevision: number;
  en: boolean;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [body, setBody] = useState(String(block?.payload?.body ?? ""));
  const [revision, setRevision] = useState(block?.revision);
  const [editing, setEditing] = useState(canEdit && !body);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [dirty, setDirty] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  useUnsavedChanges(dirty && !saving);
  useEffect(() => {
    if (!dirty) {
      setBody(String(block?.payload?.body ?? ""));
      setRevision(block?.revision);
    }
  }, [block?.payload?.body, block?.revision, dirty]);
  const isBody = block?.role === "body" || !block;
  const heading = block?.title && block.title !== DEFAULT_BODY_TITLE ? block.title : en ? "Body" : "正文";
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const payload = {
        ...block?.payload,
        format: block?.payload?.format ?? "markdown",
        body,
      };
      await api(
        objectBase(owner) +
          "/content-blocks" +
          (block ? "/" + encodeURIComponent(block.id) : ""),
        {
          method: block ? "PATCH" : "POST",
          body: JSON.stringify(
            block
              ? { patch: { payload }, expectedRevision: revision }
              : {
                  title: DEFAULT_BODY_TITLE,
                  type: "richText",
                  role: "body",
                  payload,
                  expectedCollectionRevision: collectionRevision,
                },
          ),
        },
      );
      setDirty(false);
      setEditing(false);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="note-body-workspace" translate="no">
      <header className="research-section-heading">
        <h2>{heading}</h2>
        <div className="research-actions">
          {editing && (
            <div className="note-body-mode" role="group" aria-label={en ? "Edit or preview" : "编辑或预览"}>
              <button
                type="button"
                className={"button" + (mode === "write" ? " is-active" : "")}
                aria-pressed={mode === "write"}
                onClick={() => setMode("write")}
              >
                {en ? "Write" : "编辑"}
              </button>
              <button
                type="button"
                className={"button" + (mode === "preview" ? " is-active" : "")}
                aria-pressed={mode === "preview"}
                onClick={() => setMode("preview")}
              >
                <Eye size={15} />
                {en ? "Preview" : "预览"}
              </button>
            </div>
          )}
          {canEdit && !editing && (
            <button className="button" onClick={() => setEditing(true)}>
              <Pencil size={15} />
              {en ? "Edit" : "编辑"}
            </button>
          )}
        </div>
      </header>
      <ContentBlockProvenance sourceRefs={block?.sourceRefs} en={en} />
      {editing ? (
        <form
          className="research-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {mode === "write" ? (
            <textarea
              aria-label={en ? "Note body" : "笔记正文"}
              rows={16}
              value={body}
              disabled={saving}
              onChange={(event) => {
                setBody(event.target.value);
                setDirty(true);
              }}
            />
          ) : body.trim() ? (
            <div className="note-body-preview">
              <ContentBlockRenderer
                block={{ ...(block ?? { id: "preview", title: DEFAULT_BODY_TITLE, type: "richText", order: 0, payload: {}, revision: 0 }), payload: { ...(block?.payload ?? {}), format: "markdown", body } } as ContentBlock}
                owner={owner}
                en={en}
              />
            </div>
          ) : (
            <p className="research-empty">{en ? "Nothing to preview yet." : "尚无正文可预览。"}</p>
          )}
          <footer>
            <button
              type="button"
              className="button"
              disabled={saving}
              onClick={() => {
                setDirty(false);
                setEditing(false);
                setError("");
                setBody(String(block?.payload?.body ?? ""));
                setRevision(block?.revision);
              }}
            >
              {en ? "Cancel" : "取消"}
            </button>
            <button className="button primary" disabled={saving}>
              {saving ? (en ? "Saving…" : "保存中…") : en ? "Save body" : "保存正文"}
            </button>
          </footer>
        </form>
      ) : (
        block && <ContentBlockRenderer block={block} owner={owner} en={en} />
      )}
      {error && (
        <p role="alert" className="note-body-conflict">
          {error}
          <span className="research-hint">
            {dirty
              ? en
                ? "Your draft is kept. Reload to compare with the latest body; saving again would overwrite it."
                : "当前草稿已保留。载入最新内容可对照最新正文；再次保存会覆盖它。"
              : en
                ? "No local edits to lose."
                : "当前没有未保存的修改。"}
          </span>
          <button
            className="button"
            onClick={() => {
              setDirty(false);
              onChanged();
            }}
          >
            {en ? "Reload latest content" : "载入最新内容"}
          </button>
          {dirty && (
            <button
              className="button"
              onClick={() => {
                setDirty(false);
                setBody(String(block?.payload?.body ?? ""));
                setRevision(block?.revision);
                setError("");
                onChanged();
              }}
            >
              {en ? "Discard my draft" : "丢弃草稿"}
            </button>
          )}
        </p>
      )}
      {!block && isBody && canEdit && !editing && (
        <p className="research-empty">{en ? "This note has no body yet." : "这份笔记尚无正文。"}</p>
      )}
    </section>
  );
}
