import { mkdir } from "node:fs/promises";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "../../lib/errors.js";
import { EventEmitter } from "node:events";

export const ROLES = Object.freeze(["p-admin", "researcher", "guest"]);

const READ_PERMISSIONS = Object.freeze([
  "project.view",
  "research.view",
  "experiment.view",
  "data.readRawSource",
  "agent.readRawContext",
]);

const RESEARCHER_PERMISSIONS = Object.freeze([
  ...READ_PERMISSIONS,
  "research.recordProgress",
  "research.editDraft",
  "research.proposeChange",
  "research.review",
  "research.applyChange",
  "agent.createSession",
  "source.refresh",
  "experiment.preview",
]);

const PROJECT_ADMIN_PERMISSIONS = Object.freeze([
  ...RESEARCHER_PERMISSIONS,
  "project.manageMembers",
  "project.managePermissions",
  "project.manageSettings",
  "audit.view",
  "source.refresh",
  "source.manageConnections",
  "agent.approveHighRiskTool",
  "experiment.run",
  "data.export",
  "data.exportSensitive",
  "data.share",
  "research.withdrawOrSupersede",
]);

const ROLE_PERMISSIONS = Object.freeze({
  "p-admin": PROJECT_ADMIN_PERMISSIONS,
  researcher: RESEARCHER_PERMISSIONS,
  guest: READ_PERMISSIONS,
});

const PERMISSION_SET = new Set(PROJECT_ADMIN_PERMISSIONS);

function nowIso() {
  return new Date().toISOString();
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function passwordHash(password, salt = randomBytes(16).toString("hex")) {
  const derived = scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, encoded) {
  const [, salt, expected] = String(encoded ?? "").split("$");
  if (!salt || !expected) return false;
  const actual = scryptSync(String(password), salt, 64).toString("hex");
  const left = Buffer.from(actual, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    status: row.status,
    serverRole: row.server_role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    root: row.root,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stateVersion: row.state_version ?? null,
    role: row.membership_role ?? null,
  };
}

function publicMembership(row, permissions = null) {
  return {
    projectId: row.project_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(permissions ? { permissions } : {}),
  };
}

function publicPermissionOverride(row) {
  return {
    permission: row.permission,
    effect: row.effect,
    grantedBy: row.granted_by ?? null,
    reason: row.reason ?? null,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export class CollaborationStore extends EventEmitter {
  constructor({ filePath, defaultProject, defaultAdminPassword = "research-workbench-dev", allowDevIdentity = true, projectRootFactory = null } = {}) {
    super();
    this.setMaxListeners(0);
    if (!filePath) throw new TypeError("CollaborationStore requires filePath");
    this.filePath = filePath;
    this.defaultProject = defaultProject ?? { id: "default-project", name: "Research Project", root: process.cwd() };
    this.defaultAdminPassword = defaultAdminPassword;
    this.allowDevIdentity = Boolean(allowDevIdentity);
    this.projectRootFactory = projectRootFactory;
    this.db = null;
    this.agentCredentials = new Map();
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        email TEXT,
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','active','suspended','deleted')),
        server_role TEXT NOT NULL DEFAULT 'user' CHECK (server_role IN ('user','s-admin')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
        state_version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memberships (
        project_id TEXT NOT NULL REFERENCES projects(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL CHECK (role IN ('p-admin','researcher','guest')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','removed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS permission_overrides (
        project_id TEXT NOT NULL REFERENCES projects(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        permission TEXT NOT NULL,
        effect TEXT NOT NULL CHECK (effect IN ('grant','deny')),
        granted_by TEXT NOT NULL REFERENCES users(id),
        reason TEXT,
        expires_at TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id, permission)
      );
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL CHECK (role IN ('p-admin','researcher','guest')),
        status TEXT NOT NULL CHECK (status IN ('pending','accepted','revoked','expired')),
        invited_by TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        accepted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS project_snapshots (
        project_id TEXT PRIMARY KEY REFERENCES projects(id),
        version INTEGER NOT NULL DEFAULT 0,
        state_json TEXT NOT NULL,
        state_hash TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        actor_user_id TEXT,
        principal_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureBootstrap();
    return this;
  }

  ensureReady() {
    if (!this.db) throw new Error("CollaborationStore is not initialized");
  }

  ensureBootstrap() {
    this.ensureReady();
    const timestamp = nowIso();
    const existingAdmin = this.db.prepare("SELECT id FROM users WHERE server_role = 's-admin' ORDER BY created_at LIMIT 1").get();
    let adminId = existingAdmin?.id;
    if (!adminId && this.allowDevIdentity) {
      adminId = "user_sadmin";
      this.db.prepare("INSERT INTO users (id, username, display_name, email, password_hash, status, server_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', 's-admin', ?, ?)")
        .run(adminId, "admin", "Server Administrator", null, passwordHash(this.defaultAdminPassword), timestamp, timestamp);
    }
    const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(this.defaultProject.id);
    if (!project) {
      this.db.prepare("INSERT INTO projects (id, name, root, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
        .run(this.defaultProject.id, this.defaultProject.name, this.defaultProject.root, timestamp, timestamp);
    }
    if (!adminId) return;
    const membership = this.db.prepare("SELECT 1 FROM memberships WHERE project_id = ? AND user_id = ?").get(this.defaultProject.id, adminId);
    if (!membership) {
      this.db.prepare("INSERT INTO memberships (project_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'p-admin', 'active', ?, ?)")
        .run(this.defaultProject.id, adminId, timestamp, timestamp);
    }
  }

  bootstrapAdmin({ username, displayName, email = null, password } = {}) {
    this.ensureReady();
    const count = Number(this.db.prepare("SELECT count(*) AS count FROM users").get().count);
    if (count > 0) throw new AppError("BOOTSTRAP_COMPLETE", "服务器管理员已经初始化。", { status: 409 });
    const normalized = String(username ?? "").trim();
    if (!/^[A-Za-z0-9_.-]{2,80}$/.test(normalized)) throw new AppError("USER_INPUT_INVALID", "用户名格式无效。", { status: 422 });
    if (typeof password !== "string" || password.length < 12) throw new AppError("PASSWORD_INVALID", "首次管理员密码至少需要 12 个字符。", { status: 422 });
    const timestamp = nowIso();
    const id = `user_${randomUUID().replaceAll("-", "")}`;
    this.db.prepare("INSERT INTO users (id, username, display_name, email, password_hash, status, server_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', 's-admin', ?, ?)")
      .run(id, normalized, String(displayName ?? normalized).slice(0, 160), email ? String(email).slice(0, 320) : null, passwordHash(password), timestamp, timestamp);
    const membership = this.membership(this.defaultProject.id, id);
    if (!membership) this.db.prepare("INSERT INTO memberships (project_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'p-admin', 'active', ?, ?)").run(this.defaultProject.id, id, timestamp, timestamp);
    this.audit(null, id, id, "server.bootstrap", { userId: id });
    return publicUser(this.userById(id));
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  userById(userId) {
    this.ensureReady();
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(String(userId));
  }

  hasUsers() {
    this.ensureReady();
    return Number(this.db.prepare("SELECT count(*) AS count FROM users").get().count) > 0;
  }

  userByUsername(username) {
    this.ensureReady();
    return this.db.prepare("SELECT * FROM users WHERE lower(username) = lower(?)").get(String(username));
  }

  userFromRequest(request) {
    const sessionToken = request.headers["x-rw-session"] || (request.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith("rw_session="))?.slice("rw_session=".length);
    if (sessionToken) {
      const row = this.db.prepare("SELECT u.id FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?").get(hashToken(sessionToken), nowIso());
      if (row) return this.userById(row.id);
    }
    const requestedUser = request.headers["x-rw-user-id"];
    return requestedUser ? this.userById(String(requestedUser)) : null;
  }

  listUsers() {
    this.ensureReady();
    return this.db.prepare("SELECT * FROM users WHERE status != 'deleted' ORDER BY display_name, username").all().map(publicUser);
  }

  createUser({ username, displayName, email = null, password, serverRole = "user" } = {}, actor = null) {
    this.ensureReady();
    if (!actor?.isServerAdmin) throw new AppError("FORBIDDEN", "只有 s-admin 可以创建服务器账号。", { status: 403 });
    const normalized = String(username ?? "").trim();
    if (!/^[A-Za-z0-9_.-]{2,80}$/.test(normalized)) throw new AppError("USER_INPUT_INVALID", "用户名格式无效。", { status: 422 });
    if (this.userByUsername(normalized)) throw new AppError("USER_EXISTS", "用户名已存在。", { status: 409 });
    if (serverRole !== "user") throw new AppError("ROLE_INVALID", "只能通过受控流程创建 s-admin。", { status: 422 });
    if (typeof password !== "string" || password.length < 8) throw new AppError("PASSWORD_INVALID", "密码至少需要 8 个字符。", { status: 422 });
    const timestamp = nowIso();
    const id = `user_${randomUUID().replaceAll("-", "")}`;
    this.db.prepare("INSERT INTO users (id, username, display_name, email, password_hash, status, server_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', 'user', ?, ?)")
      .run(id, normalized, String(displayName ?? normalized).slice(0, 160), email ? String(email).slice(0, 320) : null, passwordHash(password), timestamp, timestamp);
    this.audit(null, actor.user.id, actor.user.id, "user.created", { userId: id, username: normalized });
    return publicUser(this.userById(id));
  }

  projectById(projectId) {
    this.ensureReady();
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(String(projectId));
  }

  listProjects(actor) {
    this.ensureReady();
    if (actor?.isServerAdmin) return this.db.prepare("SELECT p.*, m.role AS membership_role FROM projects p LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = ? AND m.status = 'active' WHERE p.status != 'deleted' ORDER BY p.name").all(actor.user.id).map(publicProject);
    return this.db.prepare("SELECT p.*, m.role AS membership_role FROM projects p JOIN memberships m ON m.project_id = p.id WHERE m.user_id = ? AND m.status = 'active' AND p.status != 'deleted' ORDER BY p.name").all(actor?.user?.id ?? "").map(publicProject);
  }

  permissionCatalog() {
    this.ensureReady();
    return [...PERMISSION_SET].sort();
  }

  invitationsForUser(userId) {
    this.ensureReady();
    const now = nowIso();
    const rows = this.db.prepare(`
      SELECT i.*, p.name AS project_name, p.status AS project_status,
             u.display_name AS inviter_display_name, u.username AS inviter_username
      FROM invitations i
      JOIN projects p ON p.id = i.project_id
      JOIN users u ON u.id = i.invited_by
      WHERE i.user_id = ? AND i.status = 'pending'
      ORDER BY i.created_at DESC
    `).all(String(userId));
    const result = [];
    for (const row of rows) {
      if (row.project_status === "deleted") continue;
      if (Date.parse(row.expires_at) <= Date.now()) {
        this.db.prepare("UPDATE invitations SET status = 'expired' WHERE id = ? AND status = 'pending'").run(row.id);
        continue;
      }
      result.push({
        id: row.id,
        projectId: row.project_id,
        projectName: row.project_name,
        role: row.role,
        status: row.status,
        invitedBy: { displayName: row.inviter_display_name, username: row.inviter_username },
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      });
    }
    return result;
  }

  createProject({ id, name } = {}, actor) {
    this.ensureReady();
    if (!actor?.isServerAdmin) throw new AppError("FORBIDDEN", "只有 s-admin 可以创建项目。", { status: 403 });
    const projectId = String(id ?? `project_${randomUUID().replaceAll("-", "")}`).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,100}$/.test(projectId)) throw new AppError("PROJECT_INPUT_INVALID", "项目 ID 格式无效。", { status: 422 });
    if (this.projectById(projectId)) throw new AppError("PROJECT_EXISTS", "项目 ID 已存在。", { status: 409 });
    const projectName = String(name ?? "").trim();
    if (!projectName || projectName.length > 160) throw new AppError("PROJECT_INPUT_INVALID", "项目名称无效。", { status: 422 });
    const timestamp = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const projectRoot = this.projectRootFactory ? this.projectRootFactory(projectId) : this.defaultProject.root;
      this.db.prepare("INSERT INTO projects (id, name, root, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)").run(projectId, projectName, String(projectRoot), timestamp, timestamp);
      this.db.prepare("INSERT INTO memberships (project_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'p-admin', 'active', ?, ?)").run(projectId, actor.user.id, timestamp, timestamp);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.audit(projectId, actor.user.id, actor.user.id, "project.created", { projectId });
    return publicProject(this.projectById(projectId));
  }

  membership(projectId, userId) {
    this.ensureReady();
    return this.db.prepare("SELECT * FROM memberships WHERE project_id = ? AND user_id = ? AND status != 'removed'").get(String(projectId), String(userId));
  }

  overrides(projectId, userId) {
    const rows = this.db.prepare("SELECT * FROM permission_overrides WHERE project_id = ? AND user_id = ? AND active = 1").all(String(projectId), String(userId));
    const now = Date.now();
    return rows.filter((row) => {
      if (row.expires_at && Date.parse(row.expires_at) <= now) return false;
      const grantor = this.userById(row.granted_by);
      const grantorMembership = this.membership(projectId, row.granted_by);
      return grantor?.server_role === "s-admin" || (grantor?.status === "active" && grantorMembership?.role === "p-admin");
    });
  }

  permissions(projectId, userId) {
    const user = this.userById(userId);
    if (!user || user.status !== "active") return [];
    if (user.server_role === "s-admin") return ["*"];
    const member = this.membership(projectId, userId);
    if (!member) return [];
    const result = new Set(ROLE_PERMISSIONS[member.role] ?? []);
    for (const override of this.overrides(projectId, userId)) {
      if (override.effect === "deny") result.delete(override.permission);
      else if (PERMISSION_SET.has(override.permission)) result.add(override.permission);
    }
    return [...result].sort();
  }

  actorForUser(userId, projectId) {
    const user = this.userById(userId);
    if (!user || user.status !== "active") return null;
    const permissions = this.permissions(projectId, userId);
    const membership = this.membership(projectId, userId);
    return {
      user: publicUser(user),
      membership: membership ? publicMembership(membership, permissions) : null,
      permissions,
      isServerAdmin: user.server_role === "s-admin",
      projectId,
    };
  }

  actorFromRequest(request, projectId) {
    const sessionToken = request.headers["x-rw-session"] || (request.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith("rw_session="))?.slice("rw_session=".length);
    if (String(sessionToken ?? "").startsWith("rw_agent_")) {
      const binding = this.agentCredentials.get(hashToken(sessionToken));
      if (!binding || binding.expiresAt <= Date.now()) return null;
      if (binding.projectId !== projectId) throw new AppError("AGENT_PROJECT_SCOPE_MISMATCH", "Agent 凭据不能访问其他项目。", { status: 403 });
      const owner = this.actorForUser(binding.userId, projectId);
      if (!owner || (!owner.isServerAdmin && !owner.membership)) return null;
      return { ...owner, isServerAdmin: false, isAgent: true, principalId: `agent:${binding.researchSessionId}`, sessionId: binding.researchSessionId, runtimeInstanceId: binding.runtimeInstanceId,
        membership: owner.membership ?? { projectId, status: "active", role: "researcher" },
        permissions: binding.permissions.filter((permission) => owner.isServerAdmin || owner.permissions.includes(permission)) };
    }
    if (sessionToken) {
      const row = this.db.prepare("SELECT u.id FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?").get(hashToken(sessionToken), nowIso());
      if (row) return this.actorForUser(row.id, projectId);
    }
    const requestedUser = request.headers["x-rw-user-id"];
    if (requestedUser && this.allowDevIdentity) return this.actorForUser(String(requestedUser), projectId);
    if (this.allowDevIdentity) {
      const admin = this.db.prepare("SELECT id FROM users WHERE server_role = 's-admin' AND status = 'active' ORDER BY created_at LIMIT 1").get();
      if (admin) return this.actorForUser(admin.id, projectId);
    }
    return null;
  }

  issueAgentCredential(actor, projectId, runtimeInstanceId, { researchSessionId = runtimeInstanceId, readOnly = false } = {}) {
    this.requirePermission(actor, "agent.createSession", { projectId });
    const token = `rw_agent_${randomBytes(32).toString("hex")}`;
    this.agentCredentials.set(hashToken(token), { userId: actor.user.id, projectId, researchSessionId, runtimeInstanceId,
      permissions: ["project.view", "research.view", ...(!readOnly ? ["research.proposeChange"] : [])], expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
    return token;
  }

  revokeAgentCredential(sessionId) {
    for (const [hash, binding] of this.agentCredentials) if (binding.runtimeInstanceId === sessionId) this.agentCredentials.delete(hash);
  }

  requireActor(request, projectId) {
    const actor = this.actorFromRequest(request, projectId);
    if (!actor) throw new AppError("AUTH_REQUIRED", "需要登录后访问研究工作区。", { status: 401 });
    return actor;
  }

  requirePermission(actor, permission, { projectId = actor?.projectId } = {}) {
    if (!actor || (!actor.isServerAdmin && actor.projectId !== projectId)) throw new AppError("FORBIDDEN", "当前身份无权访问该项目。", { status: 403 });
    if (actor.isServerAdmin || actor.permissions.includes("*") || actor.permissions.includes(permission)) return true;
    throw new AppError("FORBIDDEN", `缺少权限 ${permission}。`, { status: 403, detail: { permission, projectId } });
  }

  requireProject(actor, projectId) {
    const project = this.projectById(projectId);
    if (!project || project.status === "deleted") throw new AppError("PROJECT_NOT_FOUND", "项目不存在。", { status: 404 });
    if (!actor?.isServerAdmin && (!actor?.membership || actor.membership.projectId !== projectId || actor.membership.status !== "active")) {
      throw new AppError("PROJECT_NOT_FOUND", "项目不存在或当前身份无权访问。", { status: 404 });
    }
    return project;
  }

  members(projectId, actor) {
    this.requirePermission(actor, "project.view", { projectId });
    const canInspectPermissions = actor.isServerAdmin || actor.membership?.role === "p-admin";
    return this.db.prepare("SELECT u.*, m.project_id, m.role, m.status AS membership_status, m.created_at AS membership_created_at, m.updated_at AS membership_updated_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND m.status != 'removed' ORDER BY m.role, u.display_name").all(projectId).map((row) => ({
      user: publicUser(row),
      membership: publicMembership({ project_id: row.project_id, user_id: row.id, role: row.role, status: row.membership_status, created_at: row.membership_created_at, updated_at: row.membership_updated_at }),
      ...(canInspectPermissions ? {
        permissions: this.permissions(projectId, row.id),
        rolePermissions: rolePermissions(row.role),
        permissionOverrides: this.overrides(projectId, row.id).map(publicPermissionOverride),
      } : {}),
    }));
  }

  invite(projectId, { userId, role = "researcher", expiresAt = null } = {}, actor) {
    this.requirePermission(actor, "project.manageMembers", { projectId });
    if (!ROLES.includes(role)) throw new AppError("ROLE_INVALID", "项目角色无效。", { status: 422 });
    const user = this.userById(userId);
    if (!user || user.status !== "active") throw new AppError("USER_NOT_FOUND", "服务器账号不存在或不可用。", { status: 404 });
    if (role === "p-admin" && !actor.isServerAdmin) throw new AppError("FORBIDDEN", "只有 s-admin 可以邀请 p-admin。", { status: 403 });
    const existing = this.membership(projectId, userId);
    if (existing) throw new AppError("MEMBERSHIP_EXISTS", "用户已经是项目成员。", { status: 409 });
    const pendingInvitation = this.db.prepare("SELECT id FROM invitations WHERE project_id = ? AND user_id = ? AND status = 'pending'").get(projectId, userId);
    if (pendingInvitation) throw new AppError("INVITATION_EXISTS", "该用户已经有一条待接受邀请。", { status: 409 });
    const timestamp = nowIso();
    const expires = expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    const id = `invite_${randomUUID().replaceAll("-", "")}`;
    this.db.prepare("INSERT INTO invitations (id, project_id, user_id, role, status, invited_by, expires_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)").run(id, projectId, userId, role, actor.user.id, expires, timestamp);
    this.audit(projectId, actor.user.id, actor.user.id, "membership.invited", { invitationId: id, userId, role });
    return { id, projectId, userId, role, status: "pending", invitedBy: actor.user.id, expiresAt: expires, createdAt: timestamp };
  }

  projectInvitations(projectId, actor) {
    this.requirePermission(actor, "project.manageMembers", { projectId });
    const rows = this.db.prepare(`
      SELECT i.*, u.username, u.display_name
      FROM invitations i
      JOIN users u ON u.id = i.user_id
      WHERE i.project_id = ? AND i.status = 'pending'
      ORDER BY i.created_at DESC
    `).all(String(projectId));
    return rows.filter((row) => Date.parse(row.expires_at) > Date.now()).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      user: { id: row.user_id, username: row.username, displayName: row.display_name },
      role: row.role,
      status: row.status,
      invitedBy: row.invited_by,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  }

  revokeInvitation(projectId, invitationId, actor) {
    this.requirePermission(actor, "project.manageMembers", { projectId });
    const invitation = this.db.prepare("SELECT * FROM invitations WHERE id = ? AND project_id = ?").get(String(invitationId), String(projectId));
    if (!invitation || invitation.status !== "pending") throw new AppError("INVITATION_NOT_FOUND", "邀请不存在或已经处理。", { status: 404 });
    this.db.prepare("UPDATE invitations SET status = 'revoked' WHERE id = ?").run(String(invitationId));
    this.audit(projectId, actor.user.id, actor.user.id, "membership.invitation_revoked", { invitationId, userId: invitation.user_id });
    return { id: invitation.id, projectId, userId: invitation.user_id, status: "revoked" };
  }

  acceptInvitation(projectId, invitationId, actor) {
    const invitation = this.db.prepare("SELECT * FROM invitations WHERE id = ? AND project_id = ? AND user_id = ?").get(invitationId, projectId, actor.user.id);
    if (!invitation || invitation.status !== "pending") throw new AppError("INVITATION_NOT_FOUND", "邀请不存在或已经处理。", { status: 404 });
    if (Date.parse(invitation.expires_at) <= Date.now()) throw new AppError("INVITATION_EXPIRED", "邀请已过期。", { status: 409 });
    const timestamp = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE invitations SET status = 'accepted', accepted_at = ? WHERE id = ?").run(timestamp, invitationId);
      this.db.prepare("INSERT OR REPLACE INTO memberships (project_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'active', COALESCE((SELECT created_at FROM memberships WHERE project_id = ? AND user_id = ?), ?), ?)").run(projectId, actor.user.id, invitation.role, projectId, actor.user.id, timestamp, timestamp);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.audit(projectId, actor.user.id, actor.user.id, "membership.accepted", { invitationId });
    return publicMembership(this.membership(projectId, actor.user.id));
  }

  updateMember(projectId, userId, { role } = {}, actor) {
    this.requirePermission(actor, "project.manageMembers", { projectId });
    if (!ROLES.includes(role)) throw new AppError("ROLE_INVALID", "项目角色无效。", { status: 422 });
    const target = this.membership(projectId, userId);
    if (!target) throw new AppError("MEMBERSHIP_NOT_FOUND", "项目成员不存在。", { status: 404 });
    if (String(userId) === String(actor.user.id)) throw new AppError("FORBIDDEN", "不能直接修改自己的项目角色。", { status: 403 });
    if (!actor.isServerAdmin && target.role === "p-admin") throw new AppError("FORBIDDEN", "p-admin 成员只能由 s-admin 处理。", { status: 403 });
    if (!actor.isServerAdmin && role === "p-admin") throw new AppError("FORBIDDEN", "只有 s-admin 可以设置 p-admin。", { status: 403 });
    if (target.role === "p-admin" && role !== "p-admin") {
      const pAdmins = this.db.prepare("SELECT count(*) AS count FROM memberships WHERE project_id = ? AND role = 'p-admin' AND status = 'active'").get(projectId).count;
      if (Number(pAdmins) <= 1) throw new AppError("LAST_PROJECT_ADMIN", "项目必须保留至少一名 p-admin。", { status: 409 });
    }
    const timestamp = nowIso();
    this.db.prepare("UPDATE memberships SET role = ?, updated_at = ? WHERE project_id = ? AND user_id = ?").run(role, timestamp, projectId, userId);
    this.audit(projectId, actor.user.id, actor.user.id, "membership.role_changed", { userId, previousRole: target.role, role });
    return publicMembership(this.membership(projectId, userId), this.permissions(projectId, userId));
  }

  setPermission(projectId, userId, { permission, effect, reason = null, expiresAt = null } = {}, actor) {
    this.requirePermission(actor, "project.managePermissions", { projectId });
    if (!PERMISSION_SET.has(permission)) throw new AppError("PERMISSION_INVALID", "未知或不可覆盖的权限。", { status: 422 });
    if (!["grant", "deny"].includes(effect)) throw new AppError("PERMISSION_INVALID", "权限 effect 必须是 grant 或 deny。", { status: 422 });
    const target = this.membership(projectId, userId);
    if (!target) throw new AppError("MEMBERSHIP_NOT_FOUND", "项目成员不存在。", { status: 404 });
    if (target.role === "p-admin" && !actor.isServerAdmin) throw new AppError("FORBIDDEN", "p-admin 的权限不能由其他 p-admin 修改。", { status: 403 });
    if (userId === actor.user.id) throw new AppError("FORBIDDEN", "用户不能直接修改自己的权限。", { status: 403 });
    if (!actor.isServerAdmin && effect === "grant" && !this.permissions(projectId, actor.user.id).includes(permission)) throw new AppError("FORBIDDEN", "不能授予自己没有的权限。", { status: 403 });
    const timestamp = nowIso();
    this.db.prepare("INSERT INTO permission_overrides (project_id, user_id, permission, effect, granted_by, reason, expires_at, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(project_id, user_id, permission) DO UPDATE SET effect = excluded.effect, granted_by = excluded.granted_by, reason = excluded.reason, expires_at = excluded.expires_at, active = 1, updated_at = excluded.updated_at")
      .run(projectId, userId, permission, effect, actor.user.id, reason ? String(reason).slice(0, 500) : null, expiresAt, timestamp, timestamp);
    this.audit(projectId, actor.user.id, actor.user.id, "permission.changed", { userId, permission, effect, expiresAt });
    return { projectId, userId, permission, effect, expiresAt, permissions: this.permissions(projectId, userId) };
  }

  removePermission(projectId, userId, permission, actor) {
    this.requirePermission(actor, "project.managePermissions", { projectId });
    this.db.prepare("UPDATE permission_overrides SET active = 0, updated_at = ? WHERE project_id = ? AND user_id = ? AND permission = ?").run(nowIso(), projectId, userId, permission);
    this.audit(projectId, actor.user.id, actor.user.id, "permission.removed", { userId, permission });
    return { projectId, userId, permission, permissions: this.permissions(projectId, userId) };
  }

  removeMember(projectId, userId, actor) {
    this.requirePermission(actor, "project.manageMembers", { projectId });
    const target = this.membership(projectId, userId);
    if (!target) throw new AppError("MEMBERSHIP_NOT_FOUND", "项目成员不存在。", { status: 404 });
    if (target.role === "p-admin" && !actor.isServerAdmin) throw new AppError("FORBIDDEN", "p-admin 成员只能由 s-admin 处理。", { status: 403 });
    const pAdmins = this.db.prepare("SELECT count(*) AS count FROM memberships WHERE project_id = ? AND role = 'p-admin' AND status = 'active'").get(projectId).count;
    if (target.role === "p-admin" && Number(pAdmins) <= 1) throw new AppError("LAST_PROJECT_ADMIN", "项目必须保留至少一名 p-admin。", { status: 409 });
    this.db.prepare("UPDATE memberships SET status = 'removed', updated_at = ? WHERE project_id = ? AND user_id = ?").run(nowIso(), projectId, userId);
    this.audit(projectId, actor.user.id, actor.user.id, "membership.removed", { userId, anonymizeResearchRecords: true });
    return { projectId, userId, status: "removed" };
  }

  login(username, password, { ttlMs = 8 * 60 * 60 * 1_000 } = {}) {
    const user = this.userByUsername(username);
    if (!user || user.status !== "active" || !verifyPassword(password, user.password_hash)) throw new AppError("AUTH_INVALID", "用户名或密码不正确。", { status: 401 });
    const token = randomBytes(32).toString("base64url");
    const id = `session_${randomUUID().replaceAll("-", "")}`;
    const created = nowIso();
    const expires = new Date(Date.now() + Math.max(5 * 60_000, Number(ttlMs) || 0)).toISOString();
    this.db.prepare("INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(id, user.id, hashToken(token), created, expires);
    return { token, user: publicUser(user), expiresAt: expires };
  }

  logout(token) {
    if (!token) return;
    this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?").run(nowIso(), hashToken(token));
    this.emit("access-changed");
  }

  loadState(projectId) {
    const row = this.db.prepare("SELECT state_json FROM project_snapshots WHERE project_id = ?").get(projectId);
    return parseJson(row?.state_json, null);
  }

  saveState(projectId, stateView) {
    const payload = json(stateView);
    const version = Number(this.db.prepare("SELECT version FROM project_snapshots WHERE project_id = ?").get(projectId)?.version ?? 0) + 1;
    const timestamp = nowIso();
    this.db.prepare("INSERT INTO project_snapshots (project_id, version, state_json, state_hash, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET version = excluded.version, state_json = excluded.state_json, state_hash = excluded.state_hash, updated_at = excluded.updated_at")
      .run(projectId, version, payload, hashToken(payload), timestamp);
    this.db.prepare("UPDATE projects SET state_version = ?, updated_at = ? WHERE id = ?").run(stateView?.topology?.stateVersion ?? stateView?.snapshot?.stateVersion ?? null, timestamp, projectId);
    return { version, updatedAt: timestamp };
  }

  audit(projectId, actorUserId, principalId, type, payload) {
    this.db.prepare("INSERT INTO audit_events (id, project_id, actor_user_id, principal_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(`audit_${randomUUID().replaceAll("-", "")}`, projectId, actorUserId ?? null, principalId ?? null, type, json(payload), nowIso());
    this.emit("access-changed");
  }

  auditEvents(projectId, actor) {
    this.requirePermission(actor, "audit.view", { projectId });
    return this.db.prepare("SELECT * FROM audit_events WHERE project_id = ? ORDER BY created_at DESC LIMIT 500").all(projectId).map((row) => ({ id: row.id, projectId: row.project_id, actorUserId: row.actor_user_id, principalId: row.principal_id, type: row.type, payload: parseJson(row.payload_json, {}), createdAt: row.created_at }));
  }
}

export function rolePermissions(role) {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}
