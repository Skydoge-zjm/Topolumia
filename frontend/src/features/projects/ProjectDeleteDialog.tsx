import { useRef, useState } from "react";
import type { ProjectDeletionResult } from "@domain/projects/lifecycle";
import { api } from "@/shared/lib/api";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import styles from "./ProjectsPage.module.css";

export function ProjectDeleteDialog({
  project,
  en,
  onClose,
  onDeleted,
}: {
  project: { id: string; name: string };
  en: boolean;
  onClose: () => void;
  onDeleted: (result: ProjectDeletionResult) => Promise<void>;
}) {
  const [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const inFlight = useRef(false);
  return (
    <ResearchDialog
      title={en ? "Delete project" : "删除项目"}
      onClose={() => !inFlight.current && onClose()}
    >
      <form
        className={styles.deleteForm}
        aria-busy={busy}
        onSubmit={async (event) => {
          event.preventDefault();
          if (inFlight.current || name !== project.name) return;
          inFlight.current = true;
          setBusy(true);
          setError("");
          try {
            const result = await api<ProjectDeletionResult>(
              "/api/projects/" + encodeURIComponent(project.id),
              {
                method: "DELETE",
                body: JSON.stringify({ name }),
              },
            );
            await onDeleted(result);
          } catch (cause) {
            setError((cause as Error).message);
          } finally {
            inFlight.current = false;
            setBusy(false);
          }
        }}
      >
        <p>
          {en
            ? `“${project.name}” will be removed from the project list. Members and agents will lose access and record collection will be disabled.`
            : `“${project.name}”将从项目列表移除，成员与 Agent 将失去访问权限，记录采集将停用。`}
        </p>
        <p>
          {en
            ? "Research data, session history and working directories will be retained. There is no restore action in the app."
            : "研究数据、会话历史和工作目录会保留。应用内暂不提供恢复操作。"}
        </p>
        <label htmlFor="delete-project-name">
          {en ? "Enter the project name to confirm" : "输入项目名称以确认"}
        </label>
        <strong className={styles.projectName}>{project.name}</strong>
        <input
          id="delete-project-name"
          autoComplete="off"
          value={name}
          disabled={busy}
          maxLength={160}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
        />
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <footer>
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
            className={`button ${styles.confirmDelete}`}
            disabled={busy || name !== project.name}
          >
            {busy
              ? en
                ? "Deleting…"
                : "删除中…"
              : en
                ? "Confirm deletion"
                : "确认删除"}
          </button>
        </footer>
      </form>
    </ResearchDialog>
  );
}
