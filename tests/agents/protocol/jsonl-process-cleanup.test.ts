import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonlProcess } from "../../../src/adapters/agents/shared/jsonl-process.js";
import { spawn } from "node:child_process";

test("a child exiting during a buffered write cannot crash the transport host", { timeout: 10000 }, async () => {
  const moduleUrl = new URL("../../../src/adapters/agents/shared/jsonl-process.js", import.meta.url).href;
  const code = [
    `import { JsonlProcess } from ${JSON.stringify(moduleUrl)};`,
    `const p = new JsonlProcess({command:process.execPath,args:["-e","setTimeout(()=>process.exit(0),20)"]});`,
    `await p.start(); try { await p.request("probe",{text:"x".repeat(1024*1024)},2000); } catch(e) { console.log(e.code); } finally { await p.kill(); }`,
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /AGENT_PROCESS_CLOSED/);
  assert.doesNotMatch(stderr, /Unhandled 'error'/);
});

test("buffered JSONL requests preserve FIFO order under pipe backpressure", { timeout: 10000 }, async () => {
  const code = 'require("node:readline").createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line); console.log(JSON.stringify({id:m.id,result:m.params.index}));});';
  const transport = new JsonlProcess({ command: process.execPath, args: ["-e", code] });
  try {
    await transport.start();
    const values = await Promise.all(Array.from({ length: 20 }, (_, index) => transport.request("echo", { index, text: "x".repeat(32768) }, 5000)));
    assert.deepEqual(values, Array.from({ length: 20 }, (_, index) => index));
  } finally { await transport.kill(); }
});

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
