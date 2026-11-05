import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../src/server.js";

test("relations share research revisions, stale deletions conflict, and block patches retain scientific data", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-object-consistency-"));
  const app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: { project: { workspacesRoot: path.join(root, "workspaces") }, sourceRefresh: { enabled: false }, curator: { enabled: false }, agentSessions: { profiles: [] } } });
  t.after(async () => {
    for (const runtime of app.runtimes.values()) { await runtime.agentSessionGateway.closeAll(); await runtime.researchCommands.assets.close(); await runtime.agentMedia.close(); await runtime.toolEnvironment.catalog.close(); await runtime.toolEnvironment.research.close(); }
    app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const admin = app.collaboration.bootstrapAdmin({ username: "consistency", password: "Consistency-Fixture-2026!" });
  const pid = app.config.project.id, actor = app.collaboration.actorForUser(admin.id, pid), token = app.collaboration.login("consistency", "Consistency-Fixture-2026!").token;
  const request = async (method, route, body) => {
    const response = await fetch(app.url + route, { method, headers: { "x-rw-session": token, "x-rw-project-id": pid, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const a = app.researchNodes.createNode("paper", { nodeName: "Paper" }, actor), b = app.researchNodes.createNode("experiment", { nodeName: "Experiment" }, actor);
  const c = app.researchCommands.createCandidate({ actor, reason: "Delete an obsolete paper", deleteNodes: [{ nodeId: a.node.id, expectedNodeRevision: 1 }] });
  const relation = await request("POST", "/api/research-relations", { from: { kind: "node", id: a.node.id }, to: { kind: "node", id: b.node.id }, type: "tested_by", expectedEndpointRevisions: Object.entries({ [a.node.id]: 1, [b.node.id]: 1 }).map(([id, revision]) => ({ object: { kind: "node", id }, revision })) });
  assert.equal(relation.status, 201, JSON.stringify(relation.data));
  for (const id of [a.node.id, b.node.id]) { assert.equal(app.researchNodes.detail(id).nodeRevision, 2); assert.equal(app.researchNodes.node(id).relationRevision, 2); }
  assert.equal((await request("DELETE", `/api/research-nodes/${encodeURIComponent(a.node.id)}`, { expectedNodeRevision: 1, reason: "Stale deletion" })).status, 409);
  assert.throws(() => app.researchCommands.reviewCandidate({ actor, patchId: c.id, expectedRevision: 1, decision: "accept" }), { code: "OBJECT_VERSION_CONFLICT" });
  assert.equal(app.researchCommands.changes.candidate(c.id, actor).status, "pending");
  assert.ok(app.state.topology.edges.some(edge => edge.id === relation.data.relation.id));
  const block = (await request("POST", `/api/research-objects/node/${encodeURIComponent(a.node.id)}/content-blocks`, { title: "FID", type: "metric", payload: { items: [{ name: "FID", value: 5.2, condition: "Same compute", note: "3 seeds", sourceRefIds: ["source:paper"] }] }, sourceRefs: [{ id: "source:paper", kind: "table", value: "Table 2" }] })).data.contentBlock;
  const renamed = await request("PATCH", `/api/research-objects/node/${encodeURIComponent(a.node.id)}/content-blocks/${encodeURIComponent(block.id)}`, { expectedRevision: block.revision, patch: { title: "Renamed metrics" } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.deepEqual(renamed.data.contentBlock.payload, block.payload);
  assert.deepEqual(renamed.data.contentBlock.sourceRefs, block.sourceRefs);
  const latest = app.researchNodes.node(a.node.id);
  app.researchNodes.deleteNode(a.node.id, { expectedNodeRevision: latest.revision, reason: "Reviewed deletion" }, actor);
  assert.equal(app.researchNodes.node(b.node.id).revision, 3);
  assert.equal(app.researchNodes.node(b.node.id).relationRevision, 3);
  assert.equal(app.state.topology.edges.length, 0);
});
