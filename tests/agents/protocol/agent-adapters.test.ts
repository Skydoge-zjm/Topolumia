import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAgentAdapter } from "../../../src/adapters/agents/codex/codex-agent-adapter.js";
import { ClaudeCodeAgentAdapter } from "../../../src/adapters/agents/claude/claude-code-agent-adapter.js";
import { AgentProfileRegistry } from "../../../src/services/agents/agent-profile-registry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const codexFixture = path.join(root, "fixtures", "native", "codex-app-server.js");
const claudeFixture = path.join(root, "fixtures", "native", "claude-cli.js");

test("AgentProfileRegistry selects separate product adapters by profile driver", async () => {
  const registry = new AgentProfileRegistry({
    agentSessions: {
      requestTimeoutMs: 2_000,
      managedWrappersRoot: path.join(root, "managed-wrappers"),
      profiles: [
        { id: "codex", label: "Codex", provider: "codex", driver: "codex-app-server", command: process.execPath, args: [codexFixture] },
        { id: "claude", label: "Claude Code", provider: "claude", driver: "claude-cli-stream", command: process.execPath, launcherArgs: [claudeFixture] },
      ],
    },
  });
  const codex = await registry.createAdapter("codex", { onEvent: () => {} });
  const claude = await registry.createAdapter("claude", { onEvent: () => {} });
  assert.ok(codex instanceof CodexAgentAdapter);
  assert.ok(claude instanceof ClaudeCodeAgentAdapter);
});

test("profile descriptors include a configured custom default model in session choices", async () => {
  const registry = new AgentProfileRegistry({ agentSessions: { profiles: [{ id: "custom-codex", label: "Codex", provider: "codex", command: process.execPath,
    model: "fixture-project-model", models: [{ id: "gpt-6-luna", label: "6 Luna" }] }] } });
  const [profile] = await registry.descriptors();
  assert.equal(profile.model, "fixture-project-model");
  assert.ok(profile.models.some(model => model.id === "fixture-project-model"));
});

test("CodexAgentAdapter wraps the Codex driver and preserves normalized events", async () => {
  const events = [];
  const adapter = new CodexAgentAdapter({
    id: "fixture-codex",
    label: "Fixture Codex",
    provider: "codex",
    command: process.execPath,
    args: [codexFixture],
    model: "gpt-5.6-luna",
  }, { requestTimeoutMs: 2_000, onEvent: (event) => events.push(event) });
  const started = await adapter.start({ cwd: root });
  assert.equal(started.nativeSessionId, "fixture-codex-thread");
  const result = await adapter.prompt({ turnId: "turn-adapter-codex", content: [{ type: "text", text: "检查当前实验" }] });
  assert.equal(result.stopReason, "end_turn");
  assert.ok(events.some((event) => event.type === "assistant.message.delta"));
  await adapter.close();
});

test("ClaudeCodeAgentAdapter wraps Claude Code and supports a resumed native id", async () => {
  const events = [];
  const nativeSessionId = "fixture-claude-resumed";
  const adapter = new ClaudeCodeAgentAdapter({
    id: "fixture-claude",
    label: "Fixture Claude",
    provider: "claude",
    command: process.execPath,
    launcherArgs: [claudeFixture],
    allowedTools: ["Read"],
  }, { requestTimeoutMs: 2_000, onEvent: (event) => events.push(event) });
  const started = await adapter.start({ cwd: root, resumeThreadId: nativeSessionId });
  assert.equal(started.nativeSessionId, nativeSessionId);
  const result = await adapter.prompt({ turnId: "turn-adapter-claude", content: [{ type: "text", text: "继续检查" }] });
  assert.equal(result.stopReason, "end_turn");
  assert.ok(events.some((event) => event.type === "assistant.message.delta"));
  await adapter.close();
});
