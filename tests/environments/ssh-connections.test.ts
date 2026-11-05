import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import ssh2 from "ssh2";
import { SshConnectionService } from "../../src/ssh/ssh-connection-service.js";
import {
  fingerprint,
  quotePosix,
  resolveSshAlias,
} from "../../src/ssh/ssh-config.js";

async function poll(read, predicate) {
  for (let i = 0; i < 300; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(10);
  }
  throw new Error("SSH fixture did not reach the expected state");
}
async function fixture(
  t,
  {
    authentication = (ctx) => ctx.accept(),
    vault = { available: false },
    hostKey = ssh2.utils.generateKeyPairSync("ecdsa", { bits: 256 }).private,
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-ssh-test-"));
  const clients = new Set(),
    commands = [];
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", authentication);
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          commands.push(info.command);
          stream.on("error", () => {});
          if (info.command.includes("TOPOLUMIA_SSH_INFO")) {
            stream.write(
              "TOPOLUMIA_SSH_INFO\nLinux\nscientist\n/home/scientist\n/usr/bin/python3\n",
            );
            stream.exit(0);
            stream.end();
          } else if (info.command.includes("stay-open"))
            stream.on("data", () => {});
          else {
            stream.write("fixed diagnostic result");
            stream.exit(0);
            stream.end();
          }
        });
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const service = new SshConnectionService({
    root,
    vault,
    commandRunner: async () => ({ ok: false, stdout: "", stderr: "" }),
  });
  const profile = await service.save("owner", {
    name: "Lab",
    mode: "manual",
    host: "127.0.0.1",
    port: server.address().port,
    user: "scientist",
    auth: "password",
  });
  const read = async () => (await service.list("owner")).connections[0];
  const wait = (predicate) => poll(read, predicate);
  const trust = async () => {
    const p = await wait((p) => p.challenge?.kind === "host-key");
    await service.respond("owner", profile.id, {
      challengeId: p.challenge.id,
      trust: true,
    });
  };
  t.after(async () => {
    await service.close();
    for (const client of clients) client.end();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, service, profile, read, wait, trust, commands, server };
}

test("SSH verifies unknown keys, persists account trust, skips trusted reconnects and isolates users", async (t) => {
  const f = await fixture(t);
  await f.service.connect("owner", f.profile.id);
  const pending = await f.wait((p) => p.challenge?.kind === "host-key");
  assert.match(pending.challenge.fingerprint, /^SHA256:/);
  assert.equal(pending.challenge.changed, false);
  await assert.rejects(
    () =>
      f.service.respond("other", f.profile.id, {
        challengeId: pending.challenge.id,
        trust: true,
      }),
    { code: "SSH_CONNECTION_NOT_FOUND" },
  );
  await assert.rejects(
    () =>
      f.service.respond("owner", f.profile.id, {
        challengeId: "old",
        trust: true,
      }),
    { code: "SSH_CHALLENGE_EXPIRED" },
  );
  await f.trust();
  const connected = await f.wait(
    (p) => p.status === "connected" && p.info?.home,
  );
  assert.equal(connected.info.platform, "Linux");
  assert.equal((await f.service.list("other")).connections.length, 0);
  await f.service.disconnect("owner", f.profile.id);
  assert.equal(f.service.sessions.get(f.service.sessionKey("owner", f.profile.id)).client, null);
  await f.service.connect("owner", f.profile.id);
  await f.wait((p) => p.status === "connected");
  assert.equal((await f.read()).challenge, null);
});

test("SSH changed keys require verification and cannot be silently accepted", async (t) => {
  const f = await fixture(t);
  const profile = await f.service.profile("owner", f.profile.id);
  profile.trust = {
    target: `127.0.0.1:${profile.port}`,
    fingerprint: "SHA256:previous-key",
  };
  await f.service.persist("owner");
  await f.service.connect("owner", profile.id);
  const p = await f.wait((p) => p.challenge?.kind === "host-key");
  assert.equal(p.challenge.changed, true);
  assert.deepEqual(p.challenge.previousFingerprints, ["SHA256:previous-key"]);
  await assert.rejects(
    () =>
      f.service.respond("owner", profile.id, {
        challengeId: p.challenge.id,
        trust: true,
      }),
    { code: "SSH_HOST_CONFIRMATION_REQUIRED" },
  );
  await f.service.respond("owner", profile.id, {
    challengeId: p.challenge.id,
    trust: true,
    verified: true,
  });
  await f.wait((p) => p.status === "connected");
});

test("SSH password stays out of public profiles and is remembered only on explicit choice", async (t) => {
  const password = "fixture-session-password";
  const vault = {
    available: true,
    protect: async (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64"),
    reveal: async (value) =>
      JSON.parse(Buffer.from(value, "base64").toString()),
  };
  const f = await fixture(t, {
    vault,
    authentication: (ctx) =>
      ctx.method === "password" && ctx.password === password
        ? ctx.accept()
        : ctx.reject(["password"]),
  });
  await f.service.connect("owner", f.profile.id);
  await f.trust();
  let p = await f.wait((p) => p.challenge?.kind === "password");
  await f.service.respond("owner", p.id, {
    challengeId: p.challenge.id,
    values: [password],
  });
  await f.wait((p) => p.status === "connected");
  assert.equal((await f.read()).remembered, false);
  const user = await f.service.user("owner");
  assert.equal((await readFile(user.file, "utf8")).includes(password), false);
  assert.equal(JSON.stringify(await f.read()).includes(password), false);
  await f.service.disconnect("owner", p.id);
  await f.service.connect("owner", p.id);
  p = await f.wait((p) => p.challenge?.kind === "password");
  await f.service.respond("owner", p.id, {
    challengeId: p.challenge.id,
    values: [password],
    remember: true,
  });
  await f.wait((p) => p.status === "connected" && p.remembered);
  assert.equal(JSON.stringify(await f.read()).includes("ciphertext"), false);
  await f.service.disconnect("owner", p.id);
  await f.service.connect("owner", p.id);
  await f.wait((p) => p.status === "connected");
  await f.service.forget("owner", p.id);
  assert.equal((await f.read()).remembered, false);
});

test("SSH encrypted private keys request their passphrase without exposing key content", async (t) => {
  let agentRequests = 0;
  class UnusedAgent extends ssh2.BaseAgent {
    getIdentities(callback) {
      agentRequests++;
      callback(new Error("The explicitly selected key must not use an SSH agent"));
    }
  }
  const pair = ssh2.utils.generateKeyPairSync("ecdsa", {
    bits: 256,
    passphrase: "fixture-key-passphrase",
    cipher: "aes256-cbc",
  });
  const f = await fixture(t, {
    authentication: (ctx) =>
      ctx.method === "publickey" ? ctx.accept() : ctx.reject(["publickey"]),
  });
  const resolveTarget = f.service.target.bind(f.service);
  f.service.target = async (profile) => ({ ...await resolveTarget(profile), agent: new UnusedAgent() });
  const keyPath = path.join(f.root, "generated-key");
  await writeFile(keyPath, pair.private, { mode: 0o600 });
  const p = await f.service.save(
    "owner",
    {
      name: "Encrypted key",
      mode: "manual",
      host: "127.0.0.1",
      port: f.profile.port,
      user: "scientist",
      auth: "key",
      keyPath,
    },
    f.profile.id,
  );
  await f.service.connect("owner", p.id);
  await f.trust();
  const pending = await f.wait((p) => p.challenge?.kind === "passphrase");
  await f.service.respond("owner", p.id, {
    challengeId: pending.challenge.id,
    values: ["fixture-key-passphrase"],
  });
  await f.wait((p) => p.status === "connected");
  assert.equal(agentRequests, 0);
  assert.equal(JSON.stringify(await f.read()).includes(pair.private), false);
});

test("SSH keyboard-interactive handles multiple prompts and never saves MFA responses", async (t) => {
  const f = await fixture(t, {
    authentication: (ctx) => {
      if (ctx.method !== "keyboard-interactive")
        return ctx.reject(["keyboard-interactive"]);
      ctx.prompt(
        [
          { prompt: "Password:", echo: false },
          { prompt: "Verification code:", echo: false },
        ],
        (answers) =>
          answers[0] === "pass" && answers[1] === "123456"
            ? ctx.accept()
            : ctx.reject(["keyboard-interactive"]),
      );
    },
  });
  await f.service.connect("owner", f.profile.id);
  await f.trust();
  const p = await f.wait((p) => p.challenge?.kind === "keyboard");
  assert.equal(p.challenge.prompts.length, 2);
  assert.equal(p.challenge.canRemember, false);
  await f.service.respond("owner", p.id, {
    challengeId: p.challenge.id,
    values: ["pass", "123456"],
  });
  await f.wait((p) => p.status === "connected");
  assert.equal((await f.read()).remembered, false);
});

test("SSH cancellation clears challenges; diagnostics quote argv and bound output/time", async (t) => {
  const f = await fixture(t);
  await f.service.connect("owner", f.profile.id);
  await f.wait((p) => Boolean(p.challenge));
  await f.service.disconnect("owner", f.profile.id);
  assert.equal((await f.read()).challenge, null);
  await f.service.connect("owner", f.profile.id);
  await f.trust();
  await f.wait((p) => p.status === "connected");
  const result = await f.service.run(
    "owner",
    f.profile.id,
    "/usr/bin/python3",
    ["space and ' quote; $(no-command)"],
    { env: { SECRET_TOKEN: "never-forward", PYTHONDONTWRITEBYTECODE: "1" } },
  );
  assert.equal(result.ok, true);
  assert.equal(f.commands.at(-1).includes("never-forward"), false);
  assert.match(f.commands.at(-1), /PYTHONDONTWRITEBYTECODE/);
  const timeout = await f.service.run("owner", f.profile.id, "stay-open", [], {
    timeoutMs: 50,
  });
  assert.equal(timeout.timedOut, true);
  const bounded = await f.service.run("owner", f.profile.id, "fixed", [], {
    maxOutputBytes: 3,
  });
  assert.equal(bounded.outputLimitExceeded, true);
});

test("SSH alias parsing uses argv and returns sanitized resolution", async () => {
  let argv;
  const value = await resolveSshAlias("wsl", {}, async (command, args) => {
    argv = args;
    return {
      ok: true,
      stdout:
        "hostname 127.0.0.1\nuser scientist\nport 2222\nidentityfile ~/.ssh/id_ed25519\nproxyjump none\n",
    };
  });
  assert.deepEqual(argv, ["-G", "wsl"]);
  assert.equal(value.port, 2222);
  assert.equal(value.user, "scientist");
  await assert.rejects(() => resolveSshAlias("--unsafe"), {
    code: "SSH_ALIAS_INVALID",
  });
  assert.equal(quotePosix("a'b"), `'a'"'"'b'`);
  assert.match(fingerprint(Buffer.from("host")), /^SHA256:/);
});

test("SSH respects revoked system host keys and refuses them without a trust prompt", async (t) => {
  const pair = ssh2.utils.generateKeyPairSync("ecdsa", { bits: 256 });
  const f = await fixture(t, { hostKey: pair.private });
  f.service.commandRunner = async () => ({
    ok: true,
    stdout: `@revoked [127.0.0.1]:${f.profile.port} ${pair.public}\n`,
    stderr: "",
  });
  await f.service.connect("owner", f.profile.id);
  const failed = await f.wait((p) => p.status === "error");
  assert.match(failed.error, /撤销/);
  assert.equal(failed.challenge, null);
});
