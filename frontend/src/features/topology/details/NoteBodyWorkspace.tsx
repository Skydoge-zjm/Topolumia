import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { api } from "@/shared/lib/api";
import { objectBase } from "@/features/research/model";
import type { ResearchObjectRef } from "@/features/research/model";
import { useUnsavedChanges } from "@/features/research/useResearch";
import { ContentBlockRenderer } from "./ContentBlockRenderer";
import type { ContentBlock } from "./ContentBlockRenderer";

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
                  title: "正文",
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
        <h2>
          {block?.title && block.title !== "正文"
            ? block.title
            : en
              ? "Body"
              : "正文"}
        </h2>
        {canEdit && !editing && (
          <button className="button" onClick={() => setEditing(true)}>
            <Pencil size={15} />
            {en ? "Edit" : "编辑"}
          </button>
        )}
      </header>
      {editing ? (
        <form
          className="research-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
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
          <footer>
            <button
              type="button"
              className="button"
              disabled={saving}
              onClick={() => {
                setDirty(false);
                setEditing(false);
                setError("");
              }}
            >
              {en ? "Cancel" : "取消"}
            </button>
            <button className="button primary" disabled={saving}>
              {saving
                ? en
                  ? "Saving…"
                  : "保存中…"
                : en
                  ? "Save body"
                  : "保存正文"}
            </button>
          </footer>
        </form>
      ) : (
        block && <ContentBlockRenderer block={block} owner={owner} en={en} />
      )}
      {error && (
        <p role="alert">
          {error}
          <button
            className="button"
            onClick={() => {
              setDirty(false);
              onChanged();
            }}
          >
            {en ? "Reload latest content" : "载入最新内容"}
          </button>
        </p>
      )}
    </section>
  );
}
