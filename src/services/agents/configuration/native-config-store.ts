import type { AgentProfile, NativeConfig } from "../../../domain/agents/agent-types.js";
import { asAppError } from "../../../lib/errors.js";
import path from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  lstat,
  chmod,
} from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { AppError } from "../../../lib/errors.js";
import { bundledRoot } from "../../../config.js";
import {
  nativeFormats,
  initialNativeConfig,
  parseNativeConfig,
  serializeNativeConfig,
  nativeProfile,
  nativeConfigKey,
} from "./native-format.js";

const digest = (content: string) => createHash("sha256").update(content).digest("hex");
interface ConfigEntry { provider?: string; file?: string; content?: string; revision?: string; parsed?: NativeConfig; error?: unknown; updatedAt?: string }
export class NativeAgentConfigStore {
  root: string; entries: Map<string, ConfigEntry>; queue: Promise<unknown>; schemas: Map<string, unknown>;
  constructor(root: string) {
    this.root = root;
    this.entries = new Map();
    this.queue = Promise.resolve();
    this.schemas = new Map();
  }
  file(provider: string) {
    if (!Object.hasOwn(nativeFormats, provider))
      throw new AppError(
        "AGENT_NATIVE_CONFIG_NOT_FOUND",
        "此 Agent 不支持原生配置。",
        { status: 404 },
      );
    return path.join(this.root, provider, nativeFormats[provider].filename);
  }
  async safeDirectory(directory: string) {
    const relative = path.relative(this.root, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Invalid configuration directory");
    let current = this.root;
    for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      await mkdir(current, { recursive: true, mode: 0o700 });
      if ((await lstat(current)).isSymbolicLink())
        throw new AppError(
          "AGENT_NATIVE_CONFIG_PATH_INVALID",
          "配置目录不能是符号链接。",
          { status: 422 },
        );
    }
  }
  async atomicWrite(file: string, content: string) {
    await this.safeDirectory(path.dirname(file));
    const info = await lstat(file).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    });
    if (info && (!info.isFile() || info.isSymbolicLink()))
      throw new AppError(
        "AGENT_NATIVE_CONFIG_PATH_INVALID",
        "配置目标必须是普通文件。",
        { status: 422 },
      );
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
    await chmod(file, 0o600).catch((error) => {
      if (process.platform !== "win32") throw error;
    });
  }
  async initialize(profiles: AgentProfile[]) {
    for (const provider of Object.keys(nativeFormats)) {
      const profile = profiles.find((profile) => nativeConfigKey(profile) === provider);
      if (!profile) continue;
      const file = this.file(provider);
      try {
        await lstat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.atomicWrite(
          file,
          serializeNativeConfig(provider, initialNativeConfig(profile)),
        );
      }
      try {
        await this.read(provider);
      } catch (error) {
        this.entries.set(provider, { error });
      }
    }
  }
  async read(provider: string) {
    const file = this.file(provider),
      info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 524288)
      throw new AppError(
        "AGENT_NATIVE_CONFIG_INVALID",
        "配置必须是小于 512 KiB 的普通文件。",
        { status: 422 },
      );
    const content = await readFile(file, "utf8"),
      revision = `sha256:${digest(content)}`;
    let parsed,
      error: unknown = null;
    try {
      parsed = parseNativeConfig(provider, content);
    } catch (problem) {
      error = problem;
    }
    const entry = {
      provider,
      file,
      content,
      revision,
      parsed,
      error,
      updatedAt: info.mtime.toISOString(),
    };
    this.entries.set(provider, entry);
    return entry;
  }
  async document(provider: string) {
    const entry = await this.read(provider);
    if (!this.schemas.has(provider))
      this.schemas.set(
        provider,
        JSON.parse(
          await readFile(
            path.join(
              bundledRoot,
              "src/services/agents/configuration/schemas",
              nativeFormats[provider].schemaFile ?? `${provider}.json`,
            ),
            "utf8",
          ),
        ),
      );
    return {
      schemaVersion: "agent-native-config.v1",
      provider: provider === "opencode-v2" ? "opencode" : provider,
      configKey: provider,
      ...nativeFormats[provider],
      path: entry.file,
      content: entry.content,
      revision: entry.revision,
      updatedAt: entry.updatedAt,
      valid: !entry.error,
      validation: entry.error
        ? { message: asAppError(entry.error).message, detail: asAppError(entry.error).detail }
        : null,
      schema: this.schemas.get(provider),
    };
  }
  effective(profile: AgentProfile) {
    const entry = this.entries.get(nativeConfigKey(profile));
    return entry?.parsed ? nativeProfile(profile, entry.parsed!) : profile;
  }
  async snapshot(profile: AgentProfile) {
    if (!nativeFormats[nativeConfigKey(profile)]) return profile;
    const entry = await this.read(nativeConfigKey(profile));
    if (entry.error) throw entry.error;
    const file = path.join(
      path.dirname(entry.file),
      `snapshots-${digest(entry.content)}-${nativeFormats[nativeConfigKey(profile)].filename}`,
    );
    await this.safeDirectory(path.dirname(file));
    try {
      const info = await lstat(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 524288 ||
        digest(await readFile(file, "utf8")) !== digest(entry.content)
      )
        throw new AppError(
          "AGENT_NATIVE_CONFIG_SNAPSHOT_INVALID",
          "会话配置快照已变化，请重新保存配置后重试。",
          { status: 409 },
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.atomicWrite(file, entry.content);
    }
    return {
      ...nativeProfile(profile, entry.parsed!),
      nativeConfig: structuredClone(entry.parsed),
      nativeConfigFile: file,
      nativeConfigRevision: entry.revision,
      nativeConfigRoot: this.root,
    };
  }
  save(provider: string, content: string, expectedRevision: string) {
    const operation = this.queue.then(async () => {
      const parsed = parseNativeConfig(provider, content),
        current = await this.read(provider);
      if (current.revision !== expectedRevision)
        throw new AppError(
          "AGENT_NATIVE_CONFIG_CONFLICT",
          "配置已被修改，请重新载入后保存。",
          { status: 409 },
        );
      await this.atomicWrite(this.file(provider), content);
      const entry = await this.read(provider);
      entry.parsed = parsed;
      return this.document(provider);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
