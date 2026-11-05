import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import sharp from "sharp";
import { startMvpServer } from "../../../src/server.js";
import { AgentHistoryStore } from "../../../src/services/agents/agent-history-store.js";
import { AgentAttachmentStore } from "../../../src/services/agents/agent-attachment-service.js";
import { AgentSessionPersistence } from "../../../src/services/agents/agent-session-persistence.js";

test("runtime startup retries after filesystem recovery; review permissions and live access revocation agree", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-reliability-"));
  const app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: path.join(root, "db.sqlite"),
    userSettingsFile: path.join(root, "settings.json"),
    config: {
      project: { workspacesRoot: path.join(root, "workspaces") },
      sourceRefresh: { enabled: false },
      curator: { enabled: false },
      agentSessions: { profiles: [] },
    },
  });
  t.after(async () => {
    for (const runtime of app.runtimes.values()) {
      await runtime.agentSessionGateway.closeAll();
      await runtime.agentMedia.close();
      await runtime.researchCommands.assets.close();
      await runtime.toolEnvironment.catalog.close();
      await runtime.toolEnvironment.research.close();
    }
    await app.sshEnvironments.close();
    await app.sshConnections.close();
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const admin = app.collaboration.bootstrapAdmin({
    username: "review",
    password: "Reliability-Fixture-Only-2026!",
  });
  const pid = app.config.project.id,
    actor = app.collaboration.actorForUser(admin.id, pid);
  const retryProject = app.collaboration.createProject(
    { id: "retry-project", name: "Retry fixture" },
    actor,
  );
  const retryRoot = app.collaboration.projectById(retryProject.id).root;
  await mkdir(path.dirname(retryRoot), { recursive: true });
  await writeFile(retryRoot, "obstruction");
  await assert.rejects(app.getRuntime(retryProject.id));
  await rm(retryRoot);
  await mkdir(retryRoot);
  assert.equal(
    (await app.getRuntime(retryProject.id)).project.id,
    retryProject.id,
  );

  const member = app.collaboration.createUser(
    {
      username: "member",
      displayName: "Member",
      password: "Reliability-Member-Only-2026!",
    },
    actor,
  );
  const invite = app.collaboration.invite(
    pid,
    { userId: member.id, role: "researcher" },
    actor,
  );
  app.collaboration.acceptInvitation(
    pid,
    invite.id,
    app.collaboration.actorForUser(member.id, pid),
  );
  app.collaboration.setPermission(
    pid,
    member.id,
    { permission: "research.applyChange", effect: "grant" },
    actor,
  );
  app.collaboration.setPermission(
    pid,
    member.id,
    { permission: "research.review", effect: "deny" },
    actor,
  );
  const token = app.collaboration.login(
    "member",
    "Reliability-Member-Only-2026!",
  ).token;
  const headers = {
    "x-rw-session": token,
    "x-rw-project-id": pid,
    "content-type": "application/json",
  };
  const runtime = app.runtimes.get(pid),
    commands = runtime.researchCommands;
  const candidate = commands.createCandidate({
    actor,
    reason: "Permission fixture",
    nodes: [
      {
        kind: "paper",
        core: { nodeName: "Paper", paperTitle: "Source title" },
      },
    ],
  });
  const response = await fetch(
    `${app.url}/api/research/candidates/${encodeURIComponent(candidate.id)}/review`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "accept", expectedRevision: 1 }),
    },
  );
  assert.equal(response.status, 200);
  const rejected = await fetch(
    `${app.url}/api/research/candidates/${encodeURIComponent(candidate.id)}/review`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "reject", expectedRevision: 1 }),
    },
  );
  assert.equal(rejected.status, 403);

  const session = {
    id: "agent_session_revoke",
    ownerUserId: admin.id,
    title: "Stream fixture",
    profileId: "fixture",
    status: "detached",
    createdAt: "",
    updatedAt: "",
    turns: [],
    queuedMessages: [],
    events: [],
    conversationEvents: [],
    pendingApprovals: new Map(),
    subscribers: new Set(),
    cursor: 0,
  };
  runtime.agentSessionGateway.sessions.set(session.id, session);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const stream = await fetch(
    `${app.url}/api/agent-sessions/${session.id}/events`,
    { headers, signal: abort.signal },
  );
  const reader = stream.body!.getReader();
  await reader.read();
  app.collaboration.removeMember(pid, member.id, actor);
  assert.equal(session.subscribers.size, 0);
  const frame = await reader.read();
  assert.ok(new TextDecoder().decode(frame.value).includes("access.revoked"));
  assert.equal((await reader.read()).done, true);
});

test("history checkpoints update changed rows and continue saving during a continuous stream", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-history-rows-"));
  const store = new AgentHistoryStore(path.join(root, "history.sqlite"));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const events = Array.from({ length: 200 }, (_, cursor) => ({
    id: `e${cursor}`,
    cursor: cursor + 1,
    type: "assistant.message.completed",
    sessionId: "s",
    turnId: "t",
    payload: { blockId: `b${cursor}`, text: "x".repeat(1000) },
  }));
  const session = {
    id: "s",
    turns: [],
    events,
    conversationEvents: events,
    traceFormat: "final.v1",
    lastCursor: 200,
  };
  await store.upsert(session);
  const rows = store.metrics.rowsWritten,
    bytes = store.metrics.bytesWritten;
  const changed = {
    ...events.at(-1),
    cursor: 201,
    payload: { ...events.at(-1).payload, text: "updated" },
  };
  session.events = [...events.slice(0, -1), changed];
  session.conversationEvents = session.events;
  session.lastCursor = 201;
  await store.upsert(session);
  assert.ok(store.metrics.rowsWritten - rows <= 4);
  assert.ok(store.metrics.bytesWritten - bytes < 5000);
  assert.equal(
    store.get("s").conversationEvents.at(-1).payload.text,
    "updated",
  );
  let saves = 0;
  const persistence = new AgentSessionPersistence(
    {
      upsert: async () => {
        saves++;
      },
      close() {},
    },
    () => {},
  );
  const timer = setInterval(() => persistence.schedule(session), 20);
  await new Promise((resolve) => setTimeout(resolve, 650));
  clearInterval(timer);
  assert.ok(saves > 0);
  await persistence.close([session]);
});

test("image snapshots survive source deletion; real thumbnails and draft cleanup preserve referenced images", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "topolumia-media-lifecycle-"),
  );
  const store = new AgentAttachmentStore(path.join(root, "history.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const png = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: "#cce8da" },
  })
    .png()
    .toBuffer();
  const source = path.join(root, "source.png");
  await writeFile(source, png);
  const event = {
    id: "e",
    sessionId: "s",
    cursor: 1,
    turnId: "t",
    type: "tool.completed",
    occurredAt: "",
    payload: {
      kind: "imageView",
      toolCallId: "view",
      item: { type: "imageView", path: source },
    },
  };
  const image = await store.snapshot("s", event, root);
  await rm(source);
  assert.equal(
    (await store.snapshot("s", event, root)).checksum,
    image.checksum,
  );
  assert.deepEqual(
    await readFile((await store.content("s", image.id)).file),
    png,
  );
  const thumb = await sharp(
    await readFile((await store.content("s", image.id, "thumbnail")).file),
  ).metadata();
  assert.ok(thumb.width! <= 384 && thumb.height! <= 288);
  const upload = () =>
    store.upload(
      Object.assign(Readable.from([png]), {
        headers: { "x-image-name": "figure.png" },
      }),
      "s",
    );
  const referenced = await upload(),
    orphan = await upload();
  await assert.rejects(
    store.removeDraft("s", referenced.id, new Set([referenced.id])),
    { code: "AGENT_ATTACHMENT_REFERENCED" },
  );
  await store.collect(
    [{ id: "s", turns: [{ attachments: [referenced] }] }],
    Date.now() + 2 * 86_400_000,
  );
  await assert.rejects(store.manifest("s", orphan.id), {
    code: "AGENT_ATTACHMENT_NOT_FOUND",
  });
  assert.equal((await store.content("s", referenced.id)).id, referenced.id);
});
