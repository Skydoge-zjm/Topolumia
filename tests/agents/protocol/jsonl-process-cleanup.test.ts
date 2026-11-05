import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonlProcess } from "../../../src/adapters/agents/shared/jsonl-process.js";

test("shared JSONL process close waits for its Windows child tree to exit", { skip: process.platform !== "win32", timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-process-tree-"));
  let childPid;
  let ready;
  const initialized = new Promise(resolve => { ready = resolve; });
  const code = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(JSON.stringify({method:'fixture/ready',params:{pid:child.pid}})); setInterval(()=>{},1000);";
  const processRef = new JsonlProcess({ command: process.execPath, args: ["-e", code], cwd: root,
    onMessage: message => { childPid = message.params.pid; ready(); } });
  try {
    await processRef.start(); await initialized;
    await processRef.kill();
    for (let i = 0; i < 20; i++) {
      try { process.kill(childPid, 0); } catch { childPid = null; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(childPid, null, "A child process survived its runtime host shutdown");
    assert.equal(processRef.closed, true);
  } finally {
    await processRef.kill();
    if (childPid) { try { process.kill(childPid); } catch { /* Already exited. */ } }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
