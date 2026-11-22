import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { fixture } from "./helpers.js";
import { exportXlsxTable } from "../../../src/services/topology/table-importers.js";
import { FilesystemAdapter, isPathInside } from "../../../src/adapters/sources/filesystem-adapter.js";
test("chart and image manifests point to the actual table and the complete authored description", async t => {
  const f = await fixture(t), c = f.runtime.researchCommands;
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
  const asset = await c.assets.upload(Readable.from([png]), { originalName: "map.png", mediaType: "image/png", idempotencyKey: "map" }, f.actor);
  const allocation = c.changes.direct([{ op: "addNode", kind: "note", clientRef: "n", core: { nodeName: "Field" } },
    { op: "addBlock", clientRef: "data", owner: { kind: "node", id: "@n" }, title: "Measurements", type: "table",
      payload: { columns: [{ key: "v", label: "Value" }], rows: [{ v: 7 }] } }], f.actor).allocation;
  const owner = { kind: "node", id: allocation["node:n"] }, description = "Authored alt ".repeat(32);
  const ids = c.changes.direct([
    { op: "addBlock", clientRef: "plot", owner, title: "Chart", type: "chart", payload: { chartType: "bar", dataBlockId: allocation["block:data"] } },
    { op: "addBlock", clientRef: "photo", owner, title: "Map", type: "image", payload: { alt: description, caption: "Station" },
      representations: [{ kind: "asset", assetId: asset.id, role: "source" }] },
  ], f.actor).allocation;
  const manifest = id => f.data("read_blocks", { owner, blockId: id, mode: "read", view: "manifest" });
  const chart = await manifest(ids["block:plot"]);
  const { tool, ...args } = chart.data.chart.readHint;
  assert.equal(chart.data.chart.chartType, "bar");
  assert.ok((await f.data(tool, args)).data.items.some(row => row.values.v === 7));
  const image = await manifest(ids["block:photo"]);
  assert.equal(image.coverage.complete, false);
  const { tool: reader, ...hint } = image.data.image.descriptionReadHint;
  assert.equal((await f.data(reader, hint)).data.text, description + "\nStation");
});
test("an amendment can re-pin a revised source while keeping historical and same-version evidence", async t => {
  const f = await fixture(t), c = f.runtime.researchCommands;
  const file = path.join(f.app.config.project.root, "rule.md");
  async function publish(text) {
    await writeFile(file, text);
    f.runtime.state.setSnapshot({ stateVersion: text, files: await f.runtime.registry.filesystem.snapshot() });
    return (await f.data("read_source", { ref: "file:rule.md" })).readReceipts[0];
  }
  const a = await publish("Rule A");
  const created = (await f.data("create_candidate", { reason: "Preliminary", evidenceReadIds: [a.id],
    nodes: [{ kind: "note", core: { nodeName: "Decision" } }] })).data;
  const b = await publish("Rule B");
  const preview = await f.data("read_nodes", { nodeIds: [created.nodes[0].nodeId], candidateId: created.candidateId });
  assert.equal(preview.scope.changedSourceCount, 1);
  const summary = await f.data("read_candidates", { mode: "show", candidateId: created.candidateId });
  assert.equal(summary.data.changedSource.readHint.expectedVersion, b.version);
  const change = { candidateId: created.candidateId, expectedRevision: 1, nodeChanges: [{ nodeId: created.nodes[0].nodeId, corePatch: { summary: "Amendment B" } }] };
  const stale = await f.call("edit_candidate", change);
  assert.equal(stale.structuredContent.error.code, "OBJECT_VERSION_CONFLICT");
  assert.equal(stale.structuredContent.error.detail.readHint.expectedVersion, b.version);
  assert.throws(() => c.reviewCandidate({ actor: f.actor, candidateId: created.candidateId, expectedRevision: 1, decision: "accept" }), { code: "OBJECT_VERSION_CONFLICT" });
  const b2 = (await f.data("read_source", { ref: "file:rule.md", offset: 2 })).readReceipts[0];
  await f.data("edit_candidate", { ...change, evidenceReadIds: [b.id, b2.id] });
  const evidence = { mode: "show", section: "evidence", candidateId: created.candidateId, limit: 1 };
  const firstPage = await f.data("read_candidates", evidence);
  assert.ok(firstPage.page.nextCursor);
  const secondPage = await f.data("read_candidates", { ...evidence, cursor: firstPage.page.nextCursor });
  assert.deepEqual(new Set([firstPage.data.items[0].id, secondPage.data.items[0].id]), new Set([b.id, b2.id]));
  const saved = c.store.get("candidates", created.candidateId);
  assert.deepEqual(saved.evidenceReadIds, [b.id, b2.id]);
  assert.deepEqual(saved.revisions[0].evidenceReads.map(r => r.id), [a.id]);
  assert.equal(c.reviewCandidate({ actor: f.actor, candidateId: saved.id, expectedRevision: 2, decision: "accept" }).status, "applied");
});
test("real MCP → CLI saves a paper hierarchy, incrementally revises it and preserves review boundaries",{timeout:60000},async t=>{
  const f=await fixture(t);
  const context=await f.data("get_context");
  const example = await f.data("get_schema", { topic: "contentBlock", name: "metric", view: "example" });
  assert.equal(example.data.example.type, "metric");
  assert.equal(example.data.schema, undefined);
  const { tool: schemaTool, ...schemaInput } = example.data.readHint;
  const full = await f.data(schemaTool, schemaInput);
  assert.ok(full.data.schema.properties.payload);
  assert.ok(example.budget.returnedChars < full.budget.returnedChars / 2);
  const body="SOURCE_MARKER "+"synthetic evidence. ".repeat(80)+"result is not confirmed.";
  const input={reason:"Save reading",idempotencyKey:"paper-reading",nodes:[{kind:"paper",core:{nodeName:"Fixture paper",paperTitle:"Synthetic Paper"},blocks:[{title:"My understanding",type:"richText",payload:{format:"markdown",body}}]}]};
  const p=(await f.data("create_candidate",input)).data;
  assert.equal((await f.data("create_candidate",input)).data.candidateId,p.candidateId);
  assert.equal(p.formalChangesApplied,false);
  assert.equal(f.runtime.researchCommands.nodes.nodes().length,context.data.counts.nodes);
  const nodeId=p.nodes[0].nodeId,blockId=p.nodes[0].blocks[0].blockId;
  const draft=await f.data("read_blocks",p.nodes[0].blocks[0].readHint);
  assert.equal(draft.data.text,body);assert.equal(draft.readReceipts[0].scope,"candidate");
  assert.equal(draft.readReceipts[0].principalId, undefined);
  const storedReceipt = f.runtime.researchCommands.store.get("receipts", draft.readReceipts[0].id);
  assert.ok(storedReceipt.principalId && storedReceipt.researchSessionId && storedReceipt.at);
  assert.deepEqual(draft.readReceipts[0].delivered, storedReceipt.delivered);
  const edit={candidateId:p.candidateId,expectedRevision:1,nodeChanges:[{nodeId,corePatch:{venue:"Updated venue"},addBlocks:[{title:"Limits",type:"richText",payload:{format:"markdown",body:"Partial coverage."}}]}]};
  const revised=(await f.data("edit_candidate",edit)).data;
  assert.equal(revised.candidateId,p.candidateId);assert.equal(revised.revision,2);assert.equal(revised.nodes[0].blockCount,2);
  assert.equal((await f.data("edit_candidate",edit)).data.revision,2);
  assert.equal((await f.data("read_blocks",{mode:"read",owner: { kind: "node", id: nodeId },blockId,view:"text",candidateId:p.candidateId})).data.text,body);
  const candidateNodes=await f.data("read_candidates",{mode:"show",candidateId:p.candidateId,section:"nodes"});
  assert.equal(candidateNodes.data.items[0].blocks[0].readHint.candidateId, p.candidateId);
  const coreRef=candidateNodes.data.items[0].coreRefs.venue;
  assert.equal((await f.data("read_source",{...coreRef,candidateId:p.candidateId})).data.text,"Updated venue");
  const stale=await f.call("edit_candidate",{...edit,reason:"Different stale edit"});assert.equal(stale.isError,true);
  assert.equal((await f.api("POST",`/api/research/candidates/${encodeURIComponent(p.candidateId)}/review`,{decision:"accept",expectedRevision:2,reason:"Save for verification"},f.token)).status,403);
  const accepted=await f.api("POST",`/api/research/candidates/${encodeURIComponent(p.candidateId)}/review`,{decision:"accept",expectedRevision:2,reason:"Save for later verification"});assert.equal(accepted.status,200,JSON.stringify(accepted.body));
  assert.equal(f.runtime.researchCommands.nodes.block(nodeId,blockId).review,"unreviewed");
  const read=await f.data("read_blocks",{mode:"read",owner: { kind: "node", id: nodeId },blockId,view:"text",expectedRevision:1});
  const second=(await f.data("create_candidate",{reason:"Clarify note",idempotencyKey:"update-summary",evidenceReadIds:[read.readReceipts[0].id],nodeChanges:[{nodeId,updateBlocks:[{blockId,expectedRevision:1,patch:{payload:{format:"markdown",body:"Clarified result"}}}]}]})).data;
  await f.api("POST","/api/research-nodes",{kind:"paper",core:{nodeName:"Unrelated paper"}});
  const applied=await f.api("POST",`/api/research/candidates/${encodeURIComponent(second.candidateId)}/review`,{decision:"accept",expectedRevision:1,reason:"Apply related edit"});assert.equal(applied.status,200,JSON.stringify(applied.body));
  assert.equal(f.runtime.researchCommands.nodes.block(nodeId,blockId).payload.body,"Clarified result");
});
test("binary transfer keeps XLSX bytes out of context and reads row 4000 from the original",{timeout:60000},async t=>{
  const f=await fixture(t),rows=Array.from({length:5000},(_,i)=>({c1:"row-"+i,c2:i===3999?0:i+.25,c3:i===3999?"":false}));const bytes=Buffer.from(exportXlsxTable({columns:[{key:"c1",label:"Row"},{key:"c2",label:"Metric"},{key:"c3",label:"Value"}],rows},"Results"));await writeFile(path.join(f.binding.env.TOPOLUMIA_TRANSFER_ROOT,"out/large.xlsx"),bytes);
  const upload=(await f.data("transfer_asset",{direction:"upload",relativePath:"out/large.xlsx",idempotencyKey:"large-xlsx"})).data;assert.ok(upload.assetId);assert.equal((await f.data("transfer_asset",{direction:"upload",relativePath:"out/large.xlsx",idempotencyKey:"large-xlsx"})).data.assetId,upload.assetId);
  assert.equal((await f.data("transfer_asset",{direction:"upload",relativePath:"out\\large.xlsx",idempotencyKey:"large-xlsx"})).data.assetId,upload.assetId);
  const wrongRoot=await f.call("transfer_asset",{direction:"upload",relativePath:`.topolumia/transfers/${path.basename(f.binding.env.TOPOLUMIA_TRANSFER_ROOT)}/out/large.xlsx`,idempotencyKey:"wrong-root"});
  assert.equal(wrongRoot.isError,true);assert.equal(wrongRoot.structuredContent.error.detail.suggestedRelativePath,"out/large.xlsx");
  const values=await f.data("read_assets",{assetId:upload.assetId,view:"values",selection:{sheet:"Results",rowOffset:4000,rowLimit:2}});assert.equal(values.data.items[0].values.c1,"row-3999");assert.equal(values.data.items[0].values.c2,0);assert.equal(values.data.items[0].values.c3,"");
  const download={direction:"download",relativePath:"in/copy.xlsx",idempotencyKey:"download-xlsx",target:{kind:"asset",assetId:upload.assetId},variant:"original"};const result=await f.data("transfer_asset",download);assert.deepEqual(await readFile(result.data.path),bytes);assert.equal((await f.data("transfer_asset",download)).deliveryReceipt.id,result.deliveryReceipt.id);
  const forbidden=await f.call("transfer_asset",{direction:"upload",relativePath:"out/../../outside",idempotencyKey:"bad-path"});assert.equal(forbidden.isError,true);
});

test("paper sources retain their assets; existing draft blocks can be revised without resending other content",{timeout:60000},async t=>{
  const f=await fixture(t),file=path.join(f.binding.env.TOPOLUMIA_TRANSFER_ROOT,"out/reading.md");
  await writeFile(file,"Extracted source material for a focused reading.");
  const asset=(await f.data("transfer_asset",{direction:"upload",relativePath:"out/reading.md",idempotencyKey:"reading-material"})).data;
  const created=(await f.data("create_candidate",{reason:"Preserve paper source",nodes:[{kind:"paper",core:{nodeName:"Source retention"},sourceRefs:[{kind:"file",value:"reading.md",assetId:asset.assetId}],blocks:[{title:"Reading",type:"richText",payloadFromAsset:{assetId:asset.assetId,format:"markdown"}},{title:"Keep me",type:"richText",payload:{body:"Untouched material"}}]}]})).data;
  const nodeId=created.nodes[0].nodeId,blockId=created.nodes[0].blocks[0].blockId,removeId=created.nodes[0].blocks[1].blockId;
  assert.ok(f.runtime.researchCommands.store.get("candidates",created.candidateId).assetIds.includes(asset.assetId));
  const edited=(await f.data("edit_candidate",{candidateId:created.candidateId,expectedRevision:1,nodeChanges:[{nodeId,updateBlocks:[{blockId,patch:{title:"Verified reading",payload:{format:"markdown",body:"Revised grounded summary"}}}],archiveBlocks:[{blockId:removeId}]}]})).data;
  assert.equal(edited.nodes[0].blockCount,1);
  assert.equal((await f.data("read_blocks",{mode:"read",owner: { kind: "node", id: nodeId },blockId,candidateId:created.candidateId,view:"text"})).data.text,"Revised grounded summary");
  const applied=await f.api("POST",`/api/research/candidates/${encodeURIComponent(created.candidateId)}/review`,{decision:"accept",expectedRevision:2});
  assert.equal(applied.status,200,JSON.stringify(applied.body));
  assert.equal(f.runtime.researchCommands.assets.assert(asset.assetId,f.actor).bindingState,"attached");
});

test("research discovery excludes application files and returns actionable schema and PDF capabilities",{timeout:60000},async t=>{
  const f=await fixture(t),workspace=f.runtime.config.project.root;
  await mkdir(path.join(workspace,".topolumia/transfers/session/out"),{recursive:true});
  await writeFile(path.join(workspace,".topolumia/transfers/session/out/private.md"),"INTERNAL_NEEDLE");
  await writeFile(path.join(workspace,"readable.md"),"RESEARCH_NEEDLE source evidence.");
  await writeFile(path.join(workspace,"unindexed.pdf"),"%PDF-1.4\nResearch source fixture");
  const indexed=await f.runtime.registry.filesystem.snapshot();
  assert.ok(indexed.files.some(file=>file.label==="readable.md"));
  assert.ok(!indexed.files.some(file=>file.ref.includes("private")));
  f.runtime.state.setSnapshot({stateVersion:"source-test",files:indexed});
  assert.equal((await f.data("search",{query:"INTERNAL_NEEDLE",target:"sources"})).data.items.length,0);
  const pdf=(await f.data("search",{query:"unindexed",target:"sources"})).data.items[0];
  assert.equal(pdf.capabilities.textAvailable,false);assert.equal(pdf.readHint,undefined);assert.equal(pdf.nativeReadHint.path,path.join(workspace,"unindexed.pdf"));
  const missing=await f.call("read_source",{ref:pdf.ref});
  assert.equal(missing.isError,true);assert.ok(JSON.stringify(missing.structuredContent).includes("nativeReadHint"));
  const names=await f.data("get_schema",{topic:"nodeCore"});assert.ok(names.data.availableNames.includes("paper"));
  const invalid=await f.call("get_schema",{topic:"nodeCore",name:"PaperCore"});assert.equal(invalid.isError,true);assert.ok(JSON.stringify(invalid.structuredContent).includes("availableNames"));
  const invalidCore=await f.call("create_candidate",{reason:"Actual metadata error recovery",nodes:[{kind:"paper",core:{nodeName:"Example",arxivId:"2502.14321"}}]});
  assert.equal(invalidCore.isError,true);assert.ok(invalidCore.structuredContent.error.detail[0].allowedFields.includes("identifiers"));
  const wrongBlock = await f.call("create_candidate", { reason: "Package observations", nodes: [{ kind: "note", core: { nodeName: "Field" }, blocks: [
    { type: "richText", title: "Context", payload: { body: "Observations" } },
    { type: "table", title: "Signed offsets", payload: { columns: [{ key: "v", label: "Value", type: "number" }], rows: [{ v: 3 }] } },
  ] }] });
  const issue = wrongBlock.structuredContent.error.detail[0];
  assert.equal(issue.blockTitle, "Signed offsets");
  assert.deepEqual(issue.path, ["payload", "columns", 0]);
  assert.equal(issue.example.type, "table");
  await f.data("get_schema",{topic:"nodeCore",name:"paper"});
  const project=f.app.collaboration.createProject({id:"separate-workspace",name:"Separate scientific workspace"},f.actor);
  const projectRuntime=await f.app.getRuntime(project.id);
  assert.ok(isPathInside(f.app.config.project.workspacesRoot,projectRuntime.config.project.root));
  assert.ok(!isPathInside(path.dirname(projectRuntime.config.userSettings.file),projectRuntime.config.project.root));
});
