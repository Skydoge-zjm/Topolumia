import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Users } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import type { CollaborationContext } from "@/shared/types/api";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { ProjectDeleteDialog } from "./ProjectDeleteDialog";
import styles from "./ProjectsPage.module.css";

type Project = NonNullable<CollaborationContext["projects"]>[number];

export function ProjectsPage() {
  const en = useUiStore((state) => state.locale === "en"),
    client = useQueryClient(),
    navigate = useNavigate();
  const [deleting, setDeleting] = useState<Project | null>(null),
    [notice, setNotice] = useState("");
  const context = useQuery({
    queryKey: ["collaboration-context", projectId()],
    queryFn: () => api<CollaborationContext>("/api/collaboration/context"),
  });
  const projects = context.data?.projects ?? [];
  const admin =
    context.data?.actor?.serverRole === "s-admin" ||
    context.data?.permissions?.includes("*");
  const canCollaborate =
    admin || context.data?.permissions?.includes("project.manageMembers");
  return (
    <section className="reference-page reference-projects" translate="no">
      <div className="reference-page-header">
        <h1>{en ? "Projects" : "项目列表"}</h1>
        {canCollaborate && (
          <Link className="button" to="/collaboration">
            <Users size={16} aria-hidden />
            {en ? "Project collaboration" : "项目协作"}
          </Link>
        )}
      </div>
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {context.error && (
        <p role="alert" className="form-error">
          {context.error.message}
          <button className="button" onClick={() => void context.refetch()}>
            {en ? "Retry" : "重试"}
          </button>
        </p>
      )}
      {context.isPending ? (
        <LoadingSkeleton
          layout="rows"
          label={en ? "Loading projects…" : "正在读取项目…"}
        />
      ) : (
        context.data && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{en ? "Project name" : "项目名称"}</th>
                  <th scope="col" className={styles.metadata}>
                    {en ? "Project ID" : "项目 ID"}
                  </th>
                  <th scope="col" className={styles.metadata}>
                    {en ? "Role" : "角色"}
                  </th>
                  <th scope="col">{en ? "Status" : "状态"}</th>
                  <th scope="col" className={styles.metadata}>
                    {en ? "Last updated" : "最近更新"}
                  </th>
                  {admin && (
                    <th scope="col">
                      <span className="visually-hidden">
                        {en ? "Actions" : "操作"}
                      </span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr
                    key={project.id}
                    className={
                      project.id === projectId() ? styles.current : undefined
                    }
                  >
                    <td>
                      <button
                        type="button"
                        className={styles.openProject}
                        onClick={() => {
                          window.localStorage.setItem(
                            "research-workbench-project",
                            project.id,
                          );
                          navigate("/overview");
                        }}
                      >
                        {project.name}
                      </button>
                    </td>
                    <td className={styles.metadata}>{project.id}</td>
                    <td className={styles.metadata}>
                      {project.role ??
                        (en ? "Server administrator" : "服务器管理员")}
                    </td>
                    <td>
                      {project.status === "archived"
                        ? en
                          ? "Archived"
                          : "已归档"
                        : en
                          ? "Active"
                          : "活跃"}
                    </td>
                    <td className={styles.metadata}>
                      {project.id === projectId()
                        ? en
                          ? "Current project"
                          : "当前项目"
                        : project.updatedAt
                          ? new Date(project.updatedAt).toLocaleDateString(
                              en ? "en" : "zh-CN",
                            )
                          : "—"}
                    </td>
                    {admin && (
                      <td className={styles.actions}>
                        <button
                          type="button"
                          className={`button ${styles.deleteButton}`}
                          aria-label={
                            (en ? "Delete project: " : "删除项目：") +
                            project.name
                          }
                          onClick={() => setDeleting(project)}
                        >
                          <Trash2 size={15} aria-hidden />
                          {en ? "Delete" : "删除"}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {!projects.length && (
              <div className="empty-note">
                {en
                  ? "No accessible research projects."
                  : "当前账号还没有可访问的研究项目。"}
              </div>
            )}
          </div>
        )
      )}
      {admin && (
        <div className="reference-project-create">
          <Link className="button" to="/project-create">
            <Plus size={16} aria-hidden />
            {en ? "Create project" : "创建项目"}
          </Link>
        </div>
      )}
      {deleting && (
        <ProjectDeleteDialog
          key={deleting.id}
          project={deleting}
          en={en}
          onClose={() => setDeleting(null)}
          onDeleted={async (result) => {
            if (projectId() === deleting.id)
              window.localStorage.removeItem("research-workbench-project");
            await client.cancelQueries({
              predicate: (entry) => entry.queryKey.includes(deleting.id),
            });
            client.removeQueries({
              predicate: (entry) => entry.queryKey.includes(deleting.id),
            });
            client.setQueriesData<CollaborationContext>(
              { queryKey: ["collaboration-context"] },
              (data) =>
                data
                  ? {
                      ...data,
                      project:
                        data.project?.id === deleting.id ? null : data.project,
                      projects: data.projects?.filter(
                        (project) => project.id !== deleting.id,
                      ),
                    }
                  : data,
            );
            setDeleting(null);
            setNotice(
              result.stoppedCollectors
                ? en
                  ? "Project deleted."
                  : "项目已删除。"
                : en
                  ? "Project deleted. Some record readers could not be stopped; their collection access has been revoked."
                  : "项目已删除。部分记录读取器未能停止，其采集授权已撤销。",
            );
            await client.invalidateQueries({
              queryKey: ["collaboration-context"],
            });
          }}
        />
      )}
    </section>
  );
}
