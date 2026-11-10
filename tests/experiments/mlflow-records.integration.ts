import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { access, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { loadConfig, mvpRoot } from "../../src/config.js";
import { MlflowRecordImporter } from "../../src/services/research/experiments/mlflow-importer.js";
import { ResearchCommandService } from "../../src/services/research/research-command-service.js";
import { ResearchState } from "../../src/services/research/research-state.js";
import { TopologyService } from "../../src/services/topology/topology-service.js";

const execute = promisify(execFile);
const python = process.env.EXPERIMENT_TEST_PYTHON || path.join(mvpRoot, process.platform === "win32" ? ".venv-test/Scripts/python.exe" : ".venv-test/bin/python");

async function availablePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (process.platform === "win32") await execute("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }).catch(() => {});
  else child.kill("SIGTERM");
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
}

test("native MLflow SDK and REST records import into persistent research records", { timeout: 90000 }, async t => {
  await access(python).catch(() => { throw new Error(`Missing isolated MLflow environment: ${python}. Run npm run setup:experiment-test-env.`); });
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-native-mlflow-"));
  let native:ChildProcess|undefined,db:DatabaseSync|undefined,commands:ResearchCommandService|undefined;
  t.after(async () => {
    if(commands){await commands.records.close();await commands.assets.close();}
    db?.close();
    if(native)await stopProcess(native);
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const generated = await execute(python, ["-c", `
import json, pathlib, sys
from mlflow.tracking import MlflowClient
from mlflow.entities import Metric
from mlflow.utils.proto_json_utils import message_to_json
root = pathlib.Path(sys.argv[1]).resolve()
tracking = "sqlite:///" + (root / "native.sqlite").as_posix()
artifacts = (root / "artifacts").as_uri()
client = MlflowClient(tracking_uri=tracking)
experiment = client.create_experiment("Persistent import", artifact_location=artifacts)
run = client.create_run(experiment, tags={"mlflow.runName":"SDK training", "custom/tag":"preserved"})
client.log_param(run.info.run_id, "seed", "42")
artifact_file = root / "native.txt"
artifact_file.write_bytes(b"preserved\\n")
client.log_artifact(run.info.run_id, str(artifact_file), artifact_path="checkpoints")
for step, value, timestamp in [(0, 1.0, 1000), (10, 0.5, 2000), (20, 0.25, 3000)]:
    client.log_metric(run.info.run_id, "loss", value, timestamp=timestamp, step=step)
client.log_metric(run.info.run_id, "nonfinite_loss", 1.0, timestamp=1000, step=0)
client.log_metric(run.info.run_id, "nonfinite_loss", float("nan"), timestamp=2000, step=1)
client.set_terminated(run.info.run_id)
wire_values = [json.loads(message_to_json(Metric("loss", value, 1234, 0).to_proto()))["value"] for value in [float("nan"), float("inf"), float("-inf")]]
print(json.dumps({"trackingUri":tracking,"artifactRoot":artifacts,"runId":run.info.run_id,"nonfiniteWireValues":wire_values}))
`, root], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
  const fixture = JSON.parse(generated.stdout.trim().split(/\r?\n/).at(-1)!);
  assert.deepEqual(fixture.nonfiniteWireValues, ["NaN", "Infinity", "-Infinity"]);
  const port = await availablePort(), baseUrl = `http://127.0.0.1:${port}`;
  native = spawn(python, ["-m", "mlflow", "server", "--backend-store-uri", fixture.trackingUri, "--default-artifact-root", fixture.artifactRoot, "--host", "127.0.0.1", "--port", String(port), "--workers", "1"], { cwd: mvpRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "";
  native.stdout.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-16000); });
  native.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-16000); });
  const deadline = Date.now() + 45000;
  for (;;) {
    if (native.exitCode !== null) throw new Error(`Native MLflow exited: ${diagnostics}`);
    try { if ((await fetch(baseUrl + "/api/2.0/mlflow/experiments/search?max_results=1",{signal:AbortSignal.timeout(1000)})).ok) break; } catch { /* Wait for the real REST server. */ }
    if (Date.now() > deadline) throw new Error(`Native MLflow readiness timeout: ${diagnostics}`);
    await delay(250);
  }
  const config = await loadConfig({ mlflow: { baseUrl, experimentName: "Persistent import", experimentId: "", pageSize: 1, maxRuns: 10, timeoutMs: 10000 } });
  const open = async () => {
    db = new DatabaseSync(path.join(root, "research.sqlite"));
    const topologyService = new TopologyService({ demo: false });
    commands = new ResearchCommandService({ db, projectId: "native-mlflow", topologyService, state: new ResearchState(topologyService.build()), assetRoot: path.join(root, "assets") });
    await commands.assets.initialize();
  };
  const close = async () => { await commands!.records.close(); await commands!.assets.close(); db!.close();db=undefined; };
  await open();
  const actor = { isAgent: false, projectId: "native-mlflow", user: { id: "native-manager" }, permissions: ["*"] };
  const importer = new MlflowRecordImporter(commands, config);
  assert.equal((await importer.catalog(actor)).runs.find(run => run.runId === fixture.runId)?.label, "SDK training");
  const imported = await importer.import({ runIds: [fixture.runId] }, actor);
  assert.equal(imported.imported.length, 1);
  assert.deepEqual(await importer.import({ runIds: [fixture.runId] }, actor), imported);
  await stopProcess(native);
  await close();
  await open();
  const available = commands.projectRecords.directory(actor);
  assert.equal(available.total, 1);
  const selected = commands.projectRecords.assign({ runs: [available.items[0].projectSource], nodeName: "Imported SDK run" }, actor);
  const points = await commands.records.read({ mode: "series", ...selected, runId: available.items[0].projectSource.runId, metric: "loss", maxChars: 16000 }, actor);
  assert.deepEqual(points.data.points, [{ x: 0, y: 1, timestamp: 1000 }, { x: 10, y: .5, timestamp: 2000 }, { x: 20, y: .25, timestamp: 3000 }]);
  const nonfinite = await commands.records.read({ mode: "series", ...selected, runId: available.items[0].projectSource.runId, metric: "nonfinite_loss", maxChars: 16000 }, actor);
  assert.deepEqual(nonfinite.data.points, [{ x: 0, y: 1, timestamp: 1000 }, { x: 1, y: { dtype: "float64", value: "NaN" }, timestamp: 2000 }]);
  const facts = await commands.records.read({ mode: "events", ...selected, eventKind: "config", maxChars: 16000 }, actor);
  assert.deepEqual(facts.data.items[0].event.data?.parameters, [{ key: "seed", value: "42" }]);
  const files=await commands.records.read({mode:"events",...selected,eventKind:"file",limit:100,maxChars:16000},actor);
  assert.deepEqual(files.data.items.map(item=>item.event.data?.native?.path).sort(),["checkpoints","checkpoints/native.txt"]);
  assert.ok(files.data.items.every(item=>item.event.data?.external===true));
  const original=files.data.items.find(item=>item.event.data?.native?.path==="checkpoints/native.txt")!.event.data!.native;
  assert.equal(original.is_dir,false);
  assert.equal(Number(original.file_size),10);
});
