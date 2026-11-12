import test from "node:test";
import assert from "node:assert/strict";
import { ResearchCommandService } from "../../src/services/research/research-command-service.js";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

test("research permissions require both an authenticated identity and its permission grant", async t => {
  const commands = new ResearchCommandService({ assetRoot: path.join(os.tmpdir(), "topolumia-access-" + randomUUID()) });
  t.after(async () => { await commands.records.close(); await commands.assets.close(); commands.store.db.close(); });
  const actor = { isAgent: false, user: { id: "researcher" }, permissions: ["research.view"] };
  assert.doesNotThrow(() => commands.check(actor, "research.view"));
  assert.throws(() => commands.check(actor, "research.applyChange"), { code: "FORBIDDEN" });
  assert.throws(() => commands.check({ isAgent: false, permissions: ["research.view"] }, "research.view"), { code: "AUTH_REQUIRED" });
  assert.throws(() => commands.check({ isAgent: false, isServerAdmin: true, user: actor.user }, "research.view"), { code: "AUTH_REQUIRED" });
});
