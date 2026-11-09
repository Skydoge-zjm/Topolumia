import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";

import { api, projectId } from "@/shared/lib/api";

import type { CollaborationContext } from "@/shared/types/api";

export function ProjectsPage() {
  const context = useQuery({
    queryKey: ["collaboration-context", projectId()],
    queryFn: () => api<CollaborationContext>("/api/collaboration/context"),
  });
  const projects = context.data?.projects ?? [];
  const canCreate = context.data?.permissions?.includes("*");
  const canCollaborate =
    canCreate || context.data?.permissions?.includes("project.manageMembers");
  return (
    <section className="reference-page reference-projects">
      <div className="reference-page-header">
        <div>
          <h1>项目列表</h1>
        </div>
        <div>
          {canCollaborate && (
            <Link className="button" to="/collaboration">
              <Users size={16} aria-hidden="true" />项目协作
            </Link>
          )}
        </div>
      </div>
      <section className="reference-project-table">
        <header>
          <span>项目名称</span>
          <span>项目 ID</span>
          <span>角色</span>
          <span>状态</span>
          <span>最近更新</span>
        </header>
        {projects.length ? (
          projects.map((project) => (
            <button
              type="button"
              className={`reference-project-row ${project.id === projectId() ? "is-current" : ""}`}
              key={project.id}
              onClick={() => {
                window.localStorage.setItem(
                  "research-workbench-project",
                  project.id,
                );
                window.location.hash = "#/overview";
              }}
            >
              <strong>{project.name}</strong>
              <span>{project.id}</span>
              <span>{project.role ?? "member"}</span>
              <span className="status">
                <i className={project.status !== "active" ? "muted" : ""} />
                {project.status ?? "active"}
              </span>
              <span>
                {project.id === projectId()
                  ? "当前项目"
                  : (project.updatedAt ?? "—")}
              </span>
            </button>
          ))
        ) : (
          <div className="empty-note">
            <span>当前账号还没有可访问的研究项目。</span>
          </div>
        )}
      </section>
      {canCreate && (
        <div className="reference-project-create">
          <Link className="button" to="/project-create">
            <Plus size={16} aria-hidden="true" />创建项目
          </Link>
        </div>
      )}
    </section>
  );
}
