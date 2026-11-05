import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import type { CollaborationContext } from "@/shared/types/api";

interface ProjectMember {
  user: { id: string; username: string; displayName: string };
  membership: { role: string; status: string; updatedAt: string };
  permissions?: string[];
}
interface ProjectInvitation {
  id: string;
  user: { username: string; displayName: string };
  role: string;
  expiresAt: string;
}

export function CollaborationPage() {
  const id = projectId();
  const en = useUiStore((state) => state.locale === "en");
  const context = useQuery({
    queryKey: ["collaboration-context", id],
    queryFn: () => api<CollaborationContext>("/api/collaboration/context"),
  });
  const members = useQuery({
    queryKey: ["members", id],
    queryFn: () => api<{ members: ProjectMember[] }>(`/api/projects/${encodeURIComponent(id)}/members`),
    enabled: Boolean(id),
  });
  const canManage = context.data?.permissions?.some((value) => value === "*" || value === "project.manageMembers");
  const invitations = useQuery({
    queryKey: ["project-invitations", id],
    queryFn: () => api<{ invitations: ProjectInvitation[] }>(`/api/projects/${encodeURIComponent(id)}/invitations`),
    enabled: Boolean(id && canManage),
  });
  const date = (value: string) => value ? new Date(value).toLocaleString(en ? "en-GB" : "zh-CN") : "—";
  const role = (value?: string) => ({ "p-admin": en ? "Project administrator" : "项目管理员", researcher: en ? "Researcher" : "研究者", viewer: en ? "Viewer" : "只读成员" })[value ?? ""] ?? value ?? "—";
  const status = (value: string) => ({ active: en ? "Active" : "有效", suspended: en ? "Suspended" : "已停用" })[value] ?? value;

  return (
    <section className="page page--collab">
      <header className="collab-head">
        <h1>{en ? "Project collaboration" : "项目协作"}</h1>
        <Link className="button" to="/projects">{en ? "Back to projects" : "返回项目列表"}</Link>
      </header>
      {context.error && <p role="alert">{context.error.message}</p>}
      <dl className="collaboration-context">
        <div><dt>{en ? "Project" : "项目"}</dt><dd>{context.data?.project?.name ?? "—"}</dd></div>
        <div><dt>{en ? "Project ID" : "项目 ID"}</dt><dd>{id || "—"}</dd></div>
        <div><dt>{en ? "Your role" : "我的角色"}</dt><dd>{role(context.data?.membership?.role)}</dd></div>
      </dl>
      <section className="table-section">
        <div className="section-title"><h2>{en ? "Members" : "项目成员"}</h2>{members.data && <span>{members.data.members.length}</span>}</div>
        {members.isPending && <p role="status">{en ? "Loading members…" : "正在读取成员…"}</p>}
        {members.error && <p role="alert">{members.error.message}</p>}
        {members.data && <div className="collaboration-table-scroll"><table className="collaboration-table">
          <thead><tr>{(en ? ["Member", "Role", "Status", "Permissions", "Updated"] : ["成员", "角色", "状态", "权限", "更新时间"]).map((label) => <th key={label}>{label}</th>)}</tr></thead>
          <tbody>{members.data.members.map((member) => <tr key={member.user.id}>
            <td><strong>{member.user.displayName}</strong><small>{member.user.username}</small></td>
            <td>{role(member.membership.role)}</td>
            <td>{status(member.membership.status)}</td>
            <td>{member.permissions ? <details><summary>{member.permissions.length} {en ? "permissions" : "项权限"}</summary><ul>{member.permissions.map((permission) => <li key={permission}>{permission}</li>)}</ul></details> : "—"}</td>
            <td><time dateTime={member.membership.updatedAt}>{date(member.membership.updatedAt)}</time></td>
          </tr>)}</tbody>
        </table>{!members.data.members.length && <p className="empty-note">{en ? "No members" : "暂无成员"}</p>}</div>}
      </section>
      {canManage && <section className="table-section invitation-section">
        <div className="section-title"><h2>{en ? "Pending invitations" : "待处理邀请"}</h2>{invitations.data && <span>{invitations.data.invitations.length}</span>}</div>
        {invitations.isPending && <p role="status">{en ? "Loading invitations…" : "正在读取邀请…"}</p>}
        {invitations.error && <p role="alert">{invitations.error.message}</p>}
        {invitations.data && (invitations.data.invitations.length ? <ul className="collaboration-invitations">{invitations.data.invitations.map((invitation) => <li key={invitation.id}><strong>{invitation.user.displayName || invitation.user.username}</strong><span>{role(invitation.role)}</span><span>{en ? "Expires: " : "到期时间："}<time dateTime={invitation.expiresAt}>{date(invitation.expiresAt)}</time></span></li>)}</ul> : <p className="empty-note">{en ? "No pending invitations" : "暂无待处理邀请"}</p>)}
      </section>}
    </section>
  );
}
