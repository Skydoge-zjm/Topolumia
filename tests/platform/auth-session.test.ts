import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../src/server.js";

const tokenFromCookie = (value: string) => value.match(/^rw_session=([^;]+)/)?.[1] ?? "";
const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");

test("human sessions slide when active near expiry, stay unchanged while fresh, and reject expired cookies", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-auth-session-"));
  const ttlMs = 60 * 60 * 1_000;
  const app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: path.join(root, "accounts.sqlite"),
    config: {
      collaboration: { allowDevIdentity: false, sessionTtlMs: ttlMs },
      project: { workspacesRoot: path.join(root, "workspaces") },
      sourceRefresh: { enabled: false },
    },
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await fetch(`${app.url}/api/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "session-owner", password: "Sliding-Session-2026!" }),
  });
  assert.equal(bootstrap.status, 201);
  const cookie = bootstrap.headers.get("set-cookie")!;
  const token = tokenFromCookie(cookie);
  const hash = tokenHash(token);
  const updateExpiry = (value: number) => app.collaboration.db.prepare("UPDATE auth_sessions SET expires_at=? WHERE token_hash=?").run(new Date(value).toISOString(), hash);
  const request = () => fetch(`${app.url}/api/auth/me`, { headers: { cookie } });

  updateExpiry(Date.now() + 30 * 60_000);
  const refreshed = await request();
  assert.equal(refreshed.status, 200);
  assert.match(refreshed.headers.get("set-cookie") ?? "", /Max-Age=3600/);
  assert.ok(Date.parse(String(app.collaboration.db.prepare("SELECT expires_at FROM auth_sessions WHERE token_hash=?").get(hash).expires_at)) > Date.now() + 59 * 60_000);

  updateExpiry(Date.now() + 2 * 60 * 60_000);
  const fresh = await request();
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get("set-cookie"), null);

  updateExpiry(Date.now() - 1_000);
  const expired = await request();
  assert.equal(expired.status, 401);
  assert.equal(expired.headers.get("set-cookie"), null);
});
