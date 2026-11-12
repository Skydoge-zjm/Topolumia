import os from "node:os";
import path from "node:path";
import { readFile, stat, mkdir, writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";
import { promisify } from "node:util";
import { connect as connectTcp } from "node:net";
import ssh2 from "ssh2";
import type { Client as SshClient, ClientChannel, SFTPWrapper, AuthenticationType, AnyAuthMethod, TcpConnectionDetails, ServerHostKeyAlgorithm } from "ssh2";
const { Client, utils } = ssh2;
import * as z from "zod/v4";
import { AppError } from "../lib/errors.js";
import { runCommand, type CommandRunner, type CommandResult, type CommandOptions } from "../lib/command.js";
import { bundledRoot } from "../config.js";
import {
  aliasPattern,
  expandLocalPath,
  fingerprint,
  knownHostKeys,
  quotePosix,
  resolveSshAlias,
  sshAliases,
} from "./ssh-config.js";
import { SshCredentialVault, type SessionCredentials } from "./credential-vault.js";

const text = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), "不能包含控制字符");
const profileSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    name: text,
    mode: z.literal("alias"),
    alias: z.string().regex(aliasPattern),
    timeoutSeconds: z.number().int().min(3).max(60).default(10),
    keepAlive: z.boolean().default(true),
  }),
  z.strictObject({
    name: text,
    mode: z.literal("manual"),
    host: text.regex(/^[A-Za-z0-9.:[\]_-]+$/),
    port: z.number().int().min(1).max(65535).default(22),
    user: text,
    auth: z.enum(["agent", "key", "password"]),
    keyPath: z.string().trim().max(500).default(""),
    timeoutSeconds: z.number().int().min(3).max(60).default(10),
    keepAlive: z.boolean().default(true),
  }),
]);
export type SshInfo = { status: string; platform: string; user: string; home: string | null; python: string | null; tools: Record<string, string | null> };
export type ReadySshInfo = SshInfo & {home:string;python:string};
export type SshProfile = z.infer<typeof profileSchema> & { id: string; revision: number; createdAt: string; updatedAt: string; ciphertext?: string; trust?: { target: string; fingerprint: string; hosts?: Record<string, string> }; lastInfo?: SshInfo };
type Target = Omit<Awaited<ReturnType<typeof resolveSshAlias>>, "auth"> & { auth: string };
type Challenge = { kind: string; host: string; port: number; user: string; prompts: { label: string; secret: boolean }[]; title?: string; instructions?: string; fingerprint?: string; previousFingerprints?: string[]; changed?: boolean; canRemember?: boolean };
export type SshAnswer = { challengeId?: string; trust?: boolean; verified?: boolean; values?: string[]; remember?: boolean };
export type SshSession = {
  profile: SshProfile; owner: string; status: string; stage: string | null; error: string | null;
  challenge: (Challenge & { id: string }) | null; clients: SshClient[]; channels: Set<ClientChannel | SFTPWrapper>;
  proxies: ChildProcess[]; cancelled: boolean; credentials: SessionCredentials; remember: boolean; info: SshInfo | null;
  client?: SshClient | null; effective?: Target; reply?: ((answer: SshAnswer) => void) | null; cancelChallenge?: (() => void) | null;
  connectedAt?: string; storageWarning?: string; hostKeyError?: string; infoTask?: Promise<unknown>; remoteInfoTask?: Promise<ReadySshInfo> | null; task?: Promise<void>;
};
type UserConnections = { file: string; profiles: Map<string, SshProfile>; persistence: Promise<void> };
type ConnectionOptions = { root: string; commandRunner?: CommandRunner; clientFactory?: () => SshClient; vault?: Pick<SshCredentialVault, "available" | "protect" | "reveal"> };
export type SshRunOptions = CommandOptions & { input?: string; onStdout?: (value: string) => void };
const errorProperties = (error: unknown): { code?: unknown; message?: string; level?: unknown } => error && typeof error === "object" ? error : {};
const shortError = (value: unknown) => {
  const error = errorProperties(value);
  return error?.code === "ECONNREFUSED"
    ? "SSH 连接被拒绝，请检查地址、端口和 SSH 服务。"
    : error?.code === "ENOTFOUND"
      ? "无法解析 SSH 主机地址。"
      : /timed?\s*out|timeout/i.test(error?.message ?? "")
        ? "SSH 连接超时，请检查网络和端口。"
        : /authenticat/i.test(error?.message ?? "") ||
            error?.level === "client-authentication"
          ? "SSH 认证失败，请检查登录用户、密钥或密码。"
          : "SSH 连接未完成，请检查配置后重试。";
};
const cleanPrompt = (value: unknown) =>
  Array.from(String(value ?? ""), char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char).join("")
    .slice(0, 1200);

export class SshConnectionService {
  root: string;
  commandRunner: CommandRunner;
  clientFactory: () => SshClient;
  vault: NonNullable<ConnectionOptions["vault"]>;
  users = new Map<string, Promise<UserConnections>>();
  sessions = new Map<string, SshSession>();
  tasks = new Set<Promise<void>>();
  listeners = new Set<(owner: string, id: string, kind: string) => void>();
  closed = false;
  constructor({
    root,
    commandRunner = runCommand,
    clientFactory = () => new Client(),
    vault = new SshCredentialVault(),
  }: ConnectionOptions) {
    this.root = root; this.commandRunner = commandRunner; this.clientFactory = clientFactory; this.vault = vault;
    this.users = new Map();
    this.sessions = new Map();
    this.tasks = new Set();
    this.listeners = new Set();
  }
  userKey(owner: string) {
    return createHash("sha256")
      .update(String(owner))
      .digest("hex")
      .slice(0, 32);
  }
  async user(owner: string): Promise<UserConnections> {
    if (!owner)
      throw new AppError("SSH_LOGIN_REQUIRED", "请先登录。", { status: 401 });
    if (!this.users.has(owner))
      this.users.set(
        owner,
        (async () => {
          const file = path.join(
            this.root,
            this.userKey(owner),
            "connections.json",
          );
          let profiles: SshProfile[] = [];
          try {
            const raw = await readFile(file, "utf8");
            if (raw.length < 1048576) profiles = JSON.parse(raw).profiles ?? [];
          } catch {
            /* First use. */
          }
          return {
            file,
            profiles: new Map(
              profiles
                .filter((p) => p && /^[a-f0-9-]{36}$/.test(p.id))
                .map((p) => [p.id, p]),
            ),
            persistence: Promise.resolve(),
          };
        })(),
      );
    return this.users.get(owner)!;
  }
  async persist(owner: string) {
    const user = await this.user(owner);
    const snapshot = JSON.stringify({
      schemaVersion: "ssh-profiles.v1",
      profiles: [...user.profiles.values()],
    });
    user.persistence = user.persistence
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(user.file), { recursive: true, mode: 0o700 });
        const temporary = `${user.file}.${randomUUID()}.tmp`;
        await writeFile(temporary, snapshot, { mode: 0o600 });
        await rename(temporary, user.file);
      });
    await user.persistence;
  }
  async profile(owner: string, id: string) {
    const profile = (await this.user(owner)).profiles.get(id);
    if (!profile)
      throw new AppError(
        "SSH_CONNECTION_NOT_FOUND",
        "没有找到此账号的 SSH 连接。",
        { status: 404 },
      );
    return profile;
  }
  sessionKey(owner: string, id: string) {
    return `${owner}:${id}`;
  }
  publicProfile(profile: SshProfile, session: SshSession | null | undefined = null) {
    const { ciphertext, trust, ...configuration } = profile;
    return {
      ...configuration,
      remembered: Boolean(ciphertext),
      trustedFingerprint: trust?.fingerprint ?? null,
      status: session?.status ?? "disconnected",
      stage: session?.stage ?? null,
      challenge: session?.challenge ?? null,
      error: session?.error ?? null,
      info: session?.info ?? profile.lastInfo ?? null,
      connectedAt: session?.connectedAt ?? null,
      storageWarning: session?.storageWarning ?? null,
      effective: session?.effective
        ? {
            host: session.effective.host,
            user: session.effective.user,
            port: session.effective.port,
            usesProxy: Boolean(
              session.effective.proxyJump || session.effective.proxyCommand,
            ),
          }
        : null,
    };
  }
  async list(owner: string) {
    const user = await this.user(owner);
    return {
      connections: [...user.profiles.values()].map((p) =>
        this.publicProfile(p, this.sessions.get(this.sessionKey(owner, p.id))),
      ),
      credentialStorage: {
        available: this.vault.available,
        kind: this.vault.available ? "windows-dpapi" : "session-only",
      },
    };
  }
  aliases() {
    return sshAliases();
  }
  async resolve(alias: string) {
    const target = await resolveSshAlias(alias, {}, this.commandRunner);
    return {
      alias,
      host: target.host,
      port: target.port,
      user: target.user,
      usesProxy: Boolean(target.proxyJump || target.proxyCommand),
      authentication: "system-ssh-config",
    };
  }
  async save(owner: string, input: unknown, id: string | null = null) {
    const parsed = profileSchema.safeParse(input);
    if (
      !parsed.success ||
      (parsed.data.mode === "manual" &&
        parsed.data.auth === "key" &&
        !parsed.data.keyPath)
    )
      throw new AppError(
        "SSH_CONFIGURATION_INVALID",
        "请输入有效的 SSH 地址、用户名、认证方式或别名。",
        { status: 422 },
      );
    const user = await this.user(owner);
    const previous = id ? await this.profile(owner, id) : null;
    if (!id && user.profiles.size >= 25)
      throw new AppError(
        "SSH_CONNECTION_LIMIT",
        "此账号的 SSH 连接数量已达上限。",
        { status: 422 },
      );
    if (id) await this.disconnect(owner, id);
    const profile: SshProfile = {
      ...parsed.data,
      id: id ?? randomUUID(),
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const identity = (value: SshProfile | null) =>
      JSON.stringify([
        value?.mode,
        value?.mode === "alias" ? value.alias : null,
        value?.mode === "manual" ? value.host : null,
        value?.mode === "manual" ? value.port : null,
        value?.mode === "manual" ? value.user : null,
        value?.mode === "manual" ? value.auth : null,
        value?.mode === "manual" ? value.keyPath : null,
      ]);
    if (previous && identity(previous) === identity(profile))
      Object.assign(profile, {
        ciphertext: previous.ciphertext,
        trust: previous.trust,
        lastInfo: previous.lastInfo,
      });
    user.profiles.set(profile.id, profile);
    await this.persist(owner);
    this.notify(owner, profile.id, "updated");
    return this.publicProfile(profile);
  }
  async remove(owner: string, id: string) {
    await this.profile(owner, id);
    await this.disconnect(owner, id);
    this.sessions.delete(this.sessionKey(owner, id));
    (await this.user(owner)).profiles.delete(id);
    await this.persist(owner);
    this.notify(owner, id, "removed");
  }
  async forget(owner: string, id: string) {
    const p = await this.profile(owner, id);
    delete p.ciphertext;
    await this.persist(owner);
    return this.publicProfile(p, this.sessions.get(this.sessionKey(owner, id)));
  }
  notify(owner: string, id: string, kind: string) {
    for (const listener of this.listeners) {
      try {
        listener(owner, id, kind);
      } catch {
        /* A view cannot interrupt connection cleanup. */
      }
    }
  }
  onChange(listener: (owner: string, id: string, kind: string) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async target(profile: SshProfile): Promise<Target> {
    if (profile.mode === "alias")
      return resolveSshAlias(profile.alias, {}, this.commandRunner);
    return {
      alias: "",
      host: profile.host.replace(/^\[|\]$/g, ""),
      port: profile.port,
      user: profile.user,
      auth: profile.auth,
      identityFiles:
        profile.auth === "key" ? [expandLocalPath(profile.keyPath)] : [],
      agent:
        process.env.SSH_AUTH_SOCK ??
        (process.platform === "win32"
          ? "\\\\.\\pipe\\openssh-ssh-agent"
          : null),
      knownHostsFiles: [path.join(os.homedir(), ".ssh", "known_hosts")],
      proxyJump: null,
      proxyCommand: null,
      hostKeyAlias: null,
    };
  }
  async challenge(session: SshSession, detail: Challenge): Promise<SshAnswer> {
    if (session.cancelled) throw new Error("SSH connection cancelled");
    session.status =
      detail.kind === "host-key" ? "verify_host" : "authentication";
    session.stage = detail.kind === "host-key" ? "verify-host" : "authenticate";
    const id = randomUUID();
    session.challenge = { ...detail, id };
    return new Promise<SshAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.challenge?.id === id) {
          session.challenge = null;
          session.reply = null;
          reject(new Error("Authentication timeout"));
        }
      }, 120000);
      timer.unref?.();
      session.reply = (answer) => {
        clearTimeout(timer);
        session.reply = null;
        session.challenge = null;
        resolve(answer);
      };
      session.cancelChallenge = () => {
        clearTimeout(timer);
        session.reply = null;
        session.challenge = null;
        reject(new Error("SSH connection cancelled"));
      };
    });
  }
  async respond(owner: string, id: string, answer: SshAnswer) {
    await this.profile(owner, id);
    const session = this.sessions.get(this.sessionKey(owner, id));
    if (
      !session?.challenge ||
      session.challenge.id !== answer?.challengeId ||
      !session.reply
    )
      throw new AppError(
        "SSH_CHALLENGE_EXPIRED",
        "此登录步骤已过期，请重新连接。",
        { status: 409 },
      );
    const challenge = session.challenge;
    if (challenge.kind === "host-key") {
      if (
        typeof answer.trust !== "boolean" ||
        (challenge.changed && answer.trust && answer.verified !== true)
      )
        throw new AppError(
          "SSH_HOST_CONFIRMATION_REQUIRED",
          "请核对主机指纹后再确认。",
          { status: 422 },
        );
    } else if (
      !Array.isArray(answer.values) ||
      answer.values.length !== challenge.prompts.length ||
      answer.values.some((v) => typeof v !== "string" || v.length > 4096)
    )
      throw new AppError("SSH_AUTH_RESPONSE_INVALID", "登录输入格式无效。", {
        status: 422,
      });
    if (answer.remember && !this.vault.available)
      throw new AppError(
        "SSH_VAULT_UNAVAILABLE",
        "此主机只能使用本次连接凭据。",
        { status: 422 },
      );
    session.reply({
      trust: answer.trust,
      values: answer.values,
      remember: answer.remember === true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return this.publicProfile(session.profile, session);
  }
  async connect(owner: string, id: string) {
    const profile = await this.profile(owner, id);
    if (this.closed) throw new AppError("SSH_SERVICE_CLOSED", "SSH 服务已关闭。", { status: 503 });
    const previous = this.sessions.get(this.sessionKey(owner, id));
    if (
      previous &&
      ["connecting", "verify_host", "authentication", "connected"].includes(
        previous.status,
      )
    )
      return this.publicProfile(profile, previous);
    const session: SshSession = {
      profile,
      owner,
      status: "connecting",
      stage: "resolve-config",
      error: null,
      challenge: null,
      clients: [],
      channels: new Set(),
      proxies: [],
      cancelled: false,
      credentials: {},
      remember: false,
      info: profile.lastInfo ?? null,
    };
    this.sessions.set(this.sessionKey(owner, id), session);
    const task = (async () => {
      try {
        if (profile.ciphertext) {
          try {
            session.credentials = await this.vault.reveal(profile.ciphertext);
          } catch {
            session.storageWarning = "保存的凭据无法解密，请重新输入。";
          }
        }
        this.assertConnecting(session);
        const target = await this.target(profile);
        this.assertConnecting(session);
        session.effective = target;
        let sock: Duplex | null = null;
        if (target.proxyJump) {
          const hops = target.proxyJump.split(",");
          if (hops.length > 4) throw new Error("Too many SSH hops");
          for (let index = 0; index < hops.length; index++) {
            const hop = hops[index];
            const match = hop.match(
              /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9._-]+)(?::(\d+))?$/,
            );
            if (!match) throw new Error("Unsupported SSH jump configuration");
            const hopTarget = await resolveSshAlias(
              match[2],
              { user: match[1], port: match[3] ? Number(match[3]) : undefined },
              this.commandRunner,
            );
            this.assertConnecting(session);
            const client = await this.openClient(session, hopTarget, sock);
            this.assertConnecting(session);
            const next = hops[index + 1];
            let nextTarget = target;
            if (next) {
              const parsed = next.match(
                /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9._-]+)(?::(\d+))?$/,
              );
              if (!parsed)
                throw new Error("Unsupported SSH jump configuration");
              nextTarget = await resolveSshAlias(
                parsed[2],
                { user: parsed[1], port: parsed[3] ? Number(parsed[3]) : undefined },
                this.commandRunner,
              );
              this.assertConnecting(session);
            }
            sock = await new Promise<ClientChannel>((resolve, reject) =>
              client.forwardOut(
                "127.0.0.1",
                0,
                nextTarget.host,
                nextTarget.port,
                (error, stream) => {
                  if (error) return reject(error);
                  try { this.assertConnecting(session); }
                  catch (cancelled) { stream.destroy(); reject(cancelled); return; }
                  session.channels.add(stream);
                  stream.once("close", () => session.channels.delete(stream));
                  resolve(stream);
                },
              ),
            );
          }
        } else if (target.proxyCommand) {
          this.assertConnecting(session);
          const command = target.proxyCommand
            .replace(/%%/g, "\0")
            .replace(/%h/g, target.host)
            .replace(/%p/g, String(target.port))
            .replace(/%r/g, target.user)
            .replace(/\0/g, "%");
          const shell =
            process.platform === "win32"
              ? (process.env.ComSpec ?? "cmd.exe")
              : "/bin/sh";
          const child = spawn(
            shell,
            process.platform === "win32"
              ? ["/d", "/s", "/c", command]
              : ["-c", command],
            { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] as const },
          );
          child.on("error", () => {});
          session.proxies.push(child);
          if (!child.stdin || !child.stdout) throw new Error("Proxy process streams unavailable");
          // Node supports a pair of Node streams; @types/node only declares web pairs.
          const fromStreams = Duplex.from as unknown as (streams: { writable: NodeJS.WritableStream; readable: NodeJS.ReadableStream }) => Duplex;
          sock = fromStreams({ writable: child.stdin, readable: child.stdout });
        }
        session.client = await this.openClient(session, target, sock);
        this.assertConnecting(session);
        session.status = "connected";
        session.stage = "connected";
        session.connectedAt = new Date().toISOString();
        session.challenge = null;
        if (session.remember) {
          try {
            profile.ciphertext = await this.vault.protect(session.credentials);
            this.assertConnecting(session);
            await this.persist(owner);
          } catch {
            session.storageWarning =
              "本次已登录，但系统凭据存储失败，凭据未保存。";
          }
        }
        session.credentials = {};
        this.notify(owner, id, "connected");
        session.infoTask = this.basicInfo(owner, id).catch(() => {
          session.info = {
            platform: "unknown",
            user: target.user,
            home: null,
            python: null,
            tools: {},
            status: "unavailable",
          };
        });
        await session.infoTask;
        this.assertConnecting(session);
        if (session.info?.status === "ready") {
          profile.lastInfo = session.info;
          await this.persist(owner);
        }
      } catch (error) {
        if (!session.cancelled) {
          session.status = "error";
          session.stage = "failed";
          session.error = session.hostKeyError ?? shortError(error);
        }
        session.cancelChallenge?.();
        session.challenge = null;
        session.credentials = {};
        for (const client of session.clients) client.end();
        for (const child of session.proxies) child.kill();
      }
    })();
    session.task = task;
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
    return this.publicProfile(profile, session);
  }
  assertConnecting(session: SshSession) {
    if (this.closed || session.cancelled || this.sessions.get(this.sessionKey(session.owner, session.profile.id)) !== session)
      throw new AppError("SSH_CONNECTION_CANCELLED", "SSH 连接已取消。", { status: 409 });
  }
  async openClient(session: SshSession, target: Target, sock: Duplex | null): Promise<SshClient> {
    this.assertConnecting(session);
    const records = await knownHostKeys(target, this.commandRunner);
    this.assertConnecting(session);
    const keys: { file: string; data: Buffer }[] = [];
    for (const file of target.identityFiles ?? []) {
      try {
        if ((await stat(file)).size <= 524288)
          keys.push({ file, data: await readFile(file) });
      } catch {
        /* Try the next configured identity. */
      }
    }
    this.assertConnecting(session);
    if (target.auth === "key" && !keys.length)
      throw new Error("Authentication key unavailable");
    const targetId = `${target.user}@${target.host}:${target.port}`;
    const credentials = session.credentials[targetId] ?? {};
    session.credentials[targetId] = credentials;
    let triedNone = false,
      triedAgent = false,
      keyIndex = 0,
      passwordAttempts = 0,
      keyboardAttempts = 0;
    const method = async (methods: AuthenticationType[] | null, partial: boolean | null): Promise<AnyAuthMethod | false> => {
      if (session.cancelled) return false;
      if (!triedNone) {
        triedNone = true;
        return { type: "none", username: target.user };
      }
      const allowed = (name: string) =>
        !methods || methods.includes((name === "agent" ? "publickey" : name) as AuthenticationType);
      if (
        !partial &&
        ["agent", "system"].includes(target.auth) &&
        target.agent &&
        !triedAgent &&
        allowed("agent")
      ) {
        triedAgent = true;
        return { type: "agent", username: target.user, agent: target.agent };
      }
      if (!partial && target.auth !== "password" && allowed("publickey")) {
        while (keyIndex < keys.length) {
          const candidate = keys[keyIndex++];
          let parsed = utils.parseKey(
            candidate.data,
            credentials.passphrases?.[candidate.file],
          );
          if (
            parsed instanceof Error &&
            /encrypt|passphrase|decrypt/i.test(parsed.message)
          ) {
            for (
              let attempt = 0;
              attempt < 3 && parsed instanceof Error;
              attempt++
            ) {
              const response = await this.challenge(session, {
                kind: "passphrase",
                host: target.host,
                port: target.port,
                user: target.user,
                title: "解锁 SSH 私钥",
                prompts: [
                  { label: path.basename(candidate.file), secret: true },
                ],
                canRemember: this.vault.available,
              });
              const passphrase = response.values?.[0] ?? "";
              parsed = utils.parseKey(candidate.data, passphrase);
              if (!(parsed instanceof Error)) {
                (credentials.passphrases ??= {})[candidate.file] = passphrase;
                session.remember ||= response.remember === true;
              }
            }
          }
          if (parsed instanceof Error) continue;
          return {
            type: "publickey",
            username: target.user,
            key: Array.isArray(parsed) ? parsed[0] : parsed,
          };
        }
      }
      if (
        allowed("keyboard-interactive") &&
        keyboardAttempts < 3 &&
        (partial || target.auth === "system" || target.auth === "password")
      ) {
        keyboardAttempts++;
        return {
          type: "keyboard-interactive",
          username: target.user,
          prompt: (_name, instructions, _language, prompts, finish) => {
            if (!prompts.length) return finish([]);
            if (prompts.length > 8) return finish([]);
            this.challenge(session, {
              kind: "keyboard",
              host: target.host,
              port: target.port,
              user: target.user,
              title: "SSH 交互认证",
              instructions: cleanPrompt(instructions),
              prompts: prompts.map((p) => ({
                label: cleanPrompt(p.prompt),
                secret: !p.echo,
              })),
              canRemember: false,
            }).then(
              (answer) => finish(answer.values ?? []),
              () => finish([]),
            );
          },
        };
      }
      if (
        allowed("password") &&
        ["system", "password"].includes(target.auth) &&
        passwordAttempts < 3
      ) {
        passwordAttempts++;
        if (passwordAttempts === 1 && credentials.password)
          return {
            type: "password",
            username: target.user,
            password: credentials.password,
          };
        const answer = await this.challenge(session, {
          kind: "password",
          host: target.host,
          port: target.port,
          user: target.user,
          title:
            passwordAttempts > 1
              ? "认证未通过，请重新输入"
              : "输入 SSH 登录密码",
          prompts: [{ label: "密码", secret: true }],
          canRemember: this.vault.available,
        });
        credentials.password = answer.values?.[0] ?? "";
        session.remember ||= answer.remember === true;
        return {
          type: "password",
          username: target.user,
          password: credentials.password,
        };
      }
      return false;
    };
    return new Promise<SshClient>((resolve, reject) => {
      const client = this.clientFactory();
      session.clients.push(client);
      let ready = false;
      const dialTimer = setTimeout(() => {
        if (!ready && !session.challenge) {
          client.end();
          reject(new Error("Connection timeout"));
        }
      }, session.profile.timeoutSeconds * 1000);
      dialTimer.unref?.();
      client.once("connect", () => clearTimeout(dialTimer));
      client.once("handshake", () => clearTimeout(dialTimer));
      client.once("ready", () => {
        try { this.assertConnecting(session); }
        catch (error) { clearTimeout(dialTimer); client.end(); reject(error); return; }
        ready = true;
        clearTimeout(dialTimer);
        resolve(client);
      });
      client.on("error", (error) => {
        clearTimeout(dialTimer);
        if (!ready) reject(error);
        else if (!session.cancelled) {
          session.status = "disconnected";
          session.error = "SSH 连接已中断，可重新连接后继续查看。";
          this.notify(session.owner, session.profile.id, "disconnected");
        }
      });
      client.once("close", () => {
        clearTimeout(dialTimer);
        if (!ready) reject(new Error("SSH closed before authentication"));
        else if (!session.cancelled) {
          session.status = "disconnected";
          this.notify(session.owner, session.profile.id, "disconnected");
        }
      });
      const preferred = records.flatMap((record) =>
        record.algorithm === "ssh-rsa"
          ? ["rsa-sha2-512", "rsa-sha2-256"]
          : [record.algorithm],
      );
      client.connect({
        host: target.host,
        port: target.port,
        username: target.user,
        sock: sock ?? undefined,
        readyTimeout: 180000,
        keepaliveInterval: session.profile.keepAlive ? 15000 : 0,
        keepaliveCountMax: 3,
        agentForward: false,
        algorithms: {
          serverHostKey: [
            ...new Set<ServerHostKeyAlgorithm>([
              ...preferred.filter((algorithm): algorithm is ServerHostKeyAlgorithm => ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "rsa-sha2-512", "rsa-sha2-256", "ssh-rsa", "ssh-dss"].includes(algorithm)),
              "ssh-ed25519",
              "ecdsa-sha2-nistp256",
              "ecdsa-sha2-nistp384",
              "ecdsa-sha2-nistp521",
              "rsa-sha2-512",
              "rsa-sha2-256",
            ]),
          ],
        },
        authHandler: (methods, partial, callback) => {
          // ssh2 accepts false to exhaust authentication; @types/ssh2 omits it.
          const next = callback as (auth: AnyAuthMethod | false) => void;
          void method(methods, partial).then(next, () => next(false));
        },
        hostVerifier: (key: Buffer, callback: (accepted: boolean) => void) => {
          const actual = fingerprint(key),
            targetKey = `${target.host}:${target.port}`;
          const trusted = session.profile.trust;
          if (
            records.some(
              (record) => record.revoked && record.fingerprint === actual,
            )
          ) {
            session.hostKeyError =
              "此主机密钥已在系统 SSH 记录中撤销，请核查服务器配置。";
            callback(false);
            return;
          }
          const pinned =
            trusted?.hosts?.[targetKey] ??
            (trusted?.target === targetKey ? trusted.fingerprint : null);
          if (
            pinned
              ? pinned === actual
              : records.some(
                  (record) => !record.revoked && record.fingerprint === actual,
                )
          ) {
            callback(true);
            return;
          }
          this.challenge(session, {
            kind: "host-key",
            host: target.host,
            port: target.port,
            user: target.user,
            fingerprint: actual,
            previousFingerprints: pinned
              ? [pinned]
              : records.map((r) => r.fingerprint),
            changed: Boolean(pinned || records.length),
            prompts: [],
          })
            .then(
              async (answer) => {
                if (answer.trust) {
                  session.profile.trust = {
                    target: targetKey,
                    fingerprint: actual,
                    hosts: {
                      ...session.profile.trust?.hosts,
                      [targetKey]: actual,
                    },
                  };
                  await this.persist(session.owner);
                }
                callback(answer.trust === true);
              },
              () => callback(false),
            )
            .catch(() => callback(false));
        },
      });
    });
  }
  async connected(owner: string, id: string): Promise<SshSession & { client: SshClient }> {
    await this.profile(owner, id);
    const session = this.sessions.get(this.sessionKey(owner, id));
    if (session?.status !== "connected" || !session.client)
      throw new AppError(
        "SSH_NOT_CONNECTED",
        "SSH 主机尚未连接，可重连或查看已有缓存。",
        { status: 409 },
      );
    return session as SshSession & { client: SshClient };
  }
  async browseDirectory(owner: string, id: string, directory = "", { list = true, offset = 0, query = "" } = {}) {
    const session = await this.connected(owner, id);
    if (session.infoTask) await session.infoTask;
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      let settled = false;
      const opening = setTimeout(() => { settled = true; reject(new AppError("PROJECT_DIRECTORY_TIMEOUT", "SSH 目录通道打开超时，请重试。", { status: 504 })); }, 10000);
      session.client.sftp((error, channel) => {
        clearTimeout(opening);
        if (settled) { channel?.end(); return; }
        settled = true;
        if (error) reject(new AppError("PROJECT_DIRECTORY_UNAVAILABLE", "SSH 主机未能打开目录通道，请检查 SFTP 服务。", { status: 422 })); else resolve(channel);
      });
    });
    sftp.on("error", () => {});
    session.channels.add(sftp);
    const call = {
      realpath: promisify(sftp.realpath.bind(sftp)),
      stat: promisify(sftp.stat.bind(sftp)),
      opendir: promisify(sftp.opendir.bind(sftp)),
      readdir: promisify(sftp.readdir.bind(sftp)),
      close: promisify(sftp.close.bind(sftp)),
    };
    let timer;
    try {
      const task = (async () => {
        const home = session.info?.home || "/";
        const requested = directory === "~" ? home : directory.startsWith("~/") ? path.posix.join(home, directory.slice(2)) : directory || home;
        const canonical = await call.realpath(requested), info = await call.stat(canonical);
        if (!info.isDirectory()) throw new AppError("PROJECT_DIRECTORY_INVALID", "所选路径不是目录。", { status: 422 });
        const handle = await call.opendir(canonical), entries = [];
        let partial = false, scanned = 0;
        try {
          if (list) while (true) {
            let chunk;
            try { chunk = await call.readdir(handle); }
            catch (error) { if (errorProperties(error).code === 1) break; throw error; }
            if (!chunk) break;
            for (const entry of chunk) {
              scanned++;
              if (entry.filename !== "." && entry.filename !== ".." && entry.attrs.isDirectory() && entry.filename.toLowerCase().includes(query.toLowerCase())) entries.push({ name: entry.filename, path: path.posix.join(canonical, entry.filename) });
            }
            if (scanned >= 20000 || entries.length >= 3000) { partial = true; break; }
          }
        } finally { await call.close(handle); }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        if (this.sessions.get(this.sessionKey(owner, id)) !== session || session.status !== "connected") throw new AppError("SSH_NOT_CONNECTED", "SSH 连接已变化，请重新选择目录。", { status: 409 });
        return { directory: canonical, parent: canonical === "/" ? null : path.posix.dirname(canonical), entries: entries.slice(offset, offset + 100), total: entries.length, nextOffset: offset + 100 < entries.length ? offset + 100 : null, partial, home, roots: [{ name: session.info?.user || "Home", path: home }, { name: "/", path: "/" }] };
      })();
      return await Promise.race([task, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new AppError("PROJECT_DIRECTORY_TIMEOUT", "目录读取超时，请重试或输入更具体的路径。", { status: 504 })), 15000); })]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const code = errorProperties(error).code;
      throw new AppError(code === 2 ? "PROJECT_DIRECTORY_NOT_FOUND" : "PROJECT_DIRECTORY_UNAVAILABLE", code === 2 ? "目录不存在，请检查路径。" : code === 3 ? "目录不可访问，请检查 SSH 账号权限。" : "未能读取目录，请检查 SSH 连接后重试。", { status: 422 });
    } finally { clearTimeout(timer); session.channels.delete(sftp); sftp.end(); }
  }
  async reverseForward(owner: string, id: string, localPort: number, localHost = "127.0.0.1") {
    const session = await this.connected(owner, id), client = session.client;
    const port = await new Promise<number>((resolve, reject) => client.forwardIn("127.0.0.1", 0, (error, port) => error ? reject(error) : resolve(port)));
    let closed = false;
    const sockets = new Set<Duplex>();
    const listener = (details: TcpConnectionDetails, accept: () => ClientChannel, reject: () => void) => {
      if (details.destPort !== port) return;
      if (closed || this.sessions.get(this.sessionKey(owner, id)) !== session || session.status !== "connected") { reject(); return; }
      const channel = accept(), socket = connectTcp({ host: localHost, port: localPort });
      sockets.add(socket); sockets.add(channel);
      socket.on("error", () => channel.destroy()); channel.on("error", () => socket.destroy());
      socket.on("close", () => { sockets.delete(socket); channel.destroy(); });
      channel.on("close", () => { sockets.delete(channel); socket.destroy(); });
      socket.pipe(channel).pipe(socket);
    };
    client.on("tcp connection", listener);
    const close = () => { if (closed) return; closed = true; client.removeListener("tcp connection", listener); for (const socket of sockets) socket.destroy(); try { client.unforwardIn("127.0.0.1", port, () => {}); } catch { /* The SSH connection may already be closed. */ } };
    if (this.sessions.get(this.sessionKey(owner, id)) !== session || session.status !== "connected") { close(); throw new AppError("SSH_NOT_CONNECTED", "SSH 连接已断开。", { status: 409 }); }
    client.once("close", close);
    return { port, close: () => { client.removeListener("close", close); close(); }, session, get active() { return !closed; } };
  }
  async exec(
    owner: string,
    id: string,
    statement: string,
    { input = "", timeoutMs = 20000, maxOutputBytes = 131072, onStdout = undefined }: SshRunOptions = {},
  ) {
    const session = await this.connected(owner, id);
    return new Promise<CommandResult>((resolve) => {
      let output = Buffer.alloc(0),
        errorOutput = Buffer.alloc(0),
        settled = false,
        stream: ClientChannel | undefined;
      const finish = (result: Omit<CommandResult, "stdout" | "stderr">) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stream) session.channels.delete(stream);
        resolve({
          stdout: output.toString("utf8"),
          stderr: errorOutput.toString("utf8"),
          ...result,
        });
      };
      const stop = (result: Omit<CommandResult, "stdout" | "stderr">) => {
        try {
          stream?.signal("TERM");
          stream?.close();
        } catch { /* Output still completes when the remote channel has closed. */ }
        finish(result);
      };
      const timer = setTimeout(
        () => stop({ ok: false, timedOut: true, code: null }),
        timeoutMs,
      );
      timer.unref?.();
      session.client.exec(statement, { pty: false }, (error, channel) => {
        if (error) {
          finish({ ok: false, code: null });
          return;
        }
        if (settled) {
          channel.close();
          return;
        }
        stream = channel;
        session.channels.add(stream);
        channel.on("data", (chunk: Buffer) => {
          onStdout?.(chunk.toString("utf8"));
          if (output.length + chunk.length > maxOutputBytes)
            stop({ ok: false, outputLimitExceeded: true });
          else output = Buffer.concat([output, chunk]);
        });
        channel.stderr.on("data", (chunk) => {
          if (
            errorOutput.length + chunk.length >
            Math.min(maxOutputBytes, 32768)
          )
            stop({ ok: false, outputLimitExceeded: true });
          else errorOutput = Buffer.concat([errorOutput, chunk]);
        });
        channel.once("error", () => finish({ ok: false, code: null }));
        channel.once("close", (code: number | null) =>
          finish({ ok: code === 0, timedOut: false, code }),
        );
        channel.end(input);
      });
    });
  }
  async run(owner: string, id: string, command: string, args: string[] = [], options: SshRunOptions = {}) {
    const allowed = [
      "PYTHONDONTWRITEBYTECODE",
      "TF_CPP_MIN_LOG_LEVEL",
      "XLA_PYTHON_CLIENT_PREALLOCATE",
      "CUDA_MODULE_LOADING",
    ];
    const environment = Object.entries(options.env ?? {})
      .filter(([key]) => allowed.includes(key))
      .map(([key, value]) => `${key}=${value}`);
    const argv = args.map(String);
    let input = options.input ?? "";
    const probe = path.join(bundledRoot, "scripts", "runtime", "probe-research-python.py");
    const probeIndex = argv.indexOf(probe);
    if (probeIndex >= 0) {
      argv[probeIndex] = "-";
      input = await readFile(probe, "utf8");
    }
    const line = `${options.cwd ? `cd -- ${quotePosix(options.cwd)} && ` : ""}exec env -- ${[...environment, command, ...argv].map(quotePosix).join(" ")}`;
    return this.exec(owner, id, `sh -lc ${quotePosix(line)}`, {
      ...options,
      input,
    });
  }
  async basicInfo(owner: string, id: string) {
    const session = await this.connected(owner, id);
    const result = await this.exec(
      owner,
      id,
      "printf 'TOPOLUMIA_SSH_INFO\\n'; uname -s; id -un; printf '%s\\n' \"$HOME\"; command -v python3 || command -v python || true",
      { timeoutMs: 8000, maxOutputBytes: 8192 },
    );
    const lines = result.stdout.split(/\r?\n/);
    const marker = lines.indexOf("TOPOLUMIA_SSH_INFO");
    if (!result.ok || marker < 0)
      throw new Error("Remote platform not available");
    session.info = {
      platform: cleanPrompt(lines[marker + 1]),
      user: cleanPrompt(lines[marker + 2]),
      home: cleanPrompt(lines[marker + 3]),
      python: cleanPrompt(lines[marker + 4]) || null,
      tools: {},
      status: "ready",
    };
    return session.info;
  }
  async disconnect(owner: string, id: string) {
    await this.profile(owner, id);
    const session = this.sessions.get(this.sessionKey(owner, id));
    if (session) {
      session.cancelled = true;
      session.cancelChallenge?.();
      session.challenge = null;
      for (const stream of session.channels) {
        try {
          if ("signal" in stream) { stream.signal("TERM"); stream.close(); }
          else stream.end();
        } catch { /* Continue releasing the remaining connection resources. */ }
      }
      for (const client of [...session.clients].reverse()) client.end();
      for (const child of session.proxies) child.kill();
      session.status = "disconnected";
      session.credentials = {};
      session.stage = null;
      session.client = null;
      session.clients = [];
      session.proxies = [];
      session.channels.clear();
      session.cancelChallenge = null;
    }
    this.notify(owner, id, "disconnected");
    return session
      ? this.publicProfile(session.profile, session)
      : this.publicProfile(await this.profile(owner, id));
  }
  async close() {
    this.closed = true;
    for (const session of this.sessions.values())
      await this.disconnect(session.owner, session.profile.id).catch(() => {});
    await Promise.allSettled([...this.tasks]);
  }
}
