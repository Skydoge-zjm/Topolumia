import { test, expect } from "@playwright/test";
import path from "node:path";
import { fixture } from "../../dist/tests/research/interface/helpers.js";
import { readFile } from "node:fs/promises";
import { parseXlsxTable } from "../../dist/src/services/topology/table-importers.js";

test("reading results persist after review; node deletion protects and reloads real version conflicts", async ({ page }) => {
  test.setTimeout(90_000);
  let cleanup: () => Promise<void>;
  const f = await fixture({ after(fn: () => Promise<void>) { cleanup = fn; } });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.setContent('<svg width="420" height="140" xmlns="http://www.w3.org/2000/svg"><rect width="420" height="140" fill="white"/><rect x="10" y="30" width="155" height="60" rx="8" fill="#e5f3ed" stroke="#178d70"/><rect x="245" y="30" width="165" height="60" rx="8" fill="#e5f3ed" stroke="#178d70"/><text x="26" y="64" font-family="sans-serif" font-size="16">Research question</text><text x="272" y="64" font-family="sans-serif" font-size="16">Source evidence</text><path d="M165 60H235L225 53M235 60L225 67" fill="none" stroke="#178d70"/><text x="12" y="123" font-family="sans-serif" font-size="12">Synthetic source fixture for file-transfer verification</text></svg>');
    await page.locator("svg").screenshot({path:path.join(f.binding.env.TOPOLUMIA_TRANSFER_ROOT,"out/research-figure.png")});
    const image=(await f.data("transfer_asset",{direction:"upload",relativePath:"out/research-figure.png",idempotencyKey:"browser-research-figure"})).data;
    await page.request.post(f.app.url + "/api/auth/login", { data: { username: "interface-admin", password: "Isolated-Interface-Test-2026!" } });
    await page.addInitScript(({ id }) => localStorage.setItem("research-workbench-project", id), { id: f.app.config.project.id });
    const identity = (await f.data("create_candidate", { reason: "Save paper identity only", nodes: [{ kind: "paper", core: { nodeName: "Reading result browser fixture", paperTitle: "Synthetic evidence for a complete review flow" } }] })).data;
    expect(identity.researchContent.identityOnlyPapers).toBe(1);
    await page.goto(`${f.app.url}/#/agents?candidate=${encodeURIComponent(identity.candidateId)}`);
    await expect(page.getByText("仅包含文献基础信息，没有阅读内容。接受此候选不会保存论文阅读结果。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "接受并保存", exact: true }).click();
    await page.getByRole("link", { name: "查看已保存对象 · Reading result browser fixture", exact: true }).click();
    await expect(page.getByRole("heading", { name: "暂无研究材料", exact: true })).toBeVisible();

    const firstText = "This fixture preserves the exact method explanation in the formal node, including its source limitation.";
    const secondText = "The result is a draft interpretation, not a verified scientific claim.";
    const proposal = (await f.data("create_candidate", { reason: "Add the missing reading results", nodeChanges: [{ nodeId: identity.nodes[0].nodeId, addBlocks: [
      { title: "Method and evidence", type: "richText", payload: { format: "markdown", body: firstText }, review: "needs_review", sourceRefs: [{ kind: "section", value: "Synthetic source method" }] },
      { title: "Reading limitations", type: "richText", payload: { format: "markdown", body: secondText }, review: "needs_review" },
      { title: "Synthetic source framework",type:"image",payload:{alt:"Synthetic research framework",caption:"Synthetic source fixture, not a published paper figure."},representations:[{kind:"asset",assetId:image.assetId,role:"source"}],review:"needs_review" },
      { title: "Structured source comparison",type:"table",payload:{columns:[{key:"aspect",label:"Aspect"},{key:"value",label:"Value"}],rows:[{aspect:"Source type",value:"Qualitative comparison"},{aspect:"Scope",value:"Synthetic test fixture"}],caption:"Transcription scope is visible beside the rendered table."},review:"needs_review" },
    ] }] })).data;
    expect(proposal.researchContent.addedBlocks).toBe(4);
    expect(proposal.researchContent.blockTypes).toMatchObject({richText:2,image:1,table:1});
    expect(proposal.researchContent.imageAssets).toBe(1);
    await page.reload();
    await expect(page.getByRole("heading", { name: "待审科研变更", exact: true })).toBeVisible();
    await expect(page.getByText(firstText, { exact: true })).toBeVisible();
    await expect(page.getByText(secondText, { exact: true })).toBeVisible();
    const previewImage=page.getByRole("img",{name:"Synthetic research framework",exact:true});
    await previewImage.scrollIntoViewIfNeeded();
    await expect.poll(()=>previewImage.evaluate(image=>(image as HTMLImageElement).naturalWidth)).toBe(420);
    await expect(page.getByRole("cell",{name:"Qualitative comparison",exact:true})).toBeVisible();
    await expect(page.getByText("Transcription scope is visible beside the rendered table.",{exact:true})).toBeVisible();
    const downloadEvent=page.waitForEvent("download");
    await page.getByRole("button",{name:"XLSX",exact:true}).click();
    const downloaded=await downloadEvent;
    expect(await downloaded.failure()).toBeNull();
    const exported=await parseXlsxTable(await readFile((await downloaded.path())!));
    expect(exported.totalRows).toBe(2);
    expect(JSON.stringify(exported.rows)).toContain("Qualitative comparison");
    expect(f.runtime.researchCommands.nodes.blocks(identity.nodes[0].nodeId)).toHaveLength(0);
    await page.getByRole("button", { name: "接受并保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: "待审科研变更", exact: true })).toHaveCount(0);
    await expect(page.getByText(firstText, { exact: true })).toBeVisible();
    await expect(page.getByText(secondText, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(firstText, { exact: true })).toBeVisible();
    await expect(page.getByText(secondText, { exact: true })).toBeVisible();
    await expect(page.getByRole("cell",{name:"Qualitative comparison",exact:true})).toBeVisible();
    await expect.poll(()=>page.getByRole("img",{name:"Synthetic research framework",exact:true}).evaluate(image=>(image as HTMLImageElement).naturalWidth)).toBe(420);
    expect(f.runtime.researchCommands.nodes.blocks(identity.nodes[0].nodeId).filter(block=>block.type==="richText").map(block => block.payload.body)).toEqual([firstText, secondText]);
    await page.screenshot({ path: path.resolve("runtime/agent-interface-evaluation/accepted-reading-node.png"), fullPage: true });

    // The node changes after the page was read: protect it, then reload and delete via the actual dialog.
    const nodeId=identity.nodes[0].nodeId;
    f.runtime.researchNodes.updateCore(nodeId,{venue:"Updated after the page loaded"},f.actor,f.runtime.researchNodes.detail(nodeId).coreRevision);
    await page.getByRole("button",{name:"删除节点",exact:true}).click();
    await page.getByLabel("删除原因",{exact:true}).fill("Delete the isolated browser fixture");
    await page.getByRole("button",{name:"确认删除",exact:true}).click();
    await expect(page.getByRole("alert")).toContainText("节点内容已更新");
    await page.getByRole("button",{name:"重新载入并查看节点",exact:true}).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button",{name:"删除节点",exact:true}).click();
    await page.getByLabel("删除原因",{exact:true}).fill("Delete the isolated browser fixture");
    await page.getByRole("button",{name:"确认删除",exact:true}).click();
    await expect(page).toHaveURL(/#\/records\/history\//);
    expect(f.runtime.researchCommands.store.get("nodes",nodeId).deleted).toBe(true);
    expect(f.runtime.researchCommands.store.all("blocks").filter(block=>block.nodeId===nodeId).every(block=>block.lifecycle==="archived")).toBe(true);
    expect(f.runtime.state.topology.nodes.some(node=>node.id===nodeId)).toBe(false);
  } finally { await cleanup!(); }
});
