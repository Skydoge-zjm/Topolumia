import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startMvpServer } from "../../src/server.js";
import { nodeKinds } from "../../src/domain/research/node-fields.js";
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-notebook-"));
  const app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: { project: { workspacesRoot: path.join(root, "workspaces") }, sourceRefresh: { enabled: false }, curator: { enabled: false }, agentSessions: { profiles: [] } } });
  const user = app.collaboration.bootstrapAdmin({ username: "notebook-admin", password: "Notebook-Tests-2026!" });
  const token = app.collaboration.login("notebook-admin", "Notebook-Tests-2026!").token;
  const request = async (method, route, body = undefined, projectId = app.config.project.id, session = token) => {
    const response = await fetch(app.url + route, { method, headers: { "content-type": "application/json", "x-rw-project-id": projectId, "x-rw-session": session }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => {
    for (const runtime of app.runtimes.values()) { await runtime.agentSessionGateway.closeAll(); await runtime.toolEnvironment.catalog.close(); await runtime.toolEnvironment.research.close(); }
    await app.sshEnvironments.close(); await app.sshConnections.close(); app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { app, request, user };
}
test("typed research cores and content blocks survive source refresh in the default project", async t => {
  const { app, request, user } = await fixture(t);
  assert.equal(app.topologyService.demo, false);
  assert.equal(app.state.topology.nodes.length, 0);
  const ids = [];
  for (const kind of Object.keys(nodeKinds)) {
    const core = { nodeName: `${kind} test`, ...(kind === "paper" ? { paperTitle: "Source paper", authors: ["Researcher"] } : { summary: "Scientific context" }) };
    const created = await request("POST", "/api/research-nodes", { kind, core });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.node.id;
    ids.push(id);
    assert.equal((await request("POST", `/api/research-objects/node/${encodeURIComponent(id)}/content-blocks`, { title: "Research material", type: "richText", payload: { format: "markdown", body: "## Full content" } })).status, 201);
    assert.equal((await request("PATCH", `/api/research-nodes/${encodeURIComponent(id)}/core`, { expectedCoreRevision: 1, patch: { nodeName: `${kind} edited` } })).status, 200);
    assert.equal((await request("PATCH", `/api/research-nodes/${encodeURIComponent(id)}/core`, { expectedCoreRevision: 1, patch: { nodeName: "Stale edit" } })).status, 409);
  }
  const actor = app.collaboration.actorForUser(user.id, app.config.project.id);
  const candidate = app.researchCommands.createCandidate({ actor, reason: "Read paper", nodes: [{ kind: "paper", core: { nodeName: "Accepted paper" }, blocks: [{ type: "richText", title: "Reading result", payload: { format: "markdown", body: "Substantive result" } }] }] });
  app.researchCommands.reviewCandidate({ actor, patchId: candidate.id, expectedRevision: 1, decision: "accept" });
  const accepted = app.state.topology.nodes.find(node => node.label.zh === "Accepted paper");
  app.registry.syncSources = async () => ({ stateVersion: "new-source-fixture", observedAt: new Date().toISOString() });
  await app.sourceRefresh.refresh({ force: true });
  for (const id of [...ids, accepted.id]) {
    assert.ok(app.state.topology.nodes.some(node => node.id === id));
    assert.ok(app.researchNodes.detail(id).contentBlocks.length > 0);
  }
  assert.equal((await request("POST", "/api/topology/nodes", { kind: "paper", title: "Retired" })).status, 404);
  assert.equal((await request("PATCH", `/api/topology/nodes/${encodeURIComponent(ids[0])}`, { title: "Retired" })).status, 404);
  assert.equal((await request("POST", "/api/topology/curation/apply", { patchId: "retired" })).status, 404);
});

test("research records never import runtime events and preserve historical node references and revisions", async t => {
  const { app, request } = await fixture(t);
  app.state.recordEvent({ type: "agentMessage", actor: "agent", nodeIds: [], sourceRefs: [], payload: { text: "DO_NOT_IMPORT_AGENT_REPLY" } }, { skipValidation: true });
  assert.equal((await request("GET", "/api/research-records")).data.total, 0);
  const anchor = (await request("POST", "/api/research-nodes", { kind: "question", core: { nodeName: "Meeting anchor" } })).data.node, version = app.state.topology.stateVersion;
  const input = { type: "meeting", title: "October lab meeting", occurredAt: "2026-10-01T06:00:00Z", body: "Discussed replication limits", nodeIds: [anchor.id], participants: ["A", "B"], decisions: ["Run more seeds"], actions: [{ text: "Run 3 seeds", assignee: "A", dueDate: "2026-11-10", status: "open" }], status: "confirmed" };
  const created = await request("POST", "/api/research-records", input);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(app.state.topology.stateVersion, version);
  const record = created.data;
  const node = app.researchNodes.detail(anchor.id);
  app.researchNodes.updateCore(anchor.id, { nodeName: "Changed after meeting" }, app.collaboration.actorForUser(app.collaboration.userByUsername("notebook-admin").id, app.config.project.id), node.coreRevision);
  const revised = await request("PATCH", `/api/research-records/${record.id}`, { ...input, body: "Amended minutes", expectedRevision: 1 });
  assert.equal(revised.data.revision, 2);
  assert.deepEqual(revised.data.linkedNodes, record.linkedNodes);
  assert.equal((await request("GET", `/api/research-records/${record.id}/revisions/1`)).data.body, input.body);
  assert.equal((await request("PATCH", `/api/research-records/${record.id}`, { ...input, expectedRevision: 1 })).status, 409);
  assert.equal((await request("POST", "/api/research-records", { ...input, body: "" })).status, 422);
  const listed = (await request("GET", "/api/research-records?q=Amended")).data;
  assert.equal(listed.total, 1); assert.equal(listed.items[0].body, undefined);
  assert.doesNotMatch(JSON.stringify(listed), /DO_NOT_IMPORT_AGENT_REPLY/);
});
test("series schedule independent idempotent occurrences and records enforce read-only and Agent boundaries", async t => {
  const { app, request, user } = await fixture(t);
  const series = (await request("POST", "/api/research-series", { title: "Monthly meeting", frequency: "monthly", timezone: "Asia/Shanghai", startDate: "2026-01-31", localTime: "14:00" })).data;
  const next = await request("POST", `/api/research-series/${series.id}/occurrences`, {});
  const nextAgain = await request("POST", `/api/research-series/${series.id}/occurrences`, {});
  assert.equal(nextAgain.data.id, next.data.id);
  const first = await request("POST", `/api/research-series/${series.id}/occurrences`, { date: "2026-02-28" });
  const again = await request("POST", `/api/research-series/${series.id}/occurrences`, { date: "2026-02-28" });
  assert.equal(first.status, 201); assert.equal(first.data.scheduledAt, "2026-02-28T06:00:00.000Z");
  assert.equal(first.data.occurredAt, null); assert.equal(again.data.id, first.data.id);
  assert.equal((await request("POST", `/api/research-series/${series.id}/occurrences`, { date: "2026-03-31" })).status, 201);
  const actor = app.collaboration.actorForUser(user.id, app.config.project.id);
  const guest = app.collaboration.createUser({ username: "notebook-reader", displayName: "Guest", password: "Notebook-Guest-2026!" }, actor);
  const now = new Date().toISOString();
  app.collaboration.db.prepare("INSERT INTO memberships(project_id,user_id,role,status,created_at,updated_at) VALUES(?,?,'guest','active',?,?)").run(app.config.project.id, guest.id, now, now);
  const guestToken = app.collaboration.login("notebook-reader", "Notebook-Guest-2026!").token;
  assert.equal((await request("GET", "/api/research-records", undefined, app.config.project.id, guestToken)).status, 200);
  assert.equal((await request("POST", "/api/research-records", { type: "idea", title: "blocked" }, app.config.project.id, guestToken)).status, 403);
  const agent = app.collaboration.issueAgentCredential(actor, app.config.project.id, "notebook-agent");

  assert.equal((await request("GET", "/api/research-records", undefined, app.config.project.id, agent)).status, 403);
});
test("experiment node details use real gateway results, retain partial failures, and have no invented outputs", async t => {
  const { app, request } = await fixture(t);
  app.registry.experiments.detail = async ref => {
    if (ref.includes("missing")) throw new Error("Provider unavailable");
    return { run: { ref, provider: "wandb", metrics: { loss: 0.25 }, series: [{ key: "loss", points: [{ x: 1, y: .5 }, { x: 2, y: .25 }] }] }, source: { provider: "wandb", mode: "live" } };
  };
  const created = (await request("POST", "/api/research-nodes", { kind: "experiment", core: { nodeName: "My replication" }, sourceRefs: [{ kind: "range", value: "wandb:run:lab/project/valid" }, { kind: "range", value: "wandb:run:lab/project/missing" }] })).data;
  await request("POST", `/api/research-objects/node/${encodeURIComponent(created.node.id)}/content-blocks`, { type: "metric", title: "Metrics", payload: { items: [{ name: "PSNR", value: 30.2 }] } });
  const result = (await request("GET", `/api/research-nodes/${encodeURIComponent(created.node.id)}/results`)).data;
  assert.equal(result.details.length, 1); assert.equal(result.warnings.length, 1);
  assert.equal(result.authoredMetrics[0].value, 30.2); assert.equal(result.details[0].run.metrics.loss, .25);
  const empty = (await request("POST", "/api/research-nodes", { kind: "experiment", core: { nodeName: "No results yet" } })).data;
  const detail = (await request("GET", `/api/research-nodes/${encodeURIComponent(empty.node.id)}/results`)).data;
  assert.deepEqual(detail.details, []); assert.deepEqual(detail.authoredMetrics, []);
});
