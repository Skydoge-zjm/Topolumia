import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectWorkspace } from "@domain/projects/workspace";
import { api, projectId } from "@/shared/lib/api";
import type { CollaborationContext } from "@/shared/types/api";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { ProjectWorkspaceFields } from "./ProjectWorkspaceFields";
import {
  workspaceChoice,
  workspaceDraft,
  type WorkspaceView,
} from "./projectWorkspace";
import styles from "./ProjectWorkspace.module.css";

export function ProjectWorkspacePanel({
  en,
  editable = false,
  onSaved,
  editing,
  onEditingChange,
}: {
  en: boolean;
  editable?: boolean;
  onSaved?: (workspace: ProjectWorkspace) => void;
  editing?: boolean;
  onEditingChange?: (value: boolean) => void;
}) {
  const currentProject = projectId(),
    client = useQueryClient(),
    [params] = useSearchParams();
  const [ownOpen, setOwnOpen] = useState(params.get("workspace") === "edit");
  const open = editing ?? ownOpen,
    setOpen = onEditingChange ?? setOwnOpen;
  const query = useQuery({
    queryKey: ["project-workspace", currentProject],
    queryFn: ({ signal }) =>
      api<WorkspaceView>("/api/project-workspaces", { signal }),
  });
  const context = useQuery({
    queryKey: ["collaboration-context", currentProject],
    queryFn: () => api<CollaborationContext>("/api/collaboration/context"),
  });
  const workspace = query.data?.workspace,
    admin =
      context.data?.permissions?.includes("*") ||
      context.data?.actor?.serverRole === "s-admin";
  if (query.error)
    return (
      <p className={styles.error} role="alert">
        {query.error.message}
        <button className="button" onClick={() => void query.refetch()}>
          {en ? "Retry directory" : "重读工作目录"}
        </button>
      </p>
    );
  if (!workspace) return null;
  return (
    <>
      <section
        className={styles.summary}
        aria-label={en ? "Project working directory" : "项目工作目录"}
      >
        <strong>{en ? "Working directory" : "工作目录"}</strong>
        <span>
          {workspace.kind === "unassigned"
            ? en
              ? "Not linked"
              : "尚未关联"
            : workspace.kind === "ssh"
              ? workspace.hostLabel
              : (query.data?.localHost ?? (en ? "Local computer" : "本机"))}
        </span>
        {workspace.directory && <code>{workspace.directory}</code>}
        {admin &&
          (editable ? (
            <button className="button" onClick={() => setOpen(true)}>
              {workspace.kind === "unassigned"
                ? en
                  ? "Link directory"
                  : "关联工作目录"
                : en
                  ? "Change directory"
                  : "更改目录"}
            </button>
          ) : (
            <Link className="button" to="/tools?workspace=edit">
              {workspace.kind === "unassigned"
                ? en
                  ? "Link directory"
                  : "关联工作目录"
                : en
                  ? "Manage directory"
                  : "管理工作目录"}
            </Link>
          ))}
      </section>
      {editable && open && admin && (
        <WorkspaceEditor
          key={workspace.revision}
          view={query.data!}
          actorId={context.data?.actor?.id ?? ""}
          en={en}
          onClose={() => setOpen(false)}
          onSaved={(value) => {
            setOpen(false);
            onSaved?.(value);
            void client.invalidateQueries({
              predicate: (entry) => entry.queryKey.includes(currentProject),
            });
          }}
        />
      )}
    </>
  );
}

function WorkspaceEditor({
  view,
  actorId,
  en,
  onClose,
  onSaved,
}: {
  view: WorkspaceView;
  actorId: string;
  en: boolean;
  onClose: () => void;
  onSaved: (workspace: ProjectWorkspace) => void;
}) {
  const [draft, setDraft] = useState(() => workspaceDraft(view.workspace)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const unchanged =
    JSON.stringify(workspaceChoice(draft)) ===
    JSON.stringify(workspaceChoice(workspaceDraft(view.workspace)));
  return (
    <ResearchDialog
      title={en ? "Project working directory" : "项目工作目录"}
      onClose={() => !busy && onClose()}
    >
      <form
        className={styles.form}
        onSubmit={async (event) => {
          event.preventDefault();
          if (event.target !== event.currentTarget || busy) return;
          setBusy(true);
          setError("");
          try {
            const result = await api<{
              project: { workspace: ProjectWorkspace };
            }>("/api/project-workspaces", {
              method: "PATCH",
              body: JSON.stringify({
                workspace: workspaceChoice(draft),
                expectedRevision: view.workspace.revision,
              }),
            });
            onSaved(result.project.workspace);
          } catch (cause) {
            setError((cause as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ProjectWorkspaceFields
          value={draft}
          onChange={setDraft}
          actorId={actorId}
          en={en}
          disabled={busy}
          defaultDirectory={view.defaultDirectory}
          defaultHost={view.localHost}
        />
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <footer className={styles.actions}>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onClose}
          >
            {en ? "Cancel" : "取消"}
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || unchanged}
          >
            {busy
              ? en
                ? "Saving…"
                : "保存中…"
              : en
                ? "Save directory"
                : "保存工作目录"}
          </button>
        </footer>
      </form>
    </ResearchDialog>
  );
}
