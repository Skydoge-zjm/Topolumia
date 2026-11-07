import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startMvpServer } from "../../dist/src/server.js";

test("editing research material preserves provenance and new relations share node revisions", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-edit-browser-"));
  const app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: { project: { workspacesRoot: path.join(root, "workspaces") }, sourceRefresh: { enabled: false }, curator: { enabled: false }, agentSessions: { profiles: [] } } });
  try {
    const password = "Research-Edit-Browser-2026!";
    const admin = app.collaboration.bootstrapAdmin({ username: "edit-browser", password });
    const actor = app.collaboration.actorForUser(admin.id, app.config.project.id);
    const paper = app.researchNodes.createNode("paper", { nodeName: "SR3", paperTitle: "Image Super-Resolution via Iterative Refinement" }, actor);
    const question = app.researchNodes.createNode("note", { nodeName: "感知质量与失真" }, actor);
    const original=app.researchCommands.changes.direct([{op:"addBlock",owner:{kind:"node",id:paper.node.id},clientRef:"block",title:"原始指标",type:"metric",payload:{items:[{name:"FID",value:5.2,condition:"Same compute budget",note:"Three seeds",sourceRefIds:["source:table2"]}]},sourceRefs:[{id:"source:table2",kind:"table",value:"Table 2",locator:{page:"6"}}]}],actor).blocks.find(block=>block.title==="原始指标");
    await page.request.post(app.url + "/api/auth/login", { data: { username: "edit-browser", password } });
    await page.goto(app.url + "/#/topology/nodes/" + encodeURIComponent(paper.node.id));
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.getByRole("button", { name: "编辑内容块", exact: true }).click();
    await page.getByRole("textbox", { name: "内容块标题", exact: true }).fill("Table 2 指标");
    expect(await page.locator(".content-block-editor").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: "runtime/self-review/research-metric-editor.png", fullPage: true });
    await page.getByRole("button", { name: "保存内容块", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Table 2 指标", exact: true })).toBeVisible();
    const renamed = app.researchCommands.nodes.block(paper.node.id, original.id);
    expect(renamed.payload).toEqual(original.payload);
    expect(renamed.sourceRefs).toEqual(original.sourceRefs);
    await page.getByRole("button", { name: "编辑内容块", exact: true }).click();
    await page.getByRole("textbox", { name: "数值", exact: true }).fill("6.1");
    await page.getByRole("button", { name: "保存内容块", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "内容块标题", exact: true })).toHaveCount(0);
    expect(app.researchCommands.nodes.block(paper.node.id, original.id).payload.items[0]).toEqual({ ...original.payload.items[0], value: 6.1 });
    const before = app.researchNodes.node(paper.node.id).revision;
    await page.getByRole("button", { name: "关系与来源", exact: true }).click();
    await page.getByRole("button", { name: "添加关系", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "关联对象", exact: true }).click();
    await page.getByRole("option", { name: "感知质量与失真", exact: true }).click();
    await dialog.getByRole("button", { name: "保存关系", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("link", { name: /感知质量与失真/ })).toBeVisible();
    expect(app.researchNodes.node(paper.node.id).revision).toBe(before + 1);
    expect(app.researchNodes.node(question.node.id).revision).toBe(2);
    expect(errors).toEqual([]);
    await page.screenshot({ path: "runtime/self-review/research-edit-integrity.png", fullPage: true });
  } finally {
    for (const r of app.runtimes.values()) { await r.agentSessionGateway.closeAll(); await r.researchCommands.assets.close(); await r.agentMedia.close(); await r.toolEnvironment.catalog.close(); await r.toolEnvironment.research.close(); }
    app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await rm(root, { recursive: true, force: true });
  }
});
