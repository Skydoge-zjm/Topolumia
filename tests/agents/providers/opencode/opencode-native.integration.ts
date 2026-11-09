import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../../../src/server.js";
import { buildResearchMcpBinding } from "../../../../src/agent/research-mcp-binding.js";
import { MCP_SESSION_HINT } from "../../../../src/domain/research/research-interface.js";
import { OpenCodeServer } from "../../../../src/adapters/agents/opencode/opencode-server.js";
import { OpenCodeAgentAdapter } from "../../../../src/adapters/agents/opencode/opencode-agent-adapter.js";

// Runs the installed OpenCode binary against a local OpenAI-compatible provider.
// It exercises the native process and its tool loop without spending user quota.
test("installed OpenCode: real MCP/CLI execution, second turn, snapshot, resume and cleanup", { timeout: 90_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-opencode-cli-"));
  const workbench = await startMvpServer({ port: 0, testMode: false, collaborationFile: path.join(root, "db.sqlite"), userSettingsFile: path.join(root, "settings.json"), config: { project: { workspacesRoot: path.join(root, "workspaces") }, sourceRefresh: { enabled: false } } });
  const owner = workbench.collaboration.bootstrapAdmin({ username: "native-cli", displayName: "Native CLI", password: "Native-CLI-2026-Test!" });
  const credential = workbench.collaboration.issueAgentCredential(workbench.collaboration.actorForUser(owner.id, workbench.config.project.id), workbench.config.project.id, "native-cli-session");
  const researchMcp = buildResearchMcpBinding({ baseUrl: workbench.url, projectId: workbench.config.project.id, sessionToken: credential, cwd: workbench.config.project.root });
  const ownedAdapters = [];
  let provider;
  t.after(async () => {
    for (const owned of ownedAdapters) await owned.close();
    if (provider) { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); }
    await workbench.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  let requests = 0;
  provider = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests++;
    const called = input.messages.some(m => m.role === "tool");
    const tool = input.tools?.find(tool => /topolumia.*get_context/.test(tool.function?.name));
    const delta = called ? { role: "assistant", content: "NATIVE_MCP_VERIFIED" } : {
      role: "assistant", content: "I will read research through MCP.", tool_calls: [{ index: 0, id: "call_native_check", type: "function", function: { name: tool?.function?.name ?? "MISSING_RESEARCH_MCP", arguments: "{}" } }],
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (choices, usage?) => res.write(`data: ${JSON.stringify({ id: `chatcmpl_${requests}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture", choices, ...(usage ? { usage } : {}) })}\n\n`);
    send([{ index: 0, delta, finish_reason: null }]);
    send([{ index: 0, delta: {}, finish_reason: called ? "stop" : "tool_calls" }], { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 });
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const baseURL = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
  let nativeUrl = "";
  const serverFactory = () => {
    const server = new OpenCodeServer();
    const original = server.start.bind(server);
    server.start = async (profile, cwd, config = {}, onExit, env) => {
      const result = await original(profile, cwd, { ...config, enabled_providers: ["native-fixture"], model: "native-fixture/fixture", provider: {
        "native-fixture": { npm: "@ai-sdk/openai-compatible", name: "Native integration fixture", options: { baseURL }, models: { fixture: { name: "Native test model", limit: { context: 32_768, output: 4_096 } } } },
      } }, onExit, env);
      nativeUrl = server.url;
      return result;
    };
    return server;
  };
  const events = [];
  const profile = { id: "native-integration", label: "OpenCode", provider: "opencode", command: "opencode", args: ["serve"], model: "native-fixture/fixture" };
  const adapter = new OpenCodeAgentAdapter(profile, { requestTimeoutMs: 45_000, serverFactory, onEvent: e => events.push(e) });
  ownedAdapters.push(adapter);
  const start = await adapter.start({ cwd: workbench.config.project.root, developerInstructions: MCP_SESSION_HINT, researchMcp });
  const result = await adapter.prompt({ turnId: "native-mcp", content: [{ type: "text", text: "Use Topolumia MCP get_context then report success." }] });
  assert.equal(result.stopReason, "end_turn");
  assert.equal(events.filter(e => e.type === "tool.started").length, 1);
  const tool = events.find(e => e.type === "tool.completed");
  assert.ok(tool, JSON.stringify(events));
  const context = JSON.parse(String(tool.payload.item.output));
  assert.equal(context.schemaVersion, "research-agent-result.v1");
  assert.equal(context.kind, "context");
  assert.equal(context.projectId, workbench.config.project.id);
  assert.equal(context.data.counts.nodes, 0);
  assert.ok(!JSON.stringify(events).includes(credential));
  assert.equal(events.filter(e => e.type === "assistant.message.completed").map(e => e.payload.text).join("\n"), "I will read research through MCP.\nNATIVE_MCP_VERIFIED");
  assert.equal((await adapter.prompt({ turnId: "second-turn", content: [{ type: "text", text: "Confirm the previous result." }] })).stopReason, "end_turn");
  const snapshot = await adapter.readSnapshot();
  assert.ok(snapshot.native.messages.length >= 5);
  assert.ok(requests >= 3);
  await adapter.close();
  await assert.rejects(fetch(`${nativeUrl}/global/health`, { signal: AbortSignal.timeout(1_000) }));
  const resumed = new OpenCodeAgentAdapter(profile, { requestTimeoutMs: 30_000, serverFactory });
  ownedAdapters.push(resumed);
  const restored = await resumed.start({ cwd: workbench.config.project.root, resumeThreadId: start.nativeSessionId, researchMcp });
  assert.equal(restored.nativeSessionId, start.nativeSessionId);
  assert.equal((await resumed.prompt({ turnId: "resumed-turn", content: [{ type: "text", text: "Confirm again." }] })).stopReason, "end_turn");
});
