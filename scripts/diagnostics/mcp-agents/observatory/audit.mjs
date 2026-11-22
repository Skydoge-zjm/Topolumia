import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gradeObservatory } from "./score.mjs";
import { inspectProject } from "./inspect-project.mjs";
import { observatoryPrompts } from "./tasks.mjs";
import { sites } from "./fixture.mjs";
import { model, providerTokens } from "../gateway.mjs";

const csv = value => '"' + String(value ?? "").replaceAll('"','""') + '"';
export async function auditStudy(root, expectedRounds = 12) {
  const batches = (await readdir(root,{withFileTypes:true})).filter(d => d.isDirectory() && /^(round-\d+|control-|holdout-|retest-|confirm-)/.test(d.name)).map(d=>d.name).sort();
  const records = [], turns = [], studies = [], usedTools = new Set(), blockViews = new Map(), identities = new Set();
  const read = async (dir, name) => JSON.parse(await readFile(path.join(root,dir,name),"utf8"));
  let lastEnd = 0;
  for (const batch of batches) {
    const manifest = await read(batch,"manifest.json");
    assert.equal(manifest.model,model);
    const start = Date.parse(manifest.started);
    let end = start;
    const files = (await readdir(path.join(root,batch))).filter(f=>/^(codex|claude|opencode2)-(panel|packet|appendix)\.json$/.test(f));
    for (const file of files) {
      const r = await read(batch,file), o = r.oracle;
      assert.equal(r.model,model);
      assert.ok(r.requests.length && r.requests.every(req=>req.requested===model));
      assert.ok(r.requests.some(req=>req.returned===model), batch + "/" + file + ": no acknowledged inference");
      assert.ok(r.nativeSession && !identities.has(r.nativeSession), "Fresh native session expected");
      identities.add(r.nativeSession);
      assert.equal(o.variant,manifest.variant);
      assert.equal(o.inventory.nodes,16);
      assert.equal(o.inventory.groups,5);
      assert.equal(o.inventory.relations,12);
      assert.equal(o.inventory.blockTypes.length,12);
      assert.deepEqual(manifest.prompts[r.case],observatoryPrompts(sites[o.variant])[r.case]);
      const trace = (await readFile(path.join(root,batch,file.replace(/\.json$/,".calls.jsonl")),"utf8")).trim().split("\n").filter(Boolean).map(s=>JSON.parse(s));
      const checks = gradeObservatory(r,trace);
      const passed = Object.values(checks).filter(Boolean).length, possible = Object.keys(checks).length;
      assert.equal(possible, { panel:25, packet:17, appendix:18 }[r.case]);
      assert.ok(r.formalIntact && r.stages.every(s=>s.formalBefore===s.formalAfter));
      assert.equal(trace.length,r.calls);
      const typedBlocks = new Map();
      for (const call of trace.filter(c=>!c.failed)) {
        usedTools.add(call.tool);
        const data = call.result?.data ?? {};
        for (const owner of [...(data.nodes??[]), ...(data.groups??[]), ...(data.items??[]), data])
          for (const b of owner?.blocks??[]) if(b?.type && (b.id||b.blockId))typedBlocks.set(b.id??b.blockId,b.type);
        if(data.block?.id && data.block?.type)typedBlocks.set(data.block.id,data.block.type);
        if(call.tool==="search")for(const result of data.items??[])if(result.objectType==="block"&&result.type)typedBlocks.set(result.id,result.type);
      }
      if(o.materials)for(const [key,type] of Object.entries({chart:"chart",code:"code",quote:"quote",image:"image",document:"document",link:"link",file:"file"}))
        typedBlocks.set(o.materials[key],type);
      typedBlocks.set(o.ledger,"table");typedBlocks.set(o.register,"spreadsheet");
      typedBlocks.set(o.atlas.block,"experimentRecord");typedBlocks.set(o.reed.block,"experimentRecord");
      for(const s of r.stages)for(const cand of s.candidates)for(const b of cand.blocks)typedBlocks.set(b.id,b.type);
      const types = new Set();
      for(const c of trace.filter(c=>!c.failed)){
        const type = c.tool==="read_experiment" ? "experimentRecord" : c.tool==="read_blocks"&&c.args.mode==="read" ? typedBlocks.get(c.args.blockId) : undefined;
        if(type){types.add(type);blockViews.set(type,(blockViews.get(type)??0)+1);}
      }
      for(const s of r.stages){
        assert.equal(s.nativeSessionId,r.nativeSession);
        assert.ok(s.callEnd>=s.callStart && s.requestEnd>=s.requestStart);
        const segment=trace.slice(s.callStart,s.callEnd), usage=providerTokens(r.requests.slice(s.requestStart,s.requestEnd));
        turns.push({batch,client:r.runtime,task:r.case,site:o.variant,turn:s.index,stop:s.stop??s.error?.message,toolCalls:segment.length,
          failedTools:segment.filter(c=>c.failed).length,input:usage?.input,cached:usage?.cached,output:usage?.output,tokens:usage?.total,formalIntact:s.formalBefore===s.formalAfter});
      }
      const amended = r.case==="panel" && r.stages.length===2;
      if(amended){
        assert.notEqual(o.initialVersion,o.revisedVersion);
        assert.equal(o.ledgerRevision,2);
        assert.notEqual(r.stages[0].formalAfter,r.stages[1].formalBefore);
      }
      const last=r.stages.at(-1)?.candidates??[];
      if(r.review?.applied)assert.equal(last.length,1);
      const tokens=providerTokens(r.requests);
      assert.deepEqual(tokens,r.tokens);
      const native=r.events.filter(e=>e.usage?.total?.totalTokens>0).at(-1)?.usage.total.totalTokens??null;
      const nativeFailures=new Set(r.events.filter(e=>e.type==="tool.failed"&&e.tool&&!manifest.tools.includes(e.tool)&&!/topolumia|mcpToolCall/i.test(e.tool)).map(e=>e.id??JSON.stringify(e))).size;
      records.push({batch,client:r.runtime,task:r.case,site:o.variant,passed,possible,complete:passed===possible&&r.stop==="end_turn"&&r.verifiedModel,stop:r.stop??r.error?.message??"unknown",
        providerTokens:tokens?.total??null,knownTokens:providerTokens(r.requests.filter(q=>q.usage))?.total??0,cached:tokens?.cached??null,nativeTokens:native,
        verifiedModel:r.verifiedModel,toolCalls:trace.length,toolFailures:trace.filter(c=>c.failed).length,nativeFailures,
        gatewayFailures:r.requests.filter(q=>q.status>=400||q.status==null&&q.error).length,
        amended,applied:Boolean(r.review?.applied),types:[...types].sort(),missed:Object.keys(checks).filter(k=>!checks[k]),checks});
      end=Math.max(end,Date.parse(r.started)+r.elapsedMs);
    }
    if(/^round-\d+$/.test(batch)){
      const i=Number(batch.slice(6)),decision=i?await read("",`decision-${String(i).padStart(2,"0")}.json`):{suite:"observatory",reason:"Initial product"};
      assert.equal(files.length,decision.suite==="observatory"?6:3,batch);
      assert.ok(start>=lastEnd-100,`Sequential round overlap: ${batch}`);
      lastEnd=end;
      studies.push({batch,product:manifest.head,suite:decision.suite,reason:decision.reason,started:manifest.started,ended:new Date(end).toISOString(),sessions:files.length});
    }
  }
  assert.equal(studies.length,expectedRounds);
  for(const batch of ["round-00","round-"+String(expectedRounds-1).padStart(2,"0"),"control-quay","confirm-quay"]){
    assert.equal(records.filter(r=>r.batch===batch).length,6,batch);
  }
  const portable = await Promise.all(["Alder-plaza","Alder-quay","Alder-reviewed"].map(dir=>inspectProject(path.join(root,"workspaces",dir))));
  const result = { model,studies,records,turns,portable,tools:[...usedTools].sort(),blockReads:Object.fromEntries([...blockViews].sort()),
    responseVerified:records.filter(r=>r.verifiedModel).length,usageComplete:records.filter(r=>r.providerTokens!==null).length };
  await writeFile(path.join(root,"audit.json"),JSON.stringify(result,null,2));
  const columns=Object.keys(turns[0]);
  await writeFile(path.join(root,"turns.csv"),[columns.join(","),...turns.map(s=>columns.map(k=>csv(s[k])).join(","))].join("\n")+"\n");
  return result;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const data=await auditStudy(path.resolve(process.argv[2]??"artifacts/observatory-study"),Number(process.argv[3]??12));
  console.log(JSON.stringify({rounds:data.studies.length,sessions:data.records.length,turns:data.turns.length,verified:data.responseVerified,tools:data.tools.length,types:Object.keys(data.blockReads).length}));
}
