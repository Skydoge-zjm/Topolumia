import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import type { CollaborationContext } from "@/shared/types/api";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { ArrowLeft, ArrowRight, LoaderCircle } from "lucide-react";
import { ProjectWorkspaceFields } from "./ProjectWorkspaceFields";
import { workspaceChoice, workspaceDraft } from "./projectWorkspace";
import styles from "./ProjectWorkspace.module.css";

export function ProjectCreatePage() {
  const en = useUiStore((state) => state.locale === "en"),
    navigate = useNavigate(),
    client = useQueryClient();
  const context = useQuery({
    queryKey: ["collaboration-context", projectId()],
    queryFn: () => api<CollaborationContext>("/api/collaboration/context"),
    retry: false,
  });
  const [name, setName] = useState(""),
    [workspace, setWorkspace] = useState(workspaceDraft),
    [directoryReady, setDirectoryReady] = useState(true),
    [nameError, setNameError] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const nameTarget = useRef<HTMLInputElement>(null),
    inFlight = useRef(false),
    errorTarget = useRef<HTMLParagraphElement>(null);
  const canCreate =
    context.data?.permissions?.includes("*") ||
    context.data?.actor?.serverRole === "s-admin";
  const defaults = useQuery({
    queryKey: ["new-project-directory", context.data?.actor?.id],
    enabled: Boolean(canCreate),
    queryFn: ({ signal }) =>
      api<{ id: string; directory: string; hostLabel: string }>(
        "/api/project-workspaces/defaults",
        { signal },
      ),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      event.target !== event.currentTarget ||
      inFlight.current ||
      !defaults.data ||
      !directoryReady
    )
      return;
    if (!name.trim()) {
      setNameError(en ? "Enter a project name." : "请输入项目名称。");
      nameTarget.current?.focus();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ project: { id: string } }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          id: defaults.data.id,
          workspace: workspaceChoice(workspace),
        }),
      });
      window.localStorage.setItem(
        "research-workbench-project",
        result.project.id,
      );
      void client.invalidateQueries({
        queryKey: ["collaboration-context", result.project.id],
      });
      navigate("/overview");
    } catch (cause) {
      setError((cause as Error).message);
      requestAnimationFrame(() => errorTarget.current?.focus());
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <section className={styles.page} translate="no">
      <header className={styles.pageHeader}>
        <Link to="/projects" className={styles.backLink}>
          <ArrowLeft size={14} aria-hidden />
          {en ? "Projects" : "项目列表"}
        </Link>
        <h1>{en ? "Create research project" : "创建研究项目"}</h1>
      </header>
      {context.isPending && (
        <LoadingSkeleton
          layout="rows"
          label={en ? "Loading project options…" : "正在读取项目选项…"}
        />
      )}
      {context.error && (
        <p role="alert">
          {context.error.message}
          <button className="button" onClick={() => void context.refetch()}>
            {en ? "Retry" : "重试"}
          </button>
        </p>
      )}
      {context.data && !canCreate && (
        <p role="status">
          {en
            ? "A server administrator can create projects."
            : "服务器管理员可以创建项目。"}
          <Link className="button" to="/projects">
            {en ? "Back to projects" : "返回项目列表"}
          </Link>
        </p>
      )}
      {canCreate && (
        <form
          className={`${styles.form} ${styles.createForm}`}
          onSubmit={(event) => void submit(event)}
          aria-busy={busy}
          noValidate
        >
          <div className={styles.nameField}>
            <label htmlFor="new-project-name">
              {en ? "Project name" : "项目名称"}
            </label>
            <input
              id="new-project-name"
              ref={nameTarget}
              value={name}
              required
              maxLength={120}
              autoFocus
              autoComplete="off"
              disabled={busy}
              aria-invalid={Boolean(nameError)}
              aria-describedby={
                nameError ? "new-project-name-error" : undefined
              }
              onBlur={() => {
                if (name && !name.trim())
                  setNameError(
                    en ? "Enter a project name." : "请输入项目名称。",
                  );
              }}
              onChange={(event) => {
                setName(event.target.value);
                setNameError("");
                setError("");
              }}
              placeholder={
                en
                  ? "e.g. Efficient model fine-tuning"
                  : "例如：模型高效微调研究"
              }
            />
            {nameError && (
              <p
                id="new-project-name-error"
                className={styles.error}
                role="alert"
              >
                {nameError}
              </p>
            )}
          </div>
          <ProjectWorkspaceFields
            value={workspace}
            en={en}
            disabled={busy}
            actorId={context.data?.actor?.id ?? ""}
            defaultDirectory={defaults.data?.directory}
            defaultHost={defaults.data?.hostLabel}
            onReadinessChange={setDirectoryReady}
            onChange={(next) => {
              setWorkspace(next);
              setError("");
            }}
          />
          {defaults.isPending && (
            <p role="status" className={styles.validation}>
              {en ? "Loading workspace location…" : "正在读取默认位置…"}
            </p>
          )}
          {defaults.error && (
            <p role="alert" className={styles.error}>
              {defaults.error.message}
              <button
                type="button"
                className="button"
                onClick={() => void defaults.refetch()}
              >
                {en ? "Retry" : "重试"}
              </button>
            </p>
          )}
          {error && (
            <p
              className={styles.error}
              role="alert"
              tabIndex={-1}
              ref={errorTarget}
            >
              {error}
            </p>
          )}
          <footer className={styles.createActions}>
            <Link
              className="button"
              to="/projects"
              aria-disabled={busy}
              onClick={(event) => {
                if (busy) event.preventDefault();
              }}
            >
              {en ? "Cancel" : "取消"}
            </Link>
            <button
              className="button primary"
              type="submit"
              disabled={busy || !defaults.data || !directoryReady}
            >
              {busy && (
                <LoaderCircle size={16} className={styles.spin} aria-hidden />
              )}
              {busy
                ? en
                  ? "Creating…"
                  : "正在创建…"
                : en
                  ? "Create project"
                  : "创建项目"}
              {!busy && <ArrowRight size={16} aria-hidden />}
            </button>
          </footer>
        </form>
      )}
    </section>
  );
}
