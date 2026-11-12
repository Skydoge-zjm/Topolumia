import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentHistoryStore } from "../../../src/services/agents/agent-history-store.js";
import { AgentSessionGateway } from "../../../src/services/agents/agent-session-gateway.js";

test("summary polling reuses restored sessions without materializing their histories again", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-summary-cache-"));
  const gateway = new AgentSessionGateway({ historyFile: path.join(root, "history.sqlite"), profileRegistry: { createAdapter: async () => ({ profile: { provider: "fixture" }, start: async () => ({ capabilities: {} }), close: async () => {} }) } });
  t.after(async () => { await gateway.closeAll(); await rm(root, { recursive: true, force: true }); });
  await gateway.initialize();
  const session = await gateway.create({ profileId: "fixture", title: "Retained history" });
  gateway.historyStore.get = () => { throw new Error("Summary polling must not deserialize restored history"); };
  gateway.historyStore.list = () => { throw new Error("Summary polling must not scan full histories"); };
  for (let index = 0; index < 5; index++) assert.equal(gateway.list({ summary: true })[0].id, session.id);
});

test("all conversation history survives restart independently of runtime capacity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "research-workbench-history-"));
  const file = path.join(root, "history.sqlite");
  const stores = [];
  try {
    const first = new AgentHistoryStore(file, { maxEventsPerSession: 2 }); stores.push(first);
    await first.upsert({
      schemaVersion: "agent-session.v1", id: "old", title: "Old", profileId: "fixture", provider: "fixture",
      status: "closed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      turns: [], events: [{ cursor: 1 }, { cursor: 2 }, { cursor: 3 }], context: {}, capabilities: {}, authMethods: [],
    });
    await first.upsert({
      schemaVersion: "agent-session.v1", id: "newer", title: "Newer", profileId: "fixture", provider: "fixture",
      status: "closed", createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z",
      turns: [], events: [], context: {}, capabilities: {}, authMethods: [],
    });
    await first.upsert({
      schemaVersion: "agent-session.v1", id: "newest", title: "Newest", profileId: "fixture", provider: "fixture",
      status: "closed", createdAt: "2026-01-04T00:00:00.000Z", updatedAt: "2026-01-04T00:00:00.000Z",
      turns: [], events: [], context: {}, capabilities: {}, authMethods: [],
    });

    first.updateLimits({ maxEventsPerSession: 1 });
    const second = new AgentHistoryStore(file, { maxEventsPerSession: 2 }); stores.push(second);
    const loaded = await second.load();
    assert.deepEqual(loaded.map((item) => item.id), ["newest", "newer", "old"]);
    assert.equal(second.get("old").title, "Old");
  } finally {
    for (const store of stores) store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a transient history write failure does not poison subsequent saves", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-history-recovery-"));
  const blocker = path.join(root, "blocked");
  const historyFile = path.join(blocker, "history.json");
  const store = new AgentHistoryStore(historyFile);
  try {
    await writeFile(blocker, "temporarily unavailable");
    await assert.rejects(store.upsert({ id: "session", turns: [], events: [] }));
    await unlink(blocker);
    await store.upsert({ id: "session", turns: [], events: [], title: "Recovered" });
    const restored = new AgentHistoryStore(historyFile);
    await restored.load();
    assert.equal(restored.get("session").title, "Recovered");
    restored.close(); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime capacity rejects concurrent sessions while retaining every closed conversation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-runtime-capacity-"));
  const file = path.join(root, "history.sqlite");
  const gateway = new AgentSessionGateway({ maxSessions: 1, historyFile: file, profileRegistry: { createAdapter: async () => ({ profile: { provider: "fixture" }, start: async () => ({ nativeSessionId: "fixture", capabilities: {} }), close: async () => {} }) } });
  let reopened;
  try {
    await gateway.initialize();
    const first = await gateway.create({ profileId: "fixture", title: "First" });
    await assert.rejects(gateway.create({ profileId: "fixture" }), { code: "AGENT_SESSION_LIMIT" });
    await gateway.close(first.id);
    for (const title of ["Second", "Third"]) {
      const session = await gateway.create({ profileId: "fixture", title });
      await gateway.close(session.id);
    }
    gateway.updateSettings({ maxSessions: 1 });
    await gateway.closeAll();
    reopened = new AgentHistoryStore(file);
    assert.equal((await reopened.load()).length, 3);
    assert.equal(reopened.get(first.id).title, "First");
  } finally { await gateway.closeAll(); reopened?.close(); await rm(root, { recursive: true, force: true }); }
});
