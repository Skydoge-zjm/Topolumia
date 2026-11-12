import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { MlflowReader } from "../../src/services/research/experiments/mlflow-reader.js";
import { MlflowRecordImporter } from "../../src/services/research/experiments/mlflow-importer.js";
import { ResearchCommandService } from "../../src/services/research/research-command-service.js";
import { ResearchState } from "../../src/services/research/research-state.js";
import { TopologyService } from "../../src/services/topology/topology-service.js";
import { startMvpServer } from "../../src/server.js";
import type { ResearchActor } from "../../src/domain/research/types.js";

const nativePoints = [
  { key: "loss", step: 0, value: 1, timestamp: 1000 },
  { key: "loss", step: 2, value: .4, timestamp: 2000 },
  { key: "loss", step: 2, value: .35, timestamp: 3000 },
  { key: "loss", step: 1, value: .25, timestamp: 4000 },
];
const expectedPoints = [
  { x: 0, y: 1, timestamp: 1000 },
  { x: 2, y: .4, timestamp: 2000 },
  { x: 2, y: .35, timestamp: 3000 },
  { x: 1, y: .25, timestamp: 4000 },
];
const nativeArtifacts = [
  { path: "metrics.json", is_dir: false, file_size: "34", storage_class: "STANDARD" },
  { path: "checkpoints", is_dir: true },
  { path: "checkpoints/model.bin", is_dir: false, file_size: "9007199254740993" },
  { path: "checkpoints/deep", is_dir: true },
  { path: "checkpoints/deep/config.json", is_dir: false, file_size: 17 },
];
type WirePoint = { key: string; step: number; value: number | "NaN" | "Infinity" | "-Infinity"; timestamp: number };

/** Only the remote MLflow REST peer is simulated; the importer and SQLite are real. */
async function mlflowPeer(t: TestContext) {
  const state = { points: structuredClone(nativePoints) as WirePoint[], failHistory: false, failRun: "", failArtifactRun: "", repeatCursor: false, authorization: "" };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://mlflow.test");
    state.authorization = String(request.headers.authorization ?? "");
    response.setHeader("content-type", "application/json");
    const send = (value: unknown) => response.end(JSON.stringify(value));
    if (url.pathname.endsWith("/experiments/search")) {
      if (url.searchParams.get("page_token") === "experiments-2") return send({ experiments: [{ experiment_id: "10", name: "Other study" }] });
      return send({ experiments: [{ experiment_id: "9", name: "Study" }], next_page_token: "experiments-2" });
    }
    if (url.pathname.endsWith("/runs/search")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.experiment_ids?.[0] !== "9") return send({ runs: [] });
      const second = body.page_token === "runs-2";
      return send({ runs: [{ info: { run_id: second ? "other-run" : "native-run", experiment_id: "9", run_name: second ? "Other" : "Training", status: "FINISHED" }, data: { metrics: second ? [nativePoints[0]] : [state.points.at(-1)], params: [], tags: [] } }], ...(!second || state.repeatCursor ? { next_page_token: "runs-2" } : {}) });
    }
    if (url.pathname.endsWith("/runs/get")) return send({ run: {
      info: { run_id: url.searchParams.get("run_id"), experiment_id: url.searchParams.get("run_id") === "foreign-run" ? "10" : "9", run_name: "Training", status: "FINISHED", artifact_uri: "s3://research/native-run", start_time: 1000, end_time: 5000 },
      data: { metrics: [state.points.at(-1)], params: [{ key: "seed", value: "42" }], tags: [{ key: "custom/tag", value: "keep this" }] },
      native_extension: { owner: "research-team" },
    } });
    if (url.pathname.endsWith("/metrics/get-history")) {
      const second = url.searchParams.get("page_token") === "metrics-2";
      if (second && (state.failHistory || url.searchParams.get("run_id") === state.failRun)) { response.statusCode = 503; return send({ error_code: "TEMPORARILY_UNAVAILABLE" }); }
      return send(second ? { metrics: state.points.slice(2) } : { metrics: state.points.slice(0, 2), next_page_token: "metrics-2" });
    }
    if (url.pathname.endsWith("/artifacts/list")) {
      const directory=url.searchParams.get("path")??"",cursor=url.searchParams.get("page_token");
      if(directory===""){
        if(!cursor)return send({files:[nativeArtifacts[0]],next_page_token:"artifacts-root-2"});
        if(cursor==="artifacts-root-2"){
          if(url.searchParams.get("run_id")===state.failArtifactRun){response.statusCode=503;return send({error_code:"TEMPORARILY_UNAVAILABLE"});}
          return send({files:[nativeArtifacts[1]]});
        }
      }
      if(directory==="checkpoints"){
        if(!cursor)return send({files:[nativeArtifacts[2]],next_page_token:"artifacts-checkpoints-2"});
        if(cursor==="artifacts-checkpoints-2")return send({files:[nativeArtifacts[3]]});
      }
      if(directory==="checkpoints/deep"&&!cursor)return send({files:[nativeArtifacts[4]]});
    }
    response.statusCode = 404;
    send({ error_code: "RESOURCE_DOES_NOT_EXIST" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const stop = async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  t.after(stop);
  const config = await loadConfig({ mlflow: { baseUrl: `http://127.0.0.1:${address.port}`, experimentName: "Study", experimentId: "", pageSize: 1, maxRuns: 10, tokenEnv: "TOPOLUMIA_TEST_MLFLOW_TOKEN" } });
  return { config, state, stop };
}

async function persistentRecords(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-mlflow-records-"));
  const actor: ResearchActor = { isAgent: false, user: { id: "manager", displayName: "Manager" }, projectId: "mlflow", permissions: ["*"] };
  let db: DatabaseSync, commands: ResearchCommandService;
  const open = async () => {
    db = new DatabaseSync(path.join(root, "records.sqlite"));
    const topologyService = new TopologyService({ demo: false });
    commands = new ResearchCommandService({ db, projectId: "mlflow", projectName: "MLflow", topologyService, state: new ResearchState(topologyService.build()), assetRoot: path.join(root, "assets") });
    await commands.assets.initialize();
  };
  const close = async () => { await commands.records.close(); await commands.assets.close(); db.close(); };
  await open();
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return { actor, get commands() { return commands; }, get db() { return db; }, async restart() { await close(); await open(); return commands; } };
}

test("MLflow reader follows experiment, run, metric and recursive artifact pages without losing native metadata", async t => {
  const { config, state } = await mlflowPeer(t), reader = new MlflowReader(config);
  const previous = process.env.TOPOLUMIA_TEST_MLFLOW_TOKEN;
  process.env.TOPOLUMIA_TEST_MLFLOW_TOKEN = "fixture-token";
  t.after(() => { if (previous === undefined) delete process.env.TOPOLUMIA_TEST_MLFLOW_TOKEN; else process.env.TOPOLUMIA_TEST_MLFLOW_TOKEN = previous; });
  assert.deepEqual((await reader.listExperiments()).map(experiment => experiment.experiment_id), ["9", "10"]);
  assert.deepEqual((await reader.listRuns("9")).map(run => run.info.run_id), ["native-run", "other-run"]);
  const record = await reader.readRun("native-run");
  assert.deepEqual(record.history.loss, nativePoints);
  assert.equal(record.run.info.artifact_uri, "s3://research/native-run");
  assert.deepEqual(record.run.data.params, [{ key: "seed", value: "42" }]);
  assert.deepEqual(record.run.native_extension, { owner: "research-team" });
  assert.deepEqual(record.artifacts,nativeArtifacts);
  assert.equal(state.authorization, "Bearer fixture-token");
});

test("MLflow reader rejects cursor loops and run limits instead of reporting a complete directory", async t => {
  const { config, state } = await mlflowPeer(t), reader = new MlflowReader(config);
  state.repeatCursor = true;
  await assert.rejects(reader.listRuns("9"), { code: "MLFLOW_PAGINATION_INVALID" });
  state.repeatCursor = false;
  config.mlflow.maxRuns = 1;
  await assert.rejects(reader.listRuns("9"), { code: "MLFLOW_RUN_LIMIT" });
});

test("MLflow protobuf nonfinite metrics keep the catalog readable and retain exact values after restart", async t => {
  const peer = await mlflowPeer(t), saved = await persistentRecords(t);
  peer.state.points = [
    nativePoints[0],
    { key: "loss", step: 1, value: "NaN", timestamp: 2000 },
    { key: "loss", step: 2, value: "Infinity", timestamp: 3000 },
    { key: "loss", step: 3, value: "-Infinity", timestamp: 4000 },
  ];
  const importer = new MlflowRecordImporter(saved.commands, peer.config);
  assert.deepEqual((await importer.catalog(saved.actor)).runs.map(run => run.runId), ["native-run", "other-run"]);
  const native = await importer.reader.readRun("native-run");
  assert.deepEqual(native.history.loss.map(point => point.value), [1, { dtype: "float64", value: "NaN" }, { dtype: "float64", value: "Infinity" }, { dtype: "float64", value: "-Infinity" }]);
  await importer.import({ runIds: ["native-run"] }, saved.actor);
  await peer.stop();
  const c = await saved.restart();
  const run = c.projectRecords.directory(saved.actor).items[0];
  const selected = c.projectRecords.assign({ runs: [run.projectSource], nodeName: "Nonfinite observations" }, saved.actor);
  const input = { ...selected, runId: run.projectSource.runId, maxChars: 16000 };
  const values = await c.records.read({ ...input, mode: "series", metric: "loss", xKey: "step" }, saved.actor);
  assert.equal(values.data.pointCount, 4);
  assert.deepEqual(values.data.points, [
    { x: 0, y: 1, timestamp: 1000 },
    { x: 1, y: { dtype: "float64", value: "NaN" }, timestamp: 2000 },
    { x: 2, y: { dtype: "float64", value: "Infinity" }, timestamp: 3000 },
    { x: 3, y: { dtype: "float64", value: "-Infinity" }, timestamp: 4000 },
  ]);
  const summary = await c.records.read({ ...input, mode: "events", eventKind: "summary" }, saved.actor);
  assert.deepEqual(summary.data.items[0].event.data.metrics, [{ key: "loss", step: 3, value: { dtype: "float64", value: "-Infinity" }, timestamp: 4000 }]);
  const plot = await c.records.plot({ nodeId: selected.nodeId, blockId: selected.blockId }, saved.actor);
  assert.deepEqual(plot.series[0].points, [{ x: 0, y: 1, timestamp: 1000 }]);
});

test("MLflow imports survive restart, remain idempotent and create distinct immutable upstream versions", async t => {
  const peer = await mlflowPeer(t), saved = await persistentRecords(t);
  let c = saved.commands, importer = new MlflowRecordImporter(c, peer.config);
  const first = await importer.import({ runIds: ["native-run", "native-run"] }, saved.actor);
  assert.equal(first.imported.length, 1);
  assert.throws(() => c.ingestion.grant(first.imported[0].sourceId, saved.actor), { code: "RECORD_SOURCE_IMMUTABLE" });
  assert.deepEqual(await importer.import({ runIds: ["native-run"] }, saved.actor), first);
  assert.equal(c.projectRecords.directory(saved.actor).total, 1);
  c = await saved.restart();
  importer = new MlflowRecordImporter(c, peer.config);
  const directory = c.projectRecords.directory(saved.actor);
  assert.equal(directory.total, 1);
  assert.equal(directory.items[0].provider, "mlflow");
  assert.equal(directory.items[0].label, "Training");
  assert.equal(directory.items[0].status, "succeeded");
  const firstBinding = directory.items[0].projectSource;
  const selected = c.projectRecords.assign({ runs: [firstBinding], nodeName: "Persisted import" }, saved.actor);
  const read = () => c.records.read({ mode: "series", ...selected, runId: firstBinding.runId, metric: "loss", xKey: "step", maxChars: 16000 }, saved.actor);
  assert.deepEqual((await read()).data.points, expectedPoints);
  const snapshot = c.ingestion.snapshot(selected.blockId, saved.actor);
  const config = await c.records.read({ mode: "events", ...selected, eventKind: "config", maxChars: 16000 }, saved.actor);
  assert.deepEqual(config.data.items[0].event.data, { parameters: [{ key: "seed", value: "42" }], tags: [{ key: "custom/tag", value: "keep this" }] });
  const artifacts=await c.records.read({mode:"events",...selected,eventKind:"file",limit:100,maxChars:16000},saved.actor);
  assert.deepEqual(artifacts.data.items.map(item=>item.event.data),nativeArtifacts.map(native=>({native,external:true})));
  peer.state.points.push({ key: "loss", step: 3, value: .1, timestamp: 5000 });
  const updated = await importer.import({ runIds: ["native-run"] }, saved.actor);
  assert.notEqual(updated.imported[0].sourceId, first.imported[0].sourceId);
  assert.notEqual(updated.imported[0].contentVersion, first.imported[0].contentVersion);
  assert.equal(c.projectRecords.directory(saved.actor).total, 2);
  assert.deepEqual((await read()).data.points, expectedPoints);
  const newest = c.projectRecords.directory(saved.actor).items.find(item => item.projectSource.sourceId === updated.imported[0].sourceId)!;
  const newSelection = c.projectRecords.assign({ runs: [newest.projectSource], nodeName: "New import" }, saved.actor);
  const newPoints = await c.records.read({ mode: "series", ...newSelection, runId: newest.projectSource.runId, metric: "loss", xKey: "step", maxChars: 16000 }, saved.actor);
  assert.deepEqual(newPoints.data.points, [...expectedPoints, { x: 3, y: .1, timestamp: 5000 }]);
  await peer.stop();
  assert.deepEqual((await c.records.read({ mode: "series", snapshotId: snapshot.id, runId: firstBinding.runId, metric: "loss", xKey: "step", maxChars: 16000 }, saved.actor)).data.points, expectedPoints);
  const savedManifest=await c.records.read({mode:"events",...selected,snapshotId:snapshot.id,eventKind:"file",limit:100,maxChars:16000},saved.actor);
  assert.deepEqual(savedManifest.data.items.map(item=>item.event.data),nativeArtifacts.map(native=>({native,external:true})));
});

test("MLflow permissions prevent Agent, collector, reader and foreign-project imports", async t => {
  const peer = await mlflowPeer(t), saved = await persistentRecords(t), importer = new MlflowRecordImporter(saved.commands, peer.config);
  const reader = { ...saved.actor, permissions: ["research.view"] };
  await assert.rejects(importer.catalog(reader), { code: "FORBIDDEN" });
  await assert.rejects(importer.import({ runIds: ["native-run"] }, reader), { code: "FORBIDDEN" });
  await assert.rejects(importer.import({ runIds: ["native-run"] }, { ...saved.actor, isAgent: true }), { code: "FORBIDDEN" });
  await assert.rejects(importer.catalog({ ...saved.actor, isAgent: true }), { code: "FORBIDDEN" });
  await assert.rejects(importer.import({ runIds: ["native-run"] }, { ...saved.actor, collectorGrant: { id: "collector", blockId: "source", projectId: "mlflow", userId: "manager", expiresAt: "2099-01-01T00:00:00Z", revoked: false } }), { code: "FORBIDDEN" });
  await assert.rejects(importer.import({ runIds: ["native-run"] }, { ...saved.actor, projectId: "other" }), { code: "PROJECT_SCOPE_MISMATCH" });
  assert.equal(saved.commands.projectRecords.directory(saved.actor).total, 0);
});

test("MLflow later-page failures leave no partial source or points", async t => {
  const peer = await mlflowPeer(t), saved = await persistentRecords(t), importer = new MlflowRecordImporter(saved.commands, peer.config);
  peer.state.failRun = "broken-run";
  await assert.rejects(importer.import({ runIds: ["native-run", "broken-run"] }, saved.actor), { code: "MLFLOW_HTTP_ERROR" });
  assert.deepEqual(saved.commands.projectRecords.all(), []);
  assert.equal(saved.commands.projectRecords.directory(saved.actor).total, 0);
  const c = await saved.restart();
  assert.deepEqual(c.projectRecords.all(), []);
  peer.state.failRun = "";
  const imported = await new MlflowRecordImporter(c, peer.config).import({ runIds: ["native-run"] }, saved.actor);
  const selected = c.projectRecords.assign({ runs: [{ sourceId: imported.imported[0].sourceId, runId: imported.imported[0].runId }] }, saved.actor);
  const points = await c.records.read({ mode: "series", ...selected, runId: imported.imported[0].runId, metric: "loss", maxChars: 16000 }, saved.actor);
  assert.deepEqual(points.data.points, expectedPoints);
});

test("MLflow later artifact-page failures roll back the entire selected import",async t=>{
  const peer=await mlflowPeer(t),saved=await persistentRecords(t),importer=new MlflowRecordImporter(saved.commands,peer.config);
  peer.state.failArtifactRun="broken-artifact-run";
  await assert.rejects(importer.import({runIds:["native-run","broken-artifact-run"]},saved.actor),{code:"MLFLOW_HTTP_ERROR"});
  assert.deepEqual(saved.commands.projectRecords.all(),[]);
  assert.equal(saved.commands.projectRecords.directory(saved.actor).total,0);
  const c=await saved.restart();
  assert.deepEqual(c.projectRecords.all(),[]);
  peer.state.failArtifactRun="";
  const imported=await new MlflowRecordImporter(c,peer.config).import({runIds:["native-run","broken-artifact-run"]},saved.actor);
  assert.equal(imported.imported.length,2);
  assert.equal(c.projectRecords.directory(saved.actor).total,2);
});

test("MLflow a real SQLite write failure rolls back earlier event batches and the source", async t => {
  const peer = await mlflowPeer(t), saved = await persistentRecords(t), importer = new MlflowRecordImporter(saved.commands, peer.config);
  peer.state.points = Array.from({ length: 260 }, (_, step) => ({ key: "loss", step, value: 1 / (step + 1), timestamp: 1000 + step }));
  // Fail in the second batch after the first batch has actually reached SQLite.
  saved.db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON record_events WHEN NEW.watermark=130 BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END");
  await assert.rejects(importer.import({ runIds: ["native-run"] }, saved.actor), /fixture storage failure/);
  assert.deepEqual(saved.commands.projectRecords.all(), []);
  assert.equal(saved.commands.projectRecords.directory(saved.actor).total, 0);
  const c = await saved.restart();
  assert.deepEqual(c.projectRecords.all(), []);
  saved.db.exec("DROP TRIGGER reject_import");
  const imported = await new MlflowRecordImporter(c, peer.config).import({ runIds: ["native-run"] }, saved.actor);
  const binding = { sourceId: imported.imported[0].sourceId, runId: imported.imported[0].runId }, selected = c.projectRecords.assign({ runs: [binding] }, saved.actor);
  const tail = await c.records.read({ mode: "series", ...selected, runId: binding.runId, metric: "loss", pointOffset: 259, pointLimit: 1, maxChars: 16000 }, saved.actor);
  assert.equal(tail.data.pointCount, 260);
  assert.deepEqual(tail.data.points, [{ x: 259, y: 1 / 260, timestamp: 1259 }]);
});


test("MLflow rejects runs outside the selected experiment before publishing any selection", async t => {
  const peer = await mlflowPeer(t), saved = await persistentRecords(t), importer = new MlflowRecordImporter(saved.commands, peer.config);
  await assert.rejects(importer.import({runIds:["native-run","foreign-run"]},saved.actor),{code:"MLFLOW_RUN_SCOPE_MISMATCH"});
  assert.deepEqual(saved.commands.projectRecords.all(),[]);
  assert.equal(saved.commands.projectRecords.directory(saved.actor).total,0);
});

test("MLflow HTTP import enforces project access and exposes imported records through the unified directory", async t => {
  const peer = await mlflowPeer(t), root = await mkdtemp(path.join(os.tmpdir(), "topolumia-mlflow-api-"));
  const app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "app.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: { project: { workspacesRoot: path.join(root, "workspaces") }, mlflow: peer.config.mlflow, sourceRefresh: { enabled: false }, curator: { enabled: false }, agentSessions: { profiles: [] } } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const user = app.collaboration.bootstrapAdmin({ username: "mlflow-admin", password: "Mlflow-Api-2026!" });
  const token = app.collaboration.login("mlflow-admin", "Mlflow-Api-2026!").token;
  const actor = app.collaboration.actorForUser(user.id, app.config.project.id);
  const request = async (route: string, body?: unknown, session = token, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(app.url + route, { method, headers: { "content-type": "application/json", "x-rw-project-id": app.config.project.id, ...(session ? { "x-rw-session": session } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await request("/api/research/experiments/mlflow/catalog", undefined, "")).status, 401);
  const reader = app.collaboration.createUser({ username: "mlflow-reader", displayName: "Reader", password: "Mlflow-Reader-2026!" }, actor);
  const now = new Date().toISOString();
  app.collaboration.db.prepare("INSERT INTO memberships(project_id,user_id,role,status,created_at,updated_at) VALUES(?,?,'guest','active',?,?)").run(app.config.project.id, reader.id, now, now);
  const readerToken = app.collaboration.login("mlflow-reader", "Mlflow-Reader-2026!").token;
  assert.equal((await request("/api/research/experiments/mlflow/catalog", undefined, readerToken)).status, 403);
  assert.equal((await request("/api/research/experiments/mlflow/import", { runIds: ["native-run"] }, readerToken)).status, 403);
  assert.equal((await request("/api/research/experiments/mlflow/import", { runIds: [] })).status, 422);
  const configured = await request("/api/tools-environment/tools/mlflow", { baseUrl: peer.config.mlflow.baseUrl, experimentName: "Study", experimentId: "", tokenEnv: peer.config.mlflow.tokenEnv }, token, "PATCH");
  assert.equal(configured.status, 200, JSON.stringify(configured.data));
  const catalog = await request("/api/research/experiments/mlflow/catalog");
  assert.equal(catalog.status, 200, JSON.stringify(catalog.data));
  assert.deepEqual(catalog.data.runs.map((run: { runId: string }) => run.runId), ["native-run", "other-run"]);
  const imported = await request("/api/research/experiments/mlflow/import", { runIds: ["native-run"] });
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  const available = await request("/api/research/experiments/read", { mode: "available", provider: "mlflow", maxChars: 16000 });
  assert.equal(available.status, 200, JSON.stringify(available.data));
  assert.equal(available.data.data.items.length, 1);
  assert.equal(available.data.data.items[0].projectSource.sourceId, imported.data.imported[0].sourceId);
  const other = app.collaboration.createProject({ id: "other-mlflow-project", name: "Other project" }, actor);
  const otherRuntime = await app.getRuntime(other.id);
  assert.equal(otherRuntime.researchCommands.projectRecords.directory({ ...actor, projectId: other.id }).total, 0);
});
