import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  opendir,
  realpath,
  rmdir,
  stat,
} from "node:fs/promises";
import { AppError } from "../../lib/errors.js";
import {
  createProjectSchema,
  projectWorkspaceSchema,
} from "../../domain/projects/workspace.js";

export class ProjectWorkspaceService {
  constructor(public options) {}
  requireAdministrator(actor) {
    if (!actor?.isServerAdmin || actor.isAgent || actor.collectorGrant)
      throw new AppError(
        "FORBIDDEN",
        "只有服务器管理员可以创建项目或关联主机目录。",
        { status: 403 },
      );
  }
  get(projectId, actor) {
    const project = this.options.collaboration.requireProject(actor, projectId);
    return {
      projectId: project.id,
      name: project.name,
      workspace: project.workspace,
      localHost: os.hostname(),
      defaultDirectory:
        this.options.collaboration.projectRootFactory?.(project.id) ??
        this.options.config.project.workspacesRoot,
    };
  }
  defaults(actor) {
    this.requireAdministrator(actor);
    const id = "project_" + randomUUID().replaceAll("-", "");
    return {
      id,
      directory:
        this.options.collaboration.projectRootFactory?.(id) ??
        path.join(this.options.config.project.workspacesRoot, id),
      hostLabel: os.hostname(),
    };
  }
  async localDirectory(
    directory = "",
    { list = true, offset = 0, query = "" } = {},
  ) {
    const home = os.homedir();
    const requested =
      directory === "~"
        ? home
        : directory.startsWith("~/") || directory.startsWith("~\\")
          ? path.join(home, directory.slice(2))
          : directory || home;
    if (!path.isAbsolute(requested))
      throw new AppError(
        "PROJECT_DIRECTORY_INVALID",
        "请输入所选主机上的绝对目录路径。",
        { status: 422, detail: { field: "workspace.directory" } },
      );
    try {
      const canonical = await realpath(requested);
      if (!(await stat(canonical)).isDirectory())
        throw new AppError("PROJECT_DIRECTORY_INVALID", "所选路径不是目录。", {
          status: 422,
          detail: { field: "workspace.directory" },
        });
      await access(canonical);
      const reader = await opendir(canonical),
        entries = [];
      let partial = false,
        scanned = 0;
      try {
        if (list)
          for await (const entry of reader) {
            scanned++;
            if (
              entry.isDirectory() &&
              entry.name.toLowerCase().includes(query.toLowerCase())
            )
              entries.push({
                name: entry.name,
                path: path.join(canonical, entry.name),
              });
            if (scanned >= 20000 || entries.length >= 3000) {
              partial = true;
              break;
            }
          }
      } finally {
        await reader.close().catch(() => {});
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const roots = [
        ...new Set([
          path.parse(home).root,
          path.parse(this.options.config.project.root).root,
        ]),
      ].map((value) => ({ name: value, path: value }));
      return {
        directory: canonical,
        parent:
          path.dirname(canonical) === canonical
            ? null
            : path.dirname(canonical),
        entries: entries.slice(offset, offset + 100),
        total: entries.length,
        nextOffset: offset + 100 < entries.length ? offset + 100 : null,
        partial,
        roots,
        home,
        hostLabel: os.hostname(),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        error.code === "ENOENT"
          ? "PROJECT_DIRECTORY_NOT_FOUND"
          : "PROJECT_DIRECTORY_UNAVAILABLE",
        error.code === "ENOENT"
          ? "目录不存在，请检查路径。"
          : "目录不可访问，请检查主机上的目录权限。",
        { status: 422, detail: { field: "workspace.directory" } },
      );
    }
  }
  async browse(input, actor, list = true) {
    this.requireAdministrator(actor);
    const {
      kind,
      connectionId,
      directory = "",
      offset = 0,
      query = "",
    } = input;
    if (
      !["local", "ssh"].includes(kind) ||
      typeof directory !== "string" ||
      directory.length > 4096 ||
      [...directory].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof query !== "string" ||
      query.length > 240
    )
      throw new AppError("PROJECT_DIRECTORY_INVALID", "目录选择参数无效。", {
        status: 422,
      });
    return kind === "local"
      ? this.localDirectory(directory, { list, offset, query })
      : this.options.sshConnections.browseDirectory(
          actor.user.id,
          connectionId,
          directory,
          { list, offset, query },
        );
  }
  async prepare(choice, actor) {
    this.requireAdministrator(actor);
    const parsed = projectWorkspaceSchema.safeParse(choice);
    if (!parsed.success)
      throw new AppError(
        "PROJECT_DIRECTORY_INVALID",
        "请选择 Topolumia 默认工作区、本机目录或 SSH 目录。",
        { status: 422, detail: { field: "workspace.directory" } },
      );
    const value = parsed.data;
    if (value.kind === "managed") return value;
    if (value.kind === "local")
      return {
        ...value,
        directory: (await this.localDirectory(value.directory, { list: false }))
          .directory,
        hostLabel: os.hostname(),
      };
    const profile = await this.options.sshConnections.profile(
        actor.user.id,
        value.connectionId,
      ),
      revision = profile.revision;
    const result = await this.options.sshConnections.browseDirectory(
      actor.user.id,
      value.connectionId,
      value.directory,
      { list: false },
    );
    const latest = await this.options.sshConnections.profile(
      actor.user.id,
      value.connectionId,
    );
    if (latest.revision !== revision)
      throw new AppError(
        "SSH_CONFIGURATION_CHANGED",
        "SSH 主机配置已变化，请重新检查目录。",
        { status: 409 },
      );
    return {
      ...value,
      directory: result.directory,
      hostLabel: latest.name,
      ownerId: actor.user.id,
      connectionRevision: revision,
    };
  }
  async create(input, actor) {
    this.requireAdministrator(actor);
    const parsed = createProjectSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        "PROJECT_INPUT_INVALID",
        parsed.error.issues.some((issue) => issue.path[0] === "name")
          ? "请填写 1–120 字的项目名称。"
          : "项目或工作目录配置无效。",
        {
          status: 422,
          detail: {
            field:
              parsed.error.issues[0]?.path[0] === "name"
                ? "name"
                : "workspace.directory",
          },
        },
      );
    const workspace = await this.prepare(parsed.data.workspace, actor);
    const id = parsed.data.id ?? "project_" + randomUUID().replaceAll("-", "");
    if (this.options.collaboration.projectById(id))
      throw new AppError("PROJECT_EXISTS", "项目 ID 已存在。", { status: 409 });
    let createdDirectory: string | null = null;
    try {
      if (workspace.kind !== "local") {
        const directory =
          this.options.collaboration.projectRootFactory?.(id) ??
          this.options.collaboration.defaultProject.root;
        await mkdir(path.dirname(directory), { recursive: true });
        try {
          await mkdir(directory);
          createdDirectory = directory;
        } catch (error) {
          if (error.code !== "EEXIST" || !(await stat(directory)).isDirectory())
            throw error;
        }
      }
      return this.options.collaboration.createProject(
        { ...parsed.data, id, workspace },
        actor,
      );
    } catch (error) {
      if (createdDirectory && !this.options.collaboration.projectById(id))
        await rmdir(createdDirectory).catch(() => {});
      if (error instanceof AppError) throw error;
      throw new AppError(
        "PROJECT_WORKSPACE_UNAVAILABLE",
        "无法创建项目工作区，请检查工作区目录和主机权限。",
        { status: 422 },
      );
    }
  }
  async update(projectId, choice, expectedRevision, actor) {
    this.requireAdministrator(actor);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new AppError(
        "PROJECT_WORKSPACE_CONFLICT",
        "请先读取当前工作目录后再保存。",
        { status: 409 },
      );
    const project = this.options.collaboration.requireProject(actor, projectId);
    if (project.workspace.revision !== expectedRevision)
      throw new AppError(
        "PROJECT_WORKSPACE_CONFLICT",
        "项目工作目录已更新，请重新读取后再保存。",
        { status: 409 },
      );
    const workspace = await this.prepare(choice, actor);
    const identity = (value) => [
      value.kind,
      ["local", "ssh"].includes(value.kind) ? value.directory : null,
      value.connectionId ?? null,
      value.ownerId ?? null,
      value.connectionRevision ?? null,
    ];
    if (
      JSON.stringify(identity(workspace)) ===
      JSON.stringify(identity(project.workspace))
    )
      return {
        id: project.id,
        name: project.name,
        root: project.root,
        status: project.status,
        workspace: project.workspace,
      };
    let result;
    await this.options.replaceRuntime(projectId, () => {
      result = this.options.collaboration.updateProjectWorkspace(
        projectId,
        workspace,
        expectedRevision,
        actor,
      );
    });
    return result;
  }
}
