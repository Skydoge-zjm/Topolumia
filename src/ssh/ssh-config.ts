import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runCommand, type CommandRunner } from "../lib/command.js";
import { AppError } from "../lib/errors.js";

export const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
export type SshTarget = { host: string; user: string; port: number; hostKeyAlias?: string | null; knownHostsFiles?: string[] };
export const fingerprint = (key: string | Buffer) =>
  `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
export const quotePosix = (value: unknown) =>
  `'${String(value).replace(/'/g, `'"'"'`)}'`;
export function expandLocalPath(value: string, target: Partial<SshTarget> = {}) {
  return String(value)
    .replace(/^~(?=[/\\]|$)/, os.homedir())
    .replace(/%d/g, os.homedir())
    .replace(/%u/g, os.userInfo().username)
    .replace(/%h/g, target.host ?? "")
    .replace(/%r/g, target.user ?? "")
    .replace(/%p/g, String(target.port ?? 22));
}
export async function sshAliases() {
  let content;
  try {
    content = await readFile(path.join(os.homedir(), ".ssh", "config"), "utf8");
  } catch {
    return [];
  }
  return [
    ...new Set(
      [...content.matchAll(/^\s*Host\s+([^\r\n#]+)/gim)]
        .flatMap((match) => match[1].trim().split(/\s+/))
        .filter((alias) => aliasPattern.test(alias)),
    ),
  ].sort();
}
export async function resolveSshAlias(
  alias: string,
  overrides: { port?: number; user?: string } = {},
  commandRunner: CommandRunner = runCommand,
) {
  if (!aliasPattern.test(alias))
    throw new AppError("SSH_ALIAS_INVALID", "SSH 别名格式无效。", {
      status: 422,
    });
  const args = [
    "-G",
    ...(overrides.port ? ["-p", String(overrides.port)] : []),
    ...(overrides.user ? ["-l", overrides.user] : []),
    alias,
  ];
  const result = await commandRunner("ssh", args, {
    timeoutMs: 5000,
    maxOutputBytes: 262144,
  });
  if (!result.ok)
    throw new AppError(
      "SSH_CONFIG_UNAVAILABLE",
      "无法读取本机 SSH 配置，请检查 OpenSSH 客户端和别名。",
      { status: 422 },
    );
  const values = new Map<string, string[]>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (!values.has(key)) values.set(key, []);
    values.get(key)!.push(match[2].trim());
  }
  const target = {
    host: values.get("hostname")?.[0] ?? alias,
    user: values.get("user")?.[0] ?? os.userInfo().username,
    port: Number(values.get("port")?.[0] ?? 22),
  };
  return {
    ...target,
    alias,
    auth: "system",
    identityFiles: (values.get("identityfile") ?? [])
      .slice(0, 12)
      .filter((file) => file !== "none")
      .map((file) => expandLocalPath(file, target)),
    agent:
      values.get("identityagent")?.[0] === "none"
        ? null
        : values.get("identityagent")?.[0] &&
            values.get("identityagent")![0] !== "SSH_AUTH_SOCK"
          ? expandLocalPath(values.get("identityagent")![0], target)
          : (process.env.SSH_AUTH_SOCK ??
            (process.platform === "win32"
              ? "\\\\.\\pipe\\openssh-ssh-agent"
              : null)),
    knownHostsFiles: (
      values.get("userknownhostsfile") ?? [
        path.join(os.homedir(), ".ssh", "known_hosts"),
      ]
    )
      .flatMap((value) => value.match(/"[^"]+"|\S+/g) ?? [])
      .map((file) => expandLocalPath(file.replace(/^"|"$/g, ""), target)),
    hostKeyAlias: values.get("hostkeyalias")?.[0] ?? null,
    proxyJump:
      values.get("proxyjump")?.[0] && values.get("proxyjump")![0] !== "none"
        ? values.get("proxyjump")![0]
        : null,
    proxyCommand:
      values.get("proxycommand")?.[0] &&
      values.get("proxycommand")![0] !== "none"
        ? values.get("proxycommand")![0]
        : null,
  };
}
export async function knownHostKeys(target: SshTarget, commandRunner: CommandRunner = runCommand) {
  const name =
    target.hostKeyAlias && target.hostKeyAlias !== "none"
      ? target.hostKeyAlias
      : target.port === 22
        ? target.host
        : `[${target.host}]:${target.port}`;
  const records = [];
  for (const file of target.knownHostsFiles ?? [
    path.join(os.homedir(), ".ssh", "known_hosts"),
  ]) {
    const result = await commandRunner("ssh-keygen", ["-F", name, "-f", file], {
      timeoutMs: 3000,
      maxOutputBytes: 65536,
    });
    if (!result.ok) continue;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith("#")) continue;
      const parts = line.trim().split(/\s+/);
      const revoked = parts[0] === "@revoked";
      if (parts[0]?.startsWith("@")) {
        if (!revoked) continue;
        parts.shift();
      }
      if (parts.length < 3 || !/^(ssh-|ecdsa-)/.test(parts[1])) continue;
      const key = Buffer.from(parts[2], "base64");
      if (key.length)
        records.push({
          algorithm: parts[1],
          fingerprint: fingerprint(key),
          revoked,
        });
    }
  }
  return records;
}
