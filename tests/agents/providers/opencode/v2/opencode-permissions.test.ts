import test from "node:test";
import assert from "node:assert/strict";
import { createOpenCodeV2Fixture } from "../../../../../fixtures/native/opencode/v2/server.js";
import { OpenCodeV2Permissions, openCodeV2Permissions } from "../../../../../src/adapters/agents/opencode/v2/opencode-permissions.js";

test("V2 always is a persistent project grant and reject clears all pending native requests", async t => {
  const f = await createOpenCodeV2Fixture(); t.after(() => f.close());
  const session = await f.client.session.create({ location: { directory: process.cwd() } });
  const events = [], permissions = new OpenCodeV2Permissions(f.client, session.id, event => events.push(event));
  const first = f.ask(session.id); permissions.asked(first, "turn");
  const approval = events.at(-1);
  assert.equal(approval.payload.options.find(option => option.optionId === "always").scope, "persistent");
  await permissions.reply(approval.payload.requestId, "always");
  assert.equal(f.calls.find(call => call.path.endsWith("/reply")).body.decision, "always");
  assert.equal(events.at(-1).payload.selectedScope, "persistent");
  permissions.asked(f.ask(session.id), "turn"); permissions.asked(f.ask(session.id), "turn");
  const requests = events.filter(event => event.type === "approval.requested").slice(1);
  await permissions.reply(requests[0].payload.requestId, "reject");
  assert.equal(events.filter(event => event.type === "approval.resolved").length, 3);
  await assert.rejects(permissions.reply(requests[1].payload.requestId, "once"), { code: "AGENT_APPROVAL_NOT_FOUND" });
});

test("V2 session permission rules preserve custom denies and explicitly scope required MCP", () => {
  const profile = { id: "v2", label: "OpenCode 2", provider: "opencode", command: "opencode", nativeConfig: { permissions: [{ action: "shell", resource: "git push *", effect: "deny" as const }] } };
  const rules = openCodeV2Permissions(profile, "topolumia");
  assert.deepEqual(rules[0], profile.nativeConfig.permissions[0]);
  assert.ok(rules.some(rule => rule.action === "topolumia_*" && rule.effect === "allow"));
  const defaults = openCodeV2Permissions({ ...profile, nativeConfig: undefined });
  assert.ok(defaults.some(rule => rule.action === "external_directory" && rule.effect === "ask"));
});
