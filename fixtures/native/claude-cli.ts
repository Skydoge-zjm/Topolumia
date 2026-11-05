import process from "node:process";
import readline from "node:readline";
import { readFileSync } from "node:fs";
import { openResearchMcp } from "../../src/mcp/research-probe.js";

const args = process.argv.slice(2);
const indexOf = (name) => args.indexOf(name);
const researchBinding = indexOf("--mcp-config") < 0 ? null : JSON.parse(args[indexOf("--mcp-config") + 1]).mcpServers.topolumia;
const argument = name => indexOf(name) < 0 ? undefined : args[indexOf(name) + 1];
const sessionId = argument("--session-id") ?? argument("--resume") ?? "fixture-claude-session";
const omitMessageId = process.env.CLAUDE_FIXTURE_OMIT_MESSAGE_ID === "1";
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const pending = new Set<string>();
const responses: unknown[] = [];
const reader = readline.createInterface({ input: process.stdin });
reader.on("line", line => {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { claude_code_version: "fixture-0.1.0" } } });
    if (frame.request.subtype === "interrupt") send({ type: "result", subtype: "success", stop_reason: "end_turn" });
  } else if (frame.type === "control_response") {
    if (!pending.delete(frame.response.request_id)) return;
    responses.push(frame.response.response);
    if (!pending.size) {
      send({ type: "assistant", message: { id: "permission-answer", content: [{ type: "text", text: JSON.stringify(responses) }] } });
      send({ type: "result", subtype: "success", stop_reason: "end_turn" });
    }
  } else if (frame.type === "user") void run(frame.message.content.map(part => part.text ?? "").join("\n"));
});
async function run(input: string) {
  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, claude_code_version: "fixture-0.1.0", capabilities: ["stream-json"] })}\n`);
  if (input.includes("scientific-note")) {
    if (researchBinding) {
      const connection = await openResearchMcp(researchBinding);
      try { await connection.client.callTool({ name: "get_context", arguments: {} }); await connection.client.callTool({ name: "read_source", arguments: { ref: "file:README.md" } }); }
      finally { await connection.close(); }
    }
    send({ type: "assistant", message: { id: "scientific-note", content: [{ type: "text", text: "# 实验结果记录\n\n[实验协议](file:README.md)\n\n误差定义为 $E = \\frac{1}{n}\\sum_i x_i^2$。\n\n```python\nprint('scientific-evidence')\n```\n\n结果需要进一步复核。" }] } });
    send({ type: "result", subtype: "success", stop_reason: "end_turn" }); return;
  }
  if (input.includes("approval-settings")) {
    const settingsArg = indexOf("--settings") < 0 ? null : args[indexOf("--settings") + 1];
    send({ type: "assistant", message: { id: "settings", content: [{ type: "text", text: JSON.stringify({ settings: settingsArg ? JSON.parse(settingsArg.startsWith("{") ? settingsArg : readFileSync(settingsArg, "utf8")) : null, settingsFile: settingsArg?.startsWith("{") ? null : settingsArg, settingsCount: args.filter(arg => arg === "--settings").length, permissionMode: args[indexOf("--permission-mode") + 1] }) }] } });
    send({ type: "result", subtype: "success", stop_reason: "end_turn" }); return;
  }
  if (input.includes("approval-check") || input.includes("approval-parallel") || input.includes("approval-withdraw") || input.includes("approval-edits")) {
    for (let index = 0; index < (input.includes("approval-parallel") ? 2 : 1); index++) {
      const id = `native-permission-${index}`; pending.add(id);
      send({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: input.includes("approval-edits") ? "Write" : "Bash", tool_use_id: `tool-${index}`,
        input: input.includes("approval-edits") ? { file_path: "result.txt", content: "Fixture" } : { command: "python experiment.py --dry-run" }, decision_reason: "Fixture operation requires permission",
        permission_suggestions: input.includes("approval-edits") ? [{ type: "setMode", mode: "acceptEdits", destination: "session" }] : ["session", "projectSettings"].map(destination => ({ type: "addRules", behavior: "allow", destination, rules: [{ toolName: "Bash", ruleContent: "python experiment.py --dry-run" }] })) } });
    }
    if (input.includes("approval-withdraw")) setTimeout(() => {
      send({ type: "control_cancel_request", request_id: "native-permission-0" }); pending.clear();
      send({ type: "result", subtype: "success", stop_reason: "end_turn" });
    }, 120);
    return;
  }
  if (process.env.CLAUDE_FIXTURE_CHECK_BINDING === "1") {
    const guidance = args[indexOf("--append-system-prompt") + 1] ?? "";
    process.stdout.write(`${JSON.stringify({ type: "assistant", message: { id: "binding", content: [{ type: "text", text: `MCP=${researchBinding ? "ready" : "missing"}; shellCredentials=${process.env.TOPOLUMIA_SESSION ? "present" : "absent"}; guidance=${guidance.includes("Topolumia") ? "ready" : "missing"}` }] } })}\n`);
  }
  if (input.includes("model-bind")) {
    const model = indexOf("--model") < 0 ? null : args[indexOf("--model") + 1];
    const effort = indexOf("--effort") < 0 ? null : args[indexOf("--effort") + 1];
    process.stdout.write(`${JSON.stringify({ type: "assistant", message: { id: "model-binding", content: [{ type: "text", text: JSON.stringify({ model, effort }) }] } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", stop_reason: "end_turn" })}\n`);
    return;
  }
  if (input.includes("mcp-bind")) {
    try {
      const connection = await openResearchMcp(researchBinding);
      let result;
      try { result = await connection.client.callTool({ name: "get_context", arguments: {} }); } finally { await connection.close(); }
      if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
      const context = result.structuredContent;
      process.stdout.write(`${JSON.stringify({ type: "assistant", message: { id: "mcp-binding", content: [{ type: "text", text: `MCP_PROJECT=${context.projectId}; INTERFACE=${context.schemaVersion}; CLI_PID=${result._meta.execution.pid}` }] } })}\n`);
      process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", stop_reason: "end_turn" })}\n`);
    } catch (error) { process.stdout.write(`${JSON.stringify({ type: "result", subtype: "error", is_error: true, result: error.message })}\n`); }
    return;
  }
  if (input.includes("dense-activity")) {
    let sequence = 0;
    const emit = message => process.stdout.write(`${JSON.stringify(message)}\n`);
    const assistant = (id, block) => emit({ type: "assistant", uuid: `dense-${++sequence}`, message: { id, content: [block] } });
    const think = id => assistant(id, { type: "thinking", thinking: `Reasoning ${id}` });
    const call = (id, name, output) => {
      assistant(id, { type: "tool_use", id: `call-${id}`, name: `mcp__topolumia__${name}`, input: { query: id } });
      emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `call-${id}`, content: output }] } });
    };
    think("one"); call("context", "get_context", "Final context output");
    think("two"); call("nodes", "read_nodes", "Final nodes output");
    call("search-a", "search", "Final first search"); think("three"); call("search-b", "search", "Final second search");
    assistant("answer", { type: "text", text: "Final audit answer." });
    emit({ type: "result", subtype: "success", stop_reason: "end_turn" });
    return;
  }
  if (input.includes("reasoning-blocks")) {
    const emit = message => process.stdout.write(`${JSON.stringify(message)}\n`);
    const stream = event => emit({ type: "stream_event", event });
    const thinking = (index, text, uuid, finalText = text) => {
      stream({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      stream({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text.slice(0, 6) } });
      stream({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text.slice(6) } });
      // SDK assistant snapshots are partial arrays: their local index is zero
      // even when the corresponding stream block index is nonzero.
      const packet = { type: "assistant", uuid, message: { id: "reason-a", content: [{ type: "thinking", thinking: finalText }] } };
      emit(packet); emit(packet);
      stream({ type: "content_block_stop", index });
    };
    stream({ type: "message_start", message: { id: "reason-a" } });
    thinking(0, "**Check source**", "thinking-0", "**Check source****Check version**");
    thinking(2, "**Repeated native phase**", "thinking-2");
    thinking(3, "**Repeated native phase**", "thinking-3");
    emit({ type: "assistant", uuid: "snapshot-only", message: { id: "reason-b", content: [{ type: "thinking", thinking: "**Snapshot-only phase**" }] } });
    emit({ type: "assistant", uuid: "answer", message: { id: "answer", content: [{ type: "text", text: "Reasoning boundaries verified." }] } });
    emit({ type: "result", subtype: "success", stop_reason: "end_turn" });
    return;
  }
  if (input.includes("long-stream")) {
    const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
    const stream = (event) => emit({ type: "stream_event", event });
    stream({ type: "message_start", message: { id: "preface" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "先检查研究材料。" } });
    emit({ type: "assistant", message: { id: "preface", content: [{ type: "text", text: "先检查研究材料。" }] } });
    stream({ type: "message_start", message: { id: "tools" } });
    for (const [index, id] of ["read-a", "read-b"].entries()) {
      stream({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: "Read", input: {} } });
    }
    for (let index = 0; index < 2; index += 1) {
      stream({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: `{"file_path":"${index}.md"}` } });
      stream({ type: "content_block_stop", index });
    }
    emit({ type: "assistant", message: { id: "tools", content: ["read-a", "read-b"].map((id, index) => ({ type: "tool_use", id, name: "Read", input: { file_path: `${index}.md` } })) } });
    emit({ type: "user", message: { content: ["read-a", "read-b"].map(id => ({ type: "tool_result", tool_use_id: id, content: "verified" })) } });
    stream({ type: "message_start", message: { id: "answer" } });
    const delta = "科研结果与证据均已核对。\n\n";
    for (let i = 0; i < 1_400; i += 1) stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } });
    emit({ type: "assistant", message: { id: "answer", content: [{ type: "text", text: delta.repeat(1_400) }] } });
    emit({ type: "result", subtype: "success", stop_reason: "end_turn" });
    return;
  }
  const streamEvent = { type: "stream_event", event: { type: "content_block_delta", ...(omitMessageId ? {} : { message_id: "fixture-message" }), delta: { type: "text_delta", text: "已检查当前实验。" } } };
  process.stdout.write(`${JSON.stringify(streamEvent)}\n`);
  if (omitMessageId) {
    process.stdout.write(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "tools needed" } } })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ type: "assistant", message: { id: "fixture-message", content: [{ type: "tool_use", id: "fixture-tool", name: "Read", input: { file_path: "README.md" } }] } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "fixture-tool", content: "ok" }] } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: sessionId, result: "已检查当前实验。", stop_reason: "end_turn", is_error: false, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 2 } })}\n`);
}

