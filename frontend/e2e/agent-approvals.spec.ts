import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { startMvpServer } from "../../dist/src/server.js";
import { OpenCodeAgentAdapter } from "../../dist/src/adapters/agents/opencode/v1/opencode-agent-adapter.js";

// Protocol fixtures exercise the real adapters and Gateway. No model or real
// shell command is executed and no persistent permission is saved.
let app, nativeServer, root: string;
const clients = new Set<ServerResponse>(), nativeSessions = new Map();
let seq = 0;
const send = (type, properties) => { for (const client of clients) client.write(`data: ${JSON.stringify({ id: `evt_${++seq}`, type, properties })}\n\n`); };

test.beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "topolumia-approval-browser-"));
  nativeServer = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    let text = ""; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const json = value => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/event") { res.writeHead(200, { "content-type": "text/event-stream" }); clients.add(res); res.write('data: {"type":"server.connected","properties":{}}\n\n'); res.on("close", () => clients.delete(res)); return; }
    if (url.pathname === "/config/providers") return json({ providers: [{ id: "fixture", name: "Fixture", models: { "gpt-6-luna": { id: "gpt-6-luna", name: "Luna", status: "active", capabilities: { input: { text: true } }, variants: { low: {} } } } }], default: { fixture: "gpt-6-luna" } });
    if (url.pathname === "/config") return json({ model: "fixture/gpt-6-luna" });
    if (url.pathname === "/mcp") return json({ [body.name]: { status: "connected" } });
    if (url.pathname === "/session/status") return json(Object.fromEntries([...nativeSessions].filter(([, s]) => s.busy).map(([id]) => [id, { type: "busy" }])));
    if (url.pathname === "/permission") return json([...nativeSessions.values()].flatMap(s => s.pending ? [s.pending] : []));
    if (url.pathname === "/session" && req.method === "POST") {
      const id = `ses_${++seq}`; nativeSessions.set(id, { id, directory: app.config.project.root, messages: [], busy: false }); return json({ id, directory: app.config.project.root });
    }
    if (url.pathname.startsWith("/permission/")) {
      const s = [...nativeSessions.values()].find(s => url.pathname.includes(s.pending?.id));
      if (!s) return json(true);
      const requestID = s.pending.id; s.pending = null;
      send("permission.replied", { sessionID: s.id, requestID, reply: body.reply });
      const info = { id: `msg_${++seq}`, sessionID: s.id, parentID: s.messages.at(-1).info.id, role: "assistant", time: { created: 1, completed: 2 }, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 };
      const part = { id: `part_${++seq}`, sessionID: s.id, messageID: info.id, type: "text", text: `Native reply: ${body.reply}`, time: { start: 1, end: 2 } };
      s.messages.push({ info, parts: [part] }); s.busy = false;
      send("message.updated", { sessionID: s.id, info }); send("message.part.updated", { sessionID: s.id, part }); send("session.idle", { sessionID: s.id });
      setTimeout(() => json(true), 50); return;
    }
    const match = url.pathname.match(/^\/session\/([^/]+)(.*)$/), s = match ? nativeSessions.get(match[1]) : null;
    if (s) {
      if (match![2] === "/message") return json(s.messages);
      if (match![2] === "/prompt_async") {
        s.busy = true; s.messages.push({ info: { id: body.messageID, role: "user", sessionID: s.id, time: { created: 1 } }, parts: body.parts });
        res.writeHead(204); res.end();
        setTimeout(() => { s.pending = { id: `per_${++seq}`, sessionID: s.id, permission: "bash", patterns: ["python experiment.py --dry-run"], metadata: { command: "python experiment.py --dry-run" }, always: ["python experiment.py *"] }; send("permission.asked", s.pending); }, 50); return;
      }
      if (match![2] === "/abort") { s.busy = false; s.pending = null; return json(true); }
      return json({ id: s.id, directory: s.directory });
    }
    res.writeHead(404); res.end();
  });
  nativeServer.listen(0, "127.0.0.1"); await once(nativeServer, "listening");
  const nativeClient = createOpencodeClient({ baseUrl: `http://127.0.0.1:${nativeServer.address().port}`, directory: process.cwd(), throwOnError: true });
  app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: { project: { workspacesRoot: path.join(root, "workspaces") }, sourceRefresh: { enabled: false }, agentSessions: { profiles: [
    { id: "codex-approval", label: "Codex", provider: "codex", driver: "codex-app-server", command: process.execPath, args: [path.resolve("dist/fixtures/native/codex-app-server.js")], model: "gpt-6-luna" },
    { id: "codex-permissions", label: "Codex permissions", provider: "codex", driver: "codex-app-server", command: process.execPath, args: [path.resolve("dist/fixtures/native/codex-app-server.js")], model: "gpt-6-luna", env: { CODEX_FIXTURE_APPROVAL_KIND: "permissions" } },
    { id: "claude-approval", label: "Claude Code", provider: "claude", driver: "claude-cli-stream", command: process.execPath, launcherArgs: [path.resolve("dist/fixtures/native/claude-cli.js")], model: "gpt-6-luna" },
    { id: "opencode-approval", label: "OpenCode", provider: "opencode", driver: "acp-stdio", command: process.execPath, model: "gpt-6-luna", models: [{ id: "fixture/gpt-6-luna", label: "Luna" }] },
  ] } } });
  const registry = app.agentSessionGateway.profileRegistry, original = registry.createAdapter.bind(registry);
  registry.createAdapter = async (id, options) => id === "opencode-approval" ? new OpenCodeAgentAdapter(registry.profiles.get(id), { ...options, serverFactory: () => ({ start: async () => nativeClient, close: async () => {} }) }) : original(id, options);
  await fetch(`${app.url}/api/auth/bootstrap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "approvals", displayName: "Approval Tester", password: "Approval-Fixture-Only-2026!" }) });
});

test.afterAll(async () => {
  await app.agentSessionGateway.closeAll(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(resolve));
  for (const client of clients) client.end(); nativeServer.closeAllConnections(); await new Promise<void>(resolve => nativeServer.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test.beforeEach(async ({ page }) => { await page.request.post(`${app.url}/api/auth/login`, { data: { username: "approvals", password: "Approval-Fixture-Only-2026!" } }); });
async function openSession(page, profileId, title) {
  const response = await page.request.post(`${app.url}/api/agent-sessions`, { data: { profileId, title } }); expect(response.ok()).toBe(true);
  const session = await response.json(); await page.goto(`${app.url}/#/agents`); await expect(page.getByRole("heading", { name: title })).toBeVisible(); return session;
}

for (const provider of ["codex", "claude", "opencode"]) test(`${provider} native approval supports session scope, refresh and rejection`, async ({ page }) => {
  const session = await openSession(page, `${provider}-approval`, `${provider} approval audit`);
  const input = page.getByRole("textbox", { name: "研究消息" });
  await input.fill(provider === "claude" ? "approval-check" : "approve"); await input.press("Enter");
  const card = page.locator(".agent-approval.is-pending"); await expect(card).toBeVisible();
  await expect(card).toContainText("python"); await page.reload(); await expect(card).toBeVisible();
  await page.screenshot({ path: `test-results/${provider}-approval-pending.png`, fullPage: true });
  await card.getByRole("button", { name: "本会话允许", exact: true }).click();
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready"); await expect(card).toHaveCount(0);
  await expect(page.locator(".agent-approval.is-resolved > summary")).toContainText("当前会话");
  await input.fill(provider === "claude" ? "approval-check" : "approve"); await input.press("Enter");
  await card.getByRole("button", { name: "拒绝本次", exact: true }).click();
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await expect(page.locator(".agent-approval.is-resolved")).toHaveCount(2);
  const detail = await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json();
  expect(detail.pendingApprovals).toEqual([]);
  const approvals = detail.events.filter(e => e.type === "approval.resolved");
  expect(approvals.map(e => e.payload.decision)).toEqual(["allow", "reject"]);
  expect(new Set(approvals.map(e => e.payload.requestId)).size).toBe(2);
  await page.screenshot({ path: `test-results/${provider}-approvals.png`, fullPage: true });
});

test("Codex permission profiles grant only the selected category for this turn", async ({ page }) => {
  const session = await openSession(page, "codex-permissions", "Permission profile audit");
  const input = page.getByRole("textbox", { name: "研究消息" }); await input.fill("approve"); await input.press("Enter");
  const card = page.locator(".agent-approval.is-pending"); await expect(card).toBeVisible();
  await card.getByLabel("文件系统访问", { exact: true }).uncheck();
  await card.getByRole("button", { name: "允许本回合", exact: true }).click();
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  const detail = await (await page.request.get(`${app.url}/api/agent-sessions/${session.id}`)).json();
  const outcome = detail.events.find(e => e.type === "approval.resolved");
  expect(outcome.payload).toMatchObject({ selectedScope: "turn", permissionKeys: ["network"] });
  expect(detail.turns[0].assistantText).toContain('"permissions":{"network":{"enabled":true}}');
});

test("Claude parallel approvals stop together and leave queued messages paused", async ({ page }) => {
  await openSession(page, "claude-approval", "Parallel approval stop");
  const input = page.getByRole("textbox", { name: "研究消息" }); await input.fill("approval-parallel"); await input.press("Enter");
  const cards = page.locator(".agent-approval.is-pending"); await expect(cards).toHaveCount(2);
  await input.fill("Stay queued"); await page.getByRole("button", { name: "排队发送", exact: true }).click();
  await cards.first().getByRole("button", { name: "停止本回合", exact: true }).click();
  await expect(cards).toHaveCount(0); await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await expect(page.getByRole("region", { name: "待发送消息" })).toContainText("已暂停");
  await expect(page.locator(".message.user")).toHaveCount(1);
});

test("Claude's edit mode is described separately and carries into the next turn", async ({ page }) => {
  await openSession(page, "claude-approval", "Explicit session edit mode");
  const input = page.getByRole("textbox", { name: "研究消息" }); await input.fill("approval-edits"); await input.press("Enter");
  const card = page.locator(".agent-approval.is-pending"); await expect(card).toContainText("后续的文件写入与编辑");
  await card.getByRole("button", { name: "本会话自动允许编辑", exact: true }).click();
  await expect(page.locator(".conversation-status")).toHaveAttribute("data-session-status", "ready");
  await expect(page.locator(".agent-approval.is-resolved > summary")).toContainText("自动允许文件编辑");
  await input.fill("approval-settings"); await input.press("Enter");
  await expect(page.locator(".message-body").last()).toContainText('"permissionMode":"acceptEdits"');
});
