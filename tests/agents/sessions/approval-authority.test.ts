import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../../src/server.js";
import { approvalRisk } from "../../../src/services/agents/approval-policy.js";

test("native permission escalation checks current role permissions before reaching any driver", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-approval-authority-"));
  const app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: { project: { workspacesRoot: path.join(root, "workspaces") }, sourceRefresh: { enabled: false }, curator: { enabled: false }, agentSessions: { profiles: [] } } });
  t.after(async () => {
    for (const r of app.runtimes.values()) { await r.agentSessionGateway.closeAll(); await r.agentMedia.close(); await r.researchCommands.assets.close(); await r.toolEnvironment.catalog.close(); await r.toolEnvironment.research.close(); }
    app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await rm(root, { recursive: true, force: true });
  });
  const admin = app.collaboration.bootstrapAdmin({ username: "approver", password: "Approval-Fixture-Only-2026!" });
  const pid = app.config.project.id, actor = app.collaboration.actorForUser(admin.id, pid);
  const member = app.collaboration.createUser({ username: "member", password: "Approval-Member-Only-2026!" }, actor);
  const invitation = app.collaboration.invite(pid, { userId: member.id, role: "researcher" }, actor);
  app.collaboration.acceptInvitation(pid, invitation.id, app.collaboration.actorForUser(member.id, pid));
  const setPermission = effect => app.collaboration.setPermission(pid, member.id, { permission: "agent.approveHighRiskTool", effect }, actor);
  setPermission("deny");
  const token = app.collaboration.login("member", "Approval-Member-Only-2026!").token;
  const gateway = app.agentSessionGateway, calls = [];
  let emit;
  gateway.profileRegistry = { createAdapter: async (_id, options) => { emit = options.onEvent; return { profile: { provider: "fixture" }, start: async () => ({ nativeSessionId: "fixture", capabilities: {} }), prompt: () => new Promise(() => {}), close: async () => {}, resolvePermission: async (...args) => { calls.push(args); } }; } };
  const session = await gateway.create({ profileId: "fixture", ownerUserId: member.id });
  const turn = gateway.startTurn(session.id, { text: "Permission fixture" });
  await new Promise(resolve => setImmediate(resolve));
  const approve = async (id, decision = "allow", optionId = "once") => {
    const response = await fetch(`${app.url}/api/agent-sessions/${session.id}/approvals/${id}`, { method: "POST", headers: { "x-rw-session": token, "x-rw-project-id": pid, "content-type": "application/json" }, body: JSON.stringify({ decision, optionId }) });
    return response.status;
  };
  const options = [{ optionId: "once", kind: "allow_once", scope: "once" }, { optionId: "reject", kind: "reject_once", scope: "once" }, { optionId: "saved", kind: "reject_always", scope: "persistent" }];
  const fixtures = [
    { requestId: "codex", category: "permissions", permissions: { fileSystem: { write: [path.join(root, "outside")] } } },
    { requestId: "claude", category: "command", command: "python train.py", risk: "project-write" },
    { requestId: "opencode", category: "tool", toolName: "external_directory", paths: [path.join(root, "outside")] },
  ];
  for (const fixture of fixtures) {
    emit({ type: "approval.requested", turnId: turn.id, payload: { ...fixture, options } });
    assert.equal(await approve(fixture.requestId), 403);
    assert.equal(calls.length, fixtures.indexOf(fixture));
    assert.equal(await approve(fixture.requestId, "reject", "saved"), 403);
    assert.equal(await approve(fixture.requestId, "reject", "reject"), 200);
  }
  emit({ type: "approval.requested", turnId: turn.id, payload: { requestId: "project-edit", category: "file-change", paths: [path.join(app.config.project.root, "new.py")], options } });
  assert.equal(approvalRisk({ category: "file-change", paths: [path.join(app.config.project.root, "new.py")] }, app.config.project.root), "project-write");
  if (process.platform !== "win32") assert.equal(approvalRisk({ category: "file-change", paths: ["C:\\external\\new.py"] }, app.config.project.root), "elevated");
  assert.equal(await approve("project-edit"), 200);
  const broadOptions = [{ optionId: "session", kind: "allow_session" }, { optionId: "always", kind: "allow_always" }, { optionId: "deny-always", kind: "reject_always" }];
  emit({ type: "approval.requested", turnId: turn.id, payload: { requestId: "broad-edit", category: "file-change", paths: [path.join(app.config.project.root, "new.py")], options: [...options, ...broadOptions] } });
  for (const option of broadOptions) assert.equal(await approve("broad-edit", option.kind === "reject_always" ? "reject" : "allow", option.optionId), 403);
  emit({ type: "approval.requested", turnId: turn.id, payload: { requestId: "granted", category: "command", command: "python train.py", options } });
  setPermission("grant");
  assert.equal(await approve("granted"), 200);
  emit({ type: "approval.requested", turnId: turn.id, payload: { requestId: "revoked", category: "command", command: "python train.py", options } });
  setPermission("deny");
  const before = calls.length;
  assert.equal(await approve("revoked"), 403);
  assert.equal(calls.length, before);

  const outside = path.join(root, "outside"); await mkdir(outside);
  assert.equal(approvalRisk({ category: "file-change", cwd: outside, paths: ["new.py"] }, app.config.project.root), "elevated");
  await symlink(outside, path.join(app.config.project.root, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(approvalRisk({ category: "file-change", paths: [path.join(app.config.project.root, "linked", "new.py")] }, app.config.project.root), "elevated");
});
