import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../dist/src/server.js";
import { exportXlsxTable } from "../../dist/src/services/topology/table-importers.js";

let app: any, root: string, actor: any, baseline: string, variant: string, design: string, summary: string;
const password = "Node-Group-Browser-2026!";
test.use({ actionTimeout: 10000 });
test.beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "topolumia-node-group-browser-"));
  app = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: { project: { workspacesRoot: path.join(root, "workspaces") }, sourceRefresh: { enabled: false }, curator: { enabled: false }, agentSessions: { profiles: [] } } });
  const user = app.collaboration.bootstrapAdmin({ username: "group-browser", password }); actor = app.collaboration.actorForUser(user.id, app.config.project.id);
  const make = (kind: string, name: string) => app.researchNodes.createNode(kind, { nodeName: name }, actor).node.id;
  baseline = make("experiment", "Baseline experiment"); variant = make("experiment", "Variant experiment"); design = make("question", "Experiment design"); summary = make("inference", "Experiment summary");
  await mkdir(path.join(root, "fixtures"));
  await writeFile(path.join(root, "fixtures", "comparison.xlsx"), Buffer.from(exportXlsxTable({ columns: [{ key: "method", label: "Method" }, { key: "score", label: "Accuracy" }], rows: [{ method: "Baseline", score: 0.81 }, { method: "Variant", score: 0.86 }] }, "Comparison")));
  const slash = String.fromCharCode(92);
  await writeFile(path.join(root, "fixtures", "comparison.tex"), [slash + "begin{tabular}{lr}", "Method & Score " + slash + slash, "Baseline & 0.81 " + slash + slash, "Variant & 0.86 " + slash + slash, slash + "end{tabular}"].join("\n"));
});
test.afterAll(async () => {
  for (const runtime of app.runtimes.values()) { await runtime.agentSessionGateway.closeAll(); await runtime.researchCommands.assets.close(); await runtime.agentMedia.close(); await runtime.toolEnvironment.catalog.close(); await runtime.toolEnvironment.research.close(); }
  await app.sshEnvironments.close(); await app.sshConnections.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await rm(root, { recursive: true, force: true, maxRetries: 3 });
});
test.beforeEach(async ({ page }) => { await page.request.post(app.url + "/api/auth/login", { data: { username: "group-browser", password } }); });

test("create a group, edit roles, import real tables, and retain design/summary edges when folded", async ({ page }, testInfo) => {
  test.setTimeout(90000); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(app.url + "/#/topology");
  await page.getByRole("button", { name: "新建节点组", exact: true }).click();
  let dialog = page.getByRole("dialog"); await dialog.getByLabel("组名称", { exact: true }).fill("Conditioning 消融实验");
  await dialog.locator("summary").filter({ hasText: "选择成员" }).click();
  await dialog.getByLabel(/Baseline experiment/).check(); await dialog.getByLabel(/Variant experiment/).check();
  await dialog.getByRole("button", { name: "保存节点组", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Conditioning 消融实验", exact: true })).toBeVisible();
  const groupId = decodeURIComponent(page.url().split("/").at(-1)!);
  await page.getByRole("row").filter({ hasText: "Baseline experiment" }).getByRole("button", { name: "编辑成员", exact: true }).click();
  dialog = page.getByRole("dialog"); await dialog.getByLabel("成员角色（可选）", { exact: true }).fill("baseline"); await dialog.getByLabel("成员说明（可选）", { exact: true }).fill("相同数据划分"); await dialog.getByRole("button", { name: "保存成员", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Baseline experiment" })).toContainText("baseline");
  await page.getByRole("button", { name: "研究材料", exact: true }).click();
  for (const [title, file] of [["比较表 XLSX", "comparison.xlsx"], ["比较表 TeX", "comparison.tex"]]) {
    await page.getByRole("button", { name: "添加内容块", exact: true }).click(); await page.getByLabel("内容块标题", { exact: true }).fill(title);
    await page.getByRole("button", { name: "内容类型", exact: true }).click(); await page.getByRole("option", { name: "表格", exact: true }).click();
    await page.getByLabel("或导入 TeX / XLSX / CSV 表格", { exact: true }).setInputFiles(path.join(root, "fixtures", file));
    await page.getByRole("button", { name: "保存内容块", exact: true }).click(); await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  }
  await expect(page.locator(".content-block-list")).toContainText("0.86");
  const texCard = page.locator(".content-block-card").filter({ hasText: "比较表 TeX" }); await expect(texCard.getByRole("tab", { name: "表格数据", exact: true })).toBeVisible({ timeout: 20000 }); await texCard.getByRole("tab", { name: "表格数据", exact: true }).click(); await expect(texCard.getByRole("cell", { name: "0.86", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加内容块", exact: true }).click(); await page.getByLabel("内容块标题", { exact: true }).fill("研究示意图"); await page.getByRole("button", { name: "内容类型", exact: true }).click(); await page.getByRole("option", { name: "图片 / 截图", exact: true }).click(); await page.locator('.content-block-editor input[type="file"]').setInputFiles(path.resolve("frontend/public/topolumia-mark.png")); await page.getByRole("button", { name: "保存内容块", exact: true }).click(); await expect(page.getByRole("img", { name: "研究示意图", exact: true })).toBeVisible();
  const download = page.waitForEvent("download"); await page.locator(".content-block-card").filter({ hasText: "比较表 XLSX" }).getByRole("button", { name: "XLSX", exact: true }).click(); await (await download).saveAs(path.join(root, "exported-comparison.xlsx"));
  await page.screenshot({ path: testInfo.outputPath("group-materials.png"), fullPage: true });
  await page.getByRole("button", { name: "关系", exact: true }).click();
  for (const [target, direction, primaryName] of [["Experiment design", "关联对象 → 当前对象", "设为主入边"], ["Experiment summary", "当前对象 → 关联对象", "设为主出边"]]) {
    await page.getByRole("button", { name: "添加关系", exact: true }).click(); dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "关联对象", exact: true }).click(); await dialog.getByRole("option", { name: target, exact: true }).click();
    await dialog.getByRole("button", { name: "关系方向", exact: true }).click(); await dialog.getByRole("option", { name: direction, exact: true }).click();
    await dialog.getByRole("button", { name: "保存关系", exact: true }).click(); await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: primaryName, exact: true }).click();
  }
  await page.getByRole("link", { name: "在拓扑中聚焦", exact: true }).click();
  const card = page.locator(".research-graph-node").filter({ hasText: "Conditioning 消融实验" });
  await card.getByRole("button", { name: "收起 Conditioning 消融实验", exact: true }).click(); await expect(card).toHaveAttribute("data-collapsed", "true");
  await expect(page.locator(".research-graph-node[data-object-id='" + baseline + "']")).toHaveCount(0);
  await expect(page.locator(".research-graph-edge.is-primary")).toHaveCount(2);
  await page.reload(); await expect(card).toHaveAttribute("data-collapsed", "true");
  await card.getByRole("button", { name: "展开 Conditioning 消融实验", exact: true }).click(); await expect(card).toHaveAttribute("data-collapsed", "false");
  await expect(page.locator(".research-graph-node[data-object-id='" + baseline + "']")).toHaveCount(1); await expect(page.locator(".research-graph-edge.is-primary")).toHaveCount(2);
  const g = app.researchCommands.groups.get(groupId); expect(g.primaryRelations.incomingRelationId).toBeTruthy(); expect(g.primaryRelations.outgoingRelationId).toBeTruthy(); expect(app.state.topology.edges.find(edge => edge.id === g.primaryRelations.incomingRelationId).from.id).toBe(design); expect(app.state.topology.edges.find(edge => edge.id === g.primaryRelations.outgoingRelationId).to.id).toBe(summary); expect(errors).toEqual([]);
  await expect(page.locator(".container-topology-canvas")).toHaveAttribute("data-camera-moving", "false");
  await page.screenshot({ path: testInfo.outputPath("group-topology.png"), fullPage: true });
});

test("review actual group members and material, accept them, and delete only the group", async ({ page }) => {
  const c = app.researchCommands;
  const created = c.changes.direct([{ op: "addGroup", clientRef: "group", core: { nodeName: "待确认比较组" }, members: [{ nodeId: baseline, role: "baseline" }] }], actor), id = created.allocation["group:group"];
  const agent = { ...actor, isAgent: true, principalId: "agent:group-browser", sessionId: "group-browser-session", permissions: ["research.view", "research.proposeChange"] };
  c.queries.readGroups({ actor: agent, mode: "members", groupId: id, scope: "direct" });
  c.createCandidate({ actor: agent, reason: "补充对照角色和结果", groupChanges: [{ groupId: id, expectedMembershipRevision: c.groups.get(id).membershipRevision, membersPatch: { update: [{ nodeId: baseline, role: "control" }], add: [{ nodeId: variant, role: "variant" }] }, addBlocks: [{ title: "Agent 比较结果", type: "metric", payload: { items: [{ name: "Accuracy", value: 0.86, condition: "Held-out split" }] } }] }] });
  await page.goto(app.url + "/#/topology/groups/" + encodeURIComponent(id));
  const candidate = page.getByRole("article", { name: "补充对照角色和结果", exact: true });
  await candidate.locator("summary").click(); await expect(candidate).toContainText("control"); await expect(candidate).toContainText("Variant experiment"); await expect(candidate).toContainText("0.86");
  await candidate.getByRole("button", { name: "接受并保存", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Baseline experiment" })).toContainText("control");
  await page.getByRole("button", { name: "研究材料", exact: true }).click(); await expect(page.getByRole("heading", { name: "Agent 比较结果", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "删除节点组", exact: true }).click(); const dialog = page.getByRole("dialog"); await expect(dialog).toContainText("保留 2 个节点");
  await dialog.getByLabel("删除原因", { exact: true }).fill("临时比较已完成，保留实验节点"); await dialog.getByRole("button", { name: "删除组，保留节点", exact: true }).click();
  await expect(page.getByRole("heading", { name: "科研拓扑", exact: true })).toBeVisible(); expect(c.nodes.node(baseline).id).toBe(baseline); expect(c.nodes.node(variant).id).toBe(variant); expect(c.store.get("groups", id).deleted).toBe(true);
});

test("compact previews expand into containers, keep edge context and restore nested camera views", async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const c = app.researchCommands;
  const createNode = (name: string) => app.researchNodes.createNode("experiment", { nodeName: name }, actor).node.id;
  const members = [createNode("Camera baseline"), createNode("Camera variant"), createNode("Camera control")];
  const childMembers = [createNode("Nested seed 13"), createNode("Nested seed 42")];
  const makeGroup = (name: string, ids: string[], parentId: string | null = null) => {
    const view = c.changes.direct([{ op: "addGroup", clientRef: "group", core: { nodeName: name }, members: ids.map(nodeId => ({ nodeId })), parentId, ...(parentId ? { expectedParentRevision: c.groups.get(parentId).membershipRevision } : {}) }], actor);
    return view.allocation["group:group"];
  };
  const id = makeGroup("摄像机交互实验组", members), childId = makeGroup("重复实验子组", childMembers, id);
  const connect = (from, to, label) => c.changes.direct([{ op: "addEdge", clientRef: "edge", edge: { from, to, type: "informs" }, label, expectedEndpointRevisions: [from, to].map(object => ({ object, revision: c.objects.get(object).revision })) }], actor);
  connect({ kind: "node", id: design }, { kind: "group", id }, "设计指导整个实验组");
  connect({ kind: "group", id }, { kind: "node", id: summary }, "汇总到实验结论");
  connect({ kind: "node", id: baseline }, { kind: "node", id: createNode("Separate research context") }, "旁支研究关系");
  const originalRevision = c.groups.get(id).revision;
  await page.goto(app.url + "/#/topology");
  const canvas = page.locator(".container-topology-canvas"), container = page.locator(`.topology-group-container[data-object-id='${id}']`), child = page.locator(`.topology-group-container[data-object-id='${childId}']`);
  await expect(container).toHaveAttribute("data-collapsed", "true"); await expect(container.locator("circle")).toHaveCount(5);
  await expect(canvas.getByRole("status")).toHaveCount(0);
  expect(await page.locator(`.topology-container-surface[data-container-id='${id}']`).boundingBox()).toEqual(await container.boundingBox());
  const camera = async () => canvas.evaluate(element => ({ x: Number((element as HTMLElement).dataset.cameraX), y: Number((element as HTMLElement).dataset.cameraY), scale: Number((element as HTMLElement).dataset.cameraScale) }));
  const before = await camera();
  await container.getByRole("button", { name: "展开 摄像机交互实验组", exact: true }).click();
  await expect(container).toHaveAttribute("data-collapsed", "false"); await expect(canvas).toHaveAttribute("data-focused-group", id);
  await expect(canvas).toHaveAttribute("data-camera-moving", "false");
  await expect.poll(async () => { const frame = (await container.boundingBox())!, view = (await canvas.boundingBox())!; return Math.max(frame.width / view.width, frame.height / view.height); }).toBeCloseTo(0.8, 1);
  const assertInside = async (inner, outer) => { const a = (await inner.boundingBox())!, b = (await outer.boundingBox())!; expect(a.x).toBeGreaterThan(b.x); expect(a.y).toBeGreaterThan(b.y + 30); expect(a.x + a.width).toBeLessThan(b.x + b.width); expect(a.y + a.height).toBeLessThan(b.y + b.height); };
  const baselineNode = page.locator(`.topology-member-node[data-object-id='${members[0]}']`);
  await assertInside(baselineNode, container); await assertInside(child, container);
  const focused = await camera();
  const frame = (await container.boundingBox())!, view = (await canvas.boundingBox())!;
  expect(frame.x - view.x).toBeGreaterThan(25); expect(view.x + view.width - frame.x - frame.width).toBeGreaterThan(25);
  await expect(canvas.getByRole("button", { name: "设计指导整个实验组", exact: true })).toBeVisible(); await expect(canvas.getByRole("button", { name: "汇总到实验结论", exact: true })).toBeVisible();
  await expect(canvas.getByRole("button", { name: /旁支研究关系/ })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("expanded-container.png"), fullPage: true });
  await child.getByRole("button", { name: "展开 重复实验子组", exact: true }).click(); await expect(canvas).toHaveAttribute("data-focused-group", childId);
  await expect(canvas).toHaveAttribute("data-camera-moving", "false");
  await expect.poll(async () => { const a = (await child.boundingBox())!, b = (await canvas.boundingBox())!; return Math.max(a.width / b.width, a.height / b.height); }).toBeCloseTo(.8, 1);
  await assertInside(page.locator(`.topology-member-node[data-object-id='${childMembers[0]}']`), child);
  await canvas.getByRole("button", { name: "返回上一级视角", exact: true }).click(); await expect(child).toHaveAttribute("data-collapsed", "true");
  await expect.poll(async () => (await camera()).scale).toBeCloseTo(focused.scale, 3);
  const oldMember = (await baselineNode.boundingBox())!, header = container.locator(".topology-container-header");
  const handle = (await header.locator("h3").boundingBox())!;
  await page.mouse.move(handle.x + 20, handle.y + 8); await page.mouse.down(); await page.mouse.move(handle.x + 65, handle.y + 28, { steps: 6 }); await page.mouse.up();
  const movedMember = (await baselineNode.boundingBox())!; expect(movedMember.x - oldMember.x).toBeCloseTo(45, 0); expect(movedMember.y - oldMember.y).toBeCloseTo(20, 0); await assertInside(baselineNode, container);
  await container.getByRole("button", { name: "收起 摄像机交互实验组", exact: true }).click(); await expect(container).toHaveAttribute("data-collapsed", "true");
  await expect.poll(async () => (await camera()).scale).toBeCloseTo(before.scale, 3); await expect.poll(async () => (await camera()).x).toBeCloseTo(before.x, 1); await expect.poll(async () => (await camera()).y).toBeCloseTo(before.y, 1);
  await expect(canvas.getByRole("button", { name: /旁支研究关系/ })).toHaveCount(1);
  expect(c.groups.get(id).revision).toBe(originalRevision);
  await page.reload(); await expect(container).toHaveAttribute("data-collapsed", "true"); await expect(canvas.getByRole("status")).toHaveCount(0);
  expect(await page.locator(`.topology-container-surface[data-container-id='${id}']`).boundingBox()).toEqual(await container.boundingBox());
  await page.screenshot({ path: testInfo.outputPath("compact-container.png"), fullPage: true });
});
