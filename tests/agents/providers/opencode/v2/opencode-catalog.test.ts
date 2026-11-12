import test from "node:test";
import assert from "node:assert/strict";
import { createOpenCodeV2Fixture } from "../../../../../fixtures/native/opencode/v2/server.js";
import { readOpenCodeV2Catalog, openCodeV2ModelRef } from "../../../../../src/adapters/agents/opencode/v2/opencode-catalog.js";

test("V2 catalog filters nonchat and disabled models, preserves slashes and omits secrets", async t => {
  const f = await createOpenCodeV2Fixture(); t.after(() => f.close());
  const catalog = await readOpenCodeV2Catalog(f.client, process.cwd());
  assert.deepEqual(catalog.models, [{ id: "fixture/model/with-slash", label: "Fixture model · Fixture provider", reasoningEfforts: ["low", "high"] }]);
  assert.equal(catalog.model, "fixture/model/with-slash");
  assert.ok(!JSON.stringify(catalog).includes("secret"));
  assert.deepEqual(openCodeV2ModelRef(catalog, "model/with-slash", "high"), { id: "model/with-slash", providerID: "fixture", variant: "high" });
  assert.ok(f.calls.filter(call => call.path !== "/api/info").every(call => call.query["location[directory]"] === process.cwd()));
});
