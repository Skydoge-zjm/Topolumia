import test from "node:test";
import assert from "node:assert/strict";
import { CodexExecClient } from "../../../../src/adapters/agents/codex/codex-exec-client.js";
import { resolveInvocation } from "../../../../src/lib/command.js";

async function execute(events: unknown[]) {
  const source = `
    process.stdin.resume();
    process.stdin.on("end", () => {
      for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + "\\n");
    });
  `;
  const invocation = await resolveInvocation(process.execPath, ["-e", source]);
  return new CodexExecClient(invocation, { timeoutMs: 5_000 }).run("Inspect the research evidence.");
}

test("Codex exec accepts null exit codes while commands start and update before completing", async () => {
  const command = { id: "command-1", type: "command_execution", command: "read evidence.json", aggregated_output: "", exit_code: null, status: "in_progress" };
  const result = await execute([
    { type: "thread.started", thread_id: "curator-thread" },
    { type: "item.started", item: command },
    { type: "item.updated", item: { ...command, aggregated_output: "Reading evidence…" } },
    { type: "item.completed", item: { ...command, aggregated_output: "Preserved research evidence", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "message-1", type: "agent_message", text: '{"disposition":"no_op"}' } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
  ]);
  assert.equal(result.threadId, "curator-thread");
  assert.deepEqual(result.agentMessages, ['{"disposition":"no_op"}']);
  assert.deepEqual(result.commandExecutions, [{ id: "command-1", command: "read evidence.json", output: "Preserved research evidence", exitCode: 0, status: "completed" }]);
});

test("Codex exec retains an unavailable completed exit code without treating it as success", async () => {
  const result = await execute([
    { type: "item.completed", item: { id: "command-1", type: "command_execution", command: "interrupted command", exit_code: null, status: "failed" } },
    { type: "turn.completed" },
  ]);
  assert.equal(result.commandExecutions[0].status, "failed");
  assert.equal(result.commandExecutions[0].exitCode, undefined);
});

test("Codex exec still rejects a command exit code outside the native contract", async () => {
  await assert.rejects(execute([
    { type: "item.completed", item: { type: "command_execution", exit_code: "zero" } },
  ]), { code: "CODEX_PROTOCOL_ERROR" });
});
