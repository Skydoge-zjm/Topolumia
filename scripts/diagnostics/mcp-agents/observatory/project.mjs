import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedObservatory, sites } from "./fixture.mjs";

const [destination, variant = "plaza"] = process.argv.slice(2);
if (!destination || !Object.hasOwn(sites, variant)) throw new Error("Usage: node project.mjs NEW_PROJECT_DIRECTORY [plaza|quay]");
const workspace = path.resolve(destination);
await mkdir(path.dirname(workspace), { recursive: true });
await mkdir(workspace);
const temp = await mkdtemp(path.join(os.tmpdir(), "topolumia-observatory-project-"));
const build = path.resolve(process.env.TOPOLUMIA_EVAL_BUILD || "dist");
const { startMvpServer } = await import(pathToFileURL(path.join(build, "src/server.js")).href);
let app;
try {
  app = await startMvpServer({ port: 0, host: "127.0.0.1", testMode: false, collaborationFile: path.join(temp, "account.sqlite"),
    sshRoot: path.join(temp, "ssh"), userSettingsFile: path.join(temp, "settings.json"),
    config: { project: { workspacesRoot: path.join(temp, "workspaces") }, sourceRefresh: { enabled: false }, curator: { enabled: false, automation: { enabled: false } } } });
  const user = app.collaboration.bootstrapAdmin({ username: "researcher", password: randomUUID() + "!Aa2" });
  const manager = app.collaboration.actorForUser(user.id, app.config.project.id);
  const project = app.collaboration.createProject({ name: "Alder 城市微气候观测项目", workspace: { kind: "local", directory: workspace } }, manager);
  const runtime = await app.getRuntime(project.id);
  const actor = app.collaboration.actorForUser(user.id, project.id);
  const result = await seedObservatory(runtime, actor, workspace, variant);
  assert.equal(result.inventory.blockTypes.length, 12);
  assert.equal(result.inventory.kinds.length, 3);
  assert.ok(result.atlas.run && result.reed.run && result.initialVersion);
  await writeFile(path.join(path.dirname(workspace), path.basename(workspace) + "-inventory.json"), JSON.stringify({ projectId: project.id, ...result.inventory }, null, 2));
  console.log(JSON.stringify({ project: workspace, ...result.inventory }, null, 2));
} finally {
  await app?.close();
  if (path.dirname(temp) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith("topolumia-observatory-project-"))
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
