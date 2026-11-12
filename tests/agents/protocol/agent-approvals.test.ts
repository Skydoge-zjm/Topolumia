import test from "node:test";
import assert from "node:assert/strict";
import { ClaudePermissionHost } from "../../../src/adapters/agents/claude/claude-permission-host.js";
import { codexApproval } from "../../../src/adapters/agents/codex/codex-approvals.js";

function claude() {
  const sent = [], events = [], remembered = [];
  const process = { send: message => sent.push(message) };
  const host = new ClaudePermissionHost(process, (type, payload) => events.push({ type, payload }), updates => remembered.push(...updates));
  const request = (extra = {}) => ({ type: "control_request", request_id: "native-1", request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "tool-1",
    input: { command: "python experiment.py" }, permission_suggestions: ["session", "projectSettings"].map(destination => ({ type: "addRules", destination, behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "python experiment.py" }] })), ...extra } });
  return { host, process, sent, events, remembered, request };
}

test("Claude native controls initialize without a model request and reject unsupported forms", async () => {
  const f = claude();
  const result = f.host.initialize(1000), id = f.sent[0].request_id;
  assert.deepEqual(f.sent[0].request.supportedDialogKinds, []);
  f.host.consume({ type: "control_response", response: { subtype: "success", request_id: id, response: { commands: [] } } });
  assert.deepEqual(await result, { commands: [] });
  f.host.consume({ type: "control_request", request_id: "unknown", request: { subtype: "elicitation" } });
  assert.equal(f.sent.at(-1).response.subtype, "error");
  assert.equal(f.events.at(-1).type, "agent.question.unsupported");
  f.host.close();
});

for (const option of ["allow_once", "allow_session", "allow_rules", "reject_once", "cancel"]) test(`Claude ${option} sends exact native permissions and original tool input`, () => {
  const f = claude(), request = f.request();
  f.host.consume(request); f.host.consume(request);
  assert.equal(f.events.length, 1);
  const a = f.events[0].payload;
  assert.equal(a.command, "python experiment.py");
  assert.deepEqual(a.options.map(o => o.scope), ["once", "session", "persistent", "once", "turn"]);
  f.host.resolve(a.requestId, option);
  const response = f.sent[0].response;
  assert.equal(response.request_id, "native-1");
  if (option.startsWith("allow")) {
    assert.deepEqual(response.response.updatedInput, request.request.input);
    assert.equal(response.response.behavior, "allow");
    assert.equal(response.response.updatedPermissions?.[0]?.destination, option === "allow_session" ? "session" : option === "allow_rules" ? "projectSettings" : undefined);
  } else {
    assert.equal(response.response.behavior, "deny");
    assert.equal(response.response.interrupt, option === "cancel");
  }
  assert.equal(f.remembered.length, option === "allow_session" ? 1 : 0);
  f.host.consume(request); // native retransmission gets the cached answer only
  assert.equal(f.sent.length, 2); assert.equal(f.events.length, 1);
  f.host.close();
});

test("Claude restrictions never turn bypass mode or an interactive form into blanket approval", () => {
  for (const extra of [{ suppress_always_allow_rule: true }, { requires_user_interaction: true },
    { permission_suggestions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }] }]) {
    const f = claude(); f.host.consume(f.request(extra));
    const a = f.events[0].payload;
    assert.ok(!a.options.some(o => ["allow_session", "allow_always"].includes(o.kind)));
    assert.throws(() => f.host.resolve(a.requestId, "allow_session"), { code: "AGENT_APPROVAL_OPTION_INVALID" });
    if (extra.requires_user_interaction) {
      assert.ok(!a.options.some(o => o.kind.startsWith("allow")));
      assert.throws(() => f.host.resolve(a.requestId, "allow_once"), { code: "AGENT_APPROVAL_OPTION_INVALID" });
    }
    f.host.close();
  }
});

test("Claude failed sends remain retryable; native withdrawal makes the local ID unusable", () => {
  const f = claude(); f.host.consume(f.request()); const id = f.events[0].payload.requestId;
  const send = f.process.send; f.process.send = () => { throw new Error("closed transport"); };
  assert.throws(() => f.host.resolve(id, "allow_once"), /closed transport/);
  f.process.send = send;
  f.host.consume({ type: "control_cancel_request", request_id: "native-1" });
  assert.equal(f.events.at(-1).payload.decision, "expired");
  assert.throws(() => f.host.resolve(id, "allow_once"), { code: "AGENT_APPROVAL_NOT_FOUND" });
  f.host.consume(f.request()); assert.notEqual(f.events.at(-1).payload.requestId, id);
  f.host.close();
});

test("Claude's native acceptEdits suggestion is an explicit session mode, never a permanent matching rule", () => {
  const f = claude();
  f.host.consume(f.request({ permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] }));
  const a = f.events[0].payload, option = a.options.find(o => o.optionId === "allow_session_edits");
  assert.equal(option.mode, "acceptEdits"); assert.equal(option.scope, "session"); assert.match(option.label, /自动允许编辑/);
  assert.ok(!a.options.some(o => o.scope === "persistent"));
  f.host.resolve(a.requestId, option.optionId);
  assert.deepEqual(f.sent[0].response.response.updatedPermissions, [{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
  assert.deepEqual(f.remembered, [{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
});

test("Codex keeps native restricted decisions and exact persisted amendments", () => {
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["python", "experiment.py"] } };
  const a = codexApproval({ id: 1, method: "item/commandExecution/requestApproval", params: { command: "python experiment.py", cwd: "E:/Research", availableDecisions: ["decline", amendment] } });
  assert.deepEqual(a.payload.options.map(o => o.kind), ["reject_once", "allow_always"]);
  assert.ok(!a.results.has("allow_once"));
  assert.deepEqual(a.results.get(a.payload.options[1].optionId), { decision: amendment });
  assert.equal(a.payload.options[1].scope, "persistent");
  assert.notEqual(codexApproval({ id: 1 }).payload.requestId, a.payload.requestId);
});

test("Codex presents files, diffs, network context and turn-scoped permission profiles", () => {
  const file = codexApproval({ method: "item/fileChange/requestApproval", params: { grantRoot: "E:/Research" } }, { changes: [{ path: "result.py", kind: { type: "update" }, diff: "+validated" }] });
  assert.deepEqual(file.payload.fileChanges, [{ path: "result.py", kind: "update", diff: "+validated" }]);
  const network = codexApproval({ params: { networkApprovalContext: { host: "papers.example", protocol: "https", port: 443 } } });
  assert.equal(network.payload.category, "network"); assert.equal(network.payload.network.host, "papers.example");
  const permissions = { fileSystem: { write: ["E:/Research"] }, network: { enabled: true } };
  const a = codexApproval({ method: "item/permissions/requestApproval", params: { permissions } });
  assert.deepEqual(a.results.get("allow_once"), { permissions, scope: "turn" });
  assert.deepEqual(a.results.get("reject_once"), { permissions: {}, scope: "turn" });
});
