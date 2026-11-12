import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startMvpServer } from "../../dist/src/server.js";

test("research text keeps its original language and a block conflict can be reloaded before an explicit delete", async ({
  page,
}) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "topolumia-browser-reliability-"),
  );
  const app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: path.join(root, "db.sqlite"),
    userSettingsFile: path.join(root, "settings.json"),
    config: {
      project: { workspacesRoot: path.join(root, "workspaces") },
      sourceRefresh: { enabled: false },
      curator: { enabled: false },
      agentSessions: { profiles: [] },
    },
  });
  try {
    const password = "Browser-Reliability-Only-2026!";
    const user = app.collaboration.bootstrapAdmin({
      username: "review",
      password,
    });
    const pid = app.config.project.id,
      actor = app.collaboration.actorForUser(user.id, pid);
    const runtime = app.runtimes.get(pid),
      commands = runtime.researchCommands;
    const candidate = commands.createCandidate({
      actor,
      reason: "训练对比",
      nodes: [
        {
          kind: "paper",
          core: { nodeName: "不同学习率探索", paperTitle: "Source title" },
          blocks: [
            {
              title: "实验结果",
              type: "richText",
              payload: { format: "markdown", body: "训练对比" },
            },
          ],
        },
      ],
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.request.post(`${app.url}/api/auth/login`, {
      data: { username: "review", password },
    });
    await page.goto(
      `${app.url}/#/agents?candidate=${encodeURIComponent(candidate.id)}`,
    );
    const card = page.locator(".research-candidate");
    await expect(card.locator(".agent-markdown")).toHaveText("训练对比");
    await page.getByRole("button", { name: "语言", exact: true }).click();
    await page.getByRole("option", { name: "English", exact: true }).click();
    await expect(
      card.getByRole("button", { name: "Accept and save", exact: true }),
    ).toBeVisible();
    await expect(card.locator(".agent-markdown")).toHaveText("训练对比");
    await expect(card.locator(".research-candidate-heading strong")).toHaveText(
      "训练对比",
    );
    await card
      .getByRole("button", { name: "Accept and save", exact: true })
      .click();
    await card
      .getByRole("link", { name: "Open saved object · 不同学习率探索", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Source title", exact: true }),
    ).toBeVisible();
    const nodeId =
      candidate.allocation["node:" + candidate.operations[0].clientRef];
    const block = commands.nodes.blocks(nodeId)[0];
    let conflicted = false;
    await page.route("**/api/research-objects/**", async (route) => {
      if (
        !conflicted &&
        route.request().method() === "DELETE" &&
        route.request().url().includes("/content-blocks/")
      ) {
        conflicted = true;
        runtime.researchCommands.changes.direct([{op:"updateBlock",owner:{kind:"node",id:nodeId},blockId:block.id,patch:{title:"Updated evidence"},expectedRevision:block.revision}],actor);
      }
      await route.continue();
    });
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "Delete content block", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("Research object changed");
    await page
      .getByRole("alert").getByRole("button", { name: "Reload", exact: true })
      .click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Updated evidence", exact: true }),
    ).toBeVisible();
    expect(commands.store.get("blocks", block.id).lifecycle).toBe("active");
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "Delete content block", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Updated evidence", exact: true }),
    ).toHaveCount(0);
    expect(commands.store.get("blocks", block.id).lifecycle).toBe("archived");
    await page.goto(`${app.url}/#/topology`);
    await expect(page.locator(".research-graph-node").first()).toBeVisible();
    await expect(page.locator(".research-layout-status")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    for (const runtime of app.runtimes.values()) {
      await runtime.agentSessionGateway.closeAll();
      await runtime.agentMedia.close();
      await runtime.researchCommands.assets.close();
      await runtime.toolEnvironment.catalog.close();
      await runtime.toolEnvironment.research.close();
    }
    await app.sshEnvironments.close();
    await app.sshConnections.close();
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(resolve));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
