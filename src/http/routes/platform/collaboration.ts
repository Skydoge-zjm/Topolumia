import { AppError } from "../../../lib/errors.js";
import { readJson, sendJson } from "../../../lib/http.js";

import { publicProjectForApi } from "../../presenters.js";

export async function handlePlatformCollaborationRoutes(context) {
  const {
    request,
    response,
    pathname,
    requestedProjectId,
    requestActor,
    collaboration,
    projectWorkspaces,
  } = context;
  if (pathname.startsWith("/api/project-workspaces")) {
    if (pathname === "/api/project-workspaces/defaults" && request.method === "GET") {
      sendJson(response, 200, projectWorkspaces.defaults(requestActor)); return true;
    }
    if (pathname === "/api/project-workspaces" && request.method === "GET") {
      sendJson(response, 200, projectWorkspaces.get(requestedProjectId, requestActor)); return true;
    }
    if (pathname === "/api/project-workspaces" && request.method === "PATCH") {
      const body = await readJson(request, 16384);
      if (!body || Object.keys(body).some(key => !["workspace", "expectedRevision"].includes(key))) throw new AppError("PROJECT_INPUT_INVALID", "工作目录配置无效。", { status: 422 });
      sendJson(response, 200, { project: await projectWorkspaces.update(requestedProjectId, body.workspace, body.expectedRevision, requestActor) }); return true;
    }
    if (pathname === "/api/project-workspaces/directories" && request.method === "GET") {
      const params = new URL(request.url, "http://localhost").searchParams;
      sendJson(response, 200, await projectWorkspaces.browse({ kind: params.get("kind"), connectionId: params.get("connectionId"), directory: params.get("directory") ?? "", query: params.get("q") ?? "", offset: Number(params.get("offset") ?? 0) }, requestActor)); return true;
    }
    if (pathname === "/api/project-workspaces/validate" && request.method === "POST") {
      sendJson(response, 200, { workspace: await projectWorkspaces.prepare(await readJson(request, 16384), requestActor) }); return true;
    }
    throw new AppError("METHOD_NOT_ALLOWED", "此项目目录操作不可用。", { status: 405 });
  }

  if (pathname === "/api/collaboration/context" && request.method === "GET") {
    const contextProject = collaboration.projectById(requestedProjectId);
    const contextMembership =
      contextProject?.id === requestedProjectId
        ? requestActor.membership
        : null;
    const contextPermissions = contextMembership
      ? requestActor.permissions
      : requestActor.isServerAdmin
        ? ["*"]
        : [];
    sendJson(response, 200, {
      schemaVersion: "collaboration-context.v1",
      actor: requestActor.user,
      project: publicProjectForApi(
        contextProject &&
          (requestActor.isServerAdmin || contextMembership
            ? contextProject
            : null),
      ),
      membership: contextMembership,
      permissions: contextPermissions,
      permissionCatalog: collaboration.permissionCatalog(),
      invitations: collaboration.invitationsForUser(requestActor.user.id),
      projects: collaboration.listProjects(requestActor),
    });
    return true;
  }
  if (pathname === "/api/projects" && request.method === "GET") {
    sendJson(response, 200, {
      projects: collaboration.listProjects(requestActor),
    });
    return true;
  }
  if (pathname === "/api/projects" && request.method === "POST") {
    const body = await readJson(request);
    sendJson(response, 201, {
      project: await projectWorkspaces.create(body, requestActor),
    });
    return true;
  }
  if (pathname === "/api/users" && request.method === "GET") {
    if (
      !requestActor?.isServerAdmin &&
      !requestActor?.permissions?.includes("project.manageMembers")
    )
      throw new AppError("FORBIDDEN", "只有项目管理员可以选择服务器账号。", {
        status: 403,
      });
    sendJson(response, 200, { users: collaboration.listUsers() });
    return true;
  }
  if (pathname === "/api/users" && request.method === "POST") {
    const body = await readJson(request);
    sendJson(response, 201, {
      user: collaboration.createUser(body, requestActor),
    });
    return true;
  }
  const projectApiMatch = pathname.match(
    /^\/api\/projects\/([^/]+)(?:\/(.*))?$/,
  );
  if (projectApiMatch) {
    const projectId = decodeURIComponent(projectApiMatch[1]);
    const projectActor = collaboration.requireActor(request, projectId);
    const suffix = projectApiMatch[2] ?? "";
    const acceptMatch = suffix.match(/^invitations\/([^/]+)\/accept$/);
    if (!acceptMatch) collaboration.requireProject(projectActor, projectId);
    if (request.method === "GET" && suffix === "") {
      sendJson(response, 200, {
        project: publicProjectForApi(collaboration.projectById(projectId)),
        membership: projectActor.membership,
        permissions: projectActor.permissions,
      });
      return true;
    }
    if (request.method === "GET" && suffix === "members") {
      sendJson(response, 200, {
        projectId,
        members: collaboration.members(projectId, projectActor),
      });
      return true;
    }
    if (request.method === "GET" && suffix === "audit") {
      sendJson(response, 200, {
        projectId,
        events: collaboration.auditEvents(projectId, projectActor),
      });
      return true;
    }
    if (request.method === "GET" && suffix === "invitations") {
      sendJson(response, 200, {
        projectId,
        invitations: collaboration.projectInvitations(projectId, projectActor),
      });
      return true;
    }
    if (request.method === "POST" && suffix === "invitations") {
      const body = await readJson(request);
      sendJson(
        response,
        201,
        collaboration.invite(projectId, body, projectActor),
      );
      return true;
    }
    const invitationRevokeMatch = suffix.match(/^invitations\/([^/]+)$/);
    if (request.method === "DELETE" && invitationRevokeMatch) {
      sendJson(
        response,
        200,
        collaboration.revokeInvitation(
          projectId,
          decodeURIComponent(invitationRevokeMatch[1]),
          projectActor,
        ),
      );
      return true;
    }
    if (request.method === "POST" && acceptMatch) {
      if (!collaboration.projectById(projectId))
        throw new AppError("PROJECT_NOT_FOUND", "项目不存在。", {
          status: 404,
        });
      sendJson(
        response,
        200,
        collaboration.acceptInvitation(projectId, acceptMatch[1], projectActor),
      );
      return true;
    }
    const memberRoleMatch = suffix.match(/^members\/([^/]+)$/);
    if (request.method === "PATCH" && memberRoleMatch) {
      const body = await readJson(request);
      sendJson(
        response,
        200,
        collaboration.updateMember(
          projectId,
          decodeURIComponent(memberRoleMatch[1]),
          body,
          projectActor,
        ),
      );
      return true;
    }
    const permissionMatch = suffix.match(/^members\/([^/]+)\/permissions$/);
    if (request.method === "POST" && permissionMatch) {
      const body = await readJson(request);
      sendJson(
        response,
        200,
        collaboration.setPermission(
          projectId,
          decodeURIComponent(permissionMatch[1]),
          body,
          projectActor,
        ),
      );
      return true;
    }
    const removePermissionMatch = suffix.match(
      /^members\/([^/]+)\/permissions\/([^/]+)$/,
    );
    if (request.method === "DELETE" && removePermissionMatch) {
      sendJson(
        response,
        200,
        collaboration.removePermission(
          projectId,
          decodeURIComponent(removePermissionMatch[1]),
          decodeURIComponent(removePermissionMatch[2]),
          projectActor,
        ),
      );
      return true;
    }
    const removeMemberMatch = suffix.match(/^members\/([^/]+)$/);
    if (request.method === "DELETE" && removeMemberMatch) {
      sendJson(
        response,
        200,
        collaboration.removeMember(
          projectId,
          decodeURIComponent(removeMemberMatch[1]),
          projectActor,
        ),
      );
      return true;
    }
  }

  return false;
}
