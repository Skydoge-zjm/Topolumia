/** Requires a task-owned WSL venv with installed collector/native SDKs. Synthetic only. */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { startMvpServer } from "../../dist/src/server.js";

const remoteRoot = process.argv[2];
assert.match(remoteRoot ?? "", /^\/tmp\/topolumia-ingestion\.[A-Za-z0-9]+$/);
const root = path.resolve(
  "runtime/record-ingestion-wsl",
  new Date().toISOString().replaceAll(/[:.]/g, "-"),
);
await mkdir(root, { recursive: true });
function command(executable, args, input) {
  const child = spawn(executable, args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = (stdout + chunk).slice(-524288);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-524288);
  });
  child.stdin.end(input);
  return {
    child,
    done: new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    }),
  };
}
const ssh = (cmd, input) =>
  command(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "wsl", cmd],
    input,
  );
async function remote(cmd, input, expected = 0) {
  const result = await ssh(cmd, input).done;
  if (expected !== null)
    assert.equal(result.code, expected, result.stderr.slice(-2000));
  return result;
}
const options = {
  port: 0,
  testMode: false,
  collaborationFile: path.join(root, "data.sqlite"),
  userSettingsFile: path.join(root, "settings.json"),
  config: {
    project: { workspacesRoot: path.join(root, "workspaces") },
    sourceRefresh: { enabled: false },
    curator: { enabled: false },
    agentSessions: { profiles: [] },
  },
};
let app = await startMvpServer(options),
  tunnel,
  training;
const report = { root, remoteRoot, checks: {}, versions: {}, blocks: [] };
try {
  const password = randomUUID() + "-Synthetic!";
  const user = app.collaboration.bootstrapAdmin({
    username: "ingestion-verifier",
    password,
  });
  const actor = app.collaboration.actorForUser(user.id, app.config.project.id),
    c = app.researchCommands;
  for (const provider of ["wandb", "tensorboard"]) {
    const view = c.changes.direct(
      [
        {
          op: "addNode",
          clientRef: "node",
          kind: "experiment",
          core: { nodeName: "WSL " + provider },
        },
        {
          op: "addBlock",
          owner: { kind: "node", id: "@node" },
          clientRef: "record",
          title: provider + " records",
          type: "experimentRecord",
          payload: { provider, runs: [] },
        },
      ],
      actor,
    );
    const blockId = view.allocation["block:record"],
      nodeId = view.allocation["node:node"],
      grant = c.ingestion.grant(blockId, actor);
    report.blocks.push({ provider, blockId, nodeId, grantId: grant.id });
    await remote(`cat > ${remoteRoot}/${provider}-token`, grant.token);
    await remote(
      `${remoteRoot}/venv/bin/topolumia-collector connect --url http://127.0.0.1:18887 --project ${app.config.project.id} --token-file ${remoteRoot}/${provider}-token --connection ${remoteRoot}/${provider}-connection.json`,
    );
  }
  const port = new URL(app.url).port;
  const forward = () =>
    command("ssh", [
      "-N",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-R",
      `127.0.0.1:18887:127.0.0.1:${port}`,
      "wsl",
    ]);
  tunnel = forward();
  await new Promise((resolve) => setTimeout(resolve, 700));
  const probe = await remote(
    `${remoteRoot}/venv/bin/python -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:18887/api/health").status)'`,
  );
  assert.match(probe.stdout, /200/);
  report.checks.reverseHttp = true;
  const runRoot = remoteRoot + "/simulation-" + Date.now();
  training = ssh(
    `${remoteRoot}/venv/bin/python ${remoteRoot}/simulate.py --root ${runRoot} --steps 100 --interval .2`,
  );
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const collect = async (provider, expected = 0) =>
    remote(
      `${remoteRoot}/venv/bin/topolumia-collector watch --provider ${provider} --source ${runRoot}/${provider} --connection ${remoteRoot}/${provider}-connection.json --block ${report.blocks.find((block) => block.provider === provider).blockId} --spool ${runRoot}/${provider}-spool --interval .2 --once`,
      undefined,
      expected,
    );
  for (const provider of ["wandb", "tensorboard"]) await collect(provider);
  for (const target of report.blocks) {
    const runs = app.researchCommands.records.overview(
      target.nodeId,
      actor,
      undefined,
      target.blockId,
    ).runs;
    assert.ok(runs.length > 0, target.provider + " should have live runs");
    const plot = await app.researchCommands.records.plot(
      {
        selections: runs.map((run) => ({
          nodeId: target.nodeId,
          blockId: target.blockId,
          runId: run.id,
        })),
      },
      actor,
    );
    assert.ok(
      plot.series.some((line) => line.pointCount > 0),
      target.provider + " should grow before finish",
    );
    target.firstWatermark = app.researchCommands.ingestion.watermark(
      target.blockId,
    );
    target.snapshotId = app.researchCommands.ingestion.snapshot(
      target.blockId,
      actor,
    ).id;
    await writeFile(
      path.join(root, target.provider + "-live.json"),
      JSON.stringify(plot),
    );
  }
  report.checks.liveBeforeFinish = true;
  console.log("Observed live W&B and TensorBoard records before finish");
  const auth = await fetch(app.url + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "ingestion-verifier", password }),
  });
  assert.equal(auth.status, 200);
  // Reopen the real backend on the same port; collector read state is already durable.
  await app.close();
  for (const provider of ["wandb", "tensorboard"]) await collect(provider, 2);
  app = await startMvpServer({ ...options, port: Number(port) });
  for (const provider of ["wandb", "tensorboard"]) await collect(provider);
  report.checks.backendRestartAndOfflineSpool = true;
  console.log("Recovered queued data across backend restart");
  const result = await training.done;
  assert.equal(result.code, 0, result.stderr.slice(-3000));
  await writeFile(
    path.join(root, "training.log"),
    result.stdout + result.stderr,
  );
  for (const provider of ["wandb", "tensorboard"]) await collect(provider);
  const currentActor = app.collaboration.actorForUser(
    user.id,
    app.config.project.id,
  );
  for (const target of report.blocks) {
    const c = app.researchCommands,
      runs = c.records.overview(
        target.nodeId,
        currentActor,
        undefined,
        target.blockId,
      ).runs;
    assert.equal(runs.length, target.provider === "wandb" ? 2 : 1);
    const plot = await c.records.plot(
      { nodeIds: report.blocks.map((block) => block.nodeId) },
      currentActor,
    );
    assert.ok(c.ingestion.watermark(target.blockId) > target.firstWatermark);
    assert.equal(c.ingestion.pendingAttachments(target.blockId), 0);
    if (target.provider === "wandb") {
      assert.deepEqual(runs.map((run) => run.status).sort(), [
        "failed",
        "succeeded",
      ]);
      assert.ok(
        plot.series.some(
          (line) => line.key === "eval/score" && line.xKey === "epoch",
        ),
      );
      assert.ok(
        !plot.metricKeys.some(
          (key) => key.includes("width") || key.includes("height"),
        ),
      );
    } else {
      const loss = plot.series.find(
        (line) => line.nodeId === target.nodeId && line.key === "loss",
      );
      assert.equal(loss.pointCount, 103);
      const files = c.ingestion.events(target.blockId, currentActor, { kind: "file" }).items;
      assert.ok(files.some(item => item.event.key === "tensorboard/projector" && item.attachments.length >= 3));
    }
    const snapshot = c.ingestion.getSnapshot(target.snapshotId, currentActor);
    const raw = await c.records.read(
      {
        mode: "series",
        nodeId: target.nodeId,
        blockId: target.blockId,
        snapshotId: snapshot.id,
        runId: snapshot.runs[0].id,
        metric: "loss",
        maxChars: 16000,
      },
      currentActor,
    );
    target.snapshotPointCount = raw.data.pointCount;
    target.finalWatermark = c.ingestion.watermark(target.blockId);
    const before = target.finalWatermark;
    await collect(target.provider);
    assert.equal(c.ingestion.watermark(target.blockId), before);
    const status = JSON.parse(
      (
        await remote(
          `${remoteRoot}/venv/bin/topolumia-collector status --spool ${runRoot}/${target.provider}-spool`,
        )
      ).stdout,
    );
    assert.equal(status.pendingEvents, 0);
    assert.equal(status.pendingAttachments, 0);
    c.ingestion.changeGrant(
      target.blockId,
      target.grantId,
      "renew",
      currentActor,
    );
    c.ingestion.changeGrant(
      target.blockId,
      target.grantId,
      "revoke",
      currentActor,
    );
    await writeFile(
      path.join(root, target.provider + "-final.json"),
      JSON.stringify(plot),
    );
  }
  report.checks = {
    ...report.checks,
    finalStatuses: true,
    exactCustomAxis: true,
    noMediaMetadataCurves: true,
    tensorboardRestartDuplicates: true,
    tensorboardProjectorSidecars: true,
    immutableSnapshots: true,
    collectorRestartIdempotent: true,
    separateAttachments: true,
    temporaryComparison: true,
  };
  report.versions = JSON.parse(
    (
      await remote(
        `${remoteRoot}/venv/bin/python -c 'import json,sys,wandb,tensorboard,tensorboardX; print(json.dumps({"python":sys.version,"wandb":wandb.__version__,"tensorboard":tensorboard.__version__,"tensorboardX":tensorboardX.__version__}))'`,
      )
    ).stdout,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  tunnel?.child.kill();
  if (training?.child.exitCode === null) training.child.kill();
  await app.close();
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify(report, null, 2),
  );
}
