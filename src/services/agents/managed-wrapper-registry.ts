import type { AgentProfile } from "../../domain/agents/agent-types.js";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { runCommand } from "../../lib/command.js";
import { codexConfigurationArgs } from "./configuration/native-format.js";

const WRAPPER_VERSION = "0.1.0";
const WRAPPER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function parseVersion(value: unknown) {
  const match = String(value ?? "").match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function compareVersions(left: string | null, right: string | null) {
  const a = String(left ?? "0.0.0").split(".").map(Number);
  const b = String(right ?? "0.0.0").split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

async function commandExists(command: string) {
  if (!command) return false;
  if (command === "node") return true;
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    try {
      await access(command);
      return true;
    } catch {
      return false;
    }
  }
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = await runCommand(locator, [command], { timeoutMs: 2_000, maxOutputBytes: 32_768 });
  return result.ok && result.stdout.trim().length > 0;
}

async function probeAuth(profile: AgentProfile) {
  const probe = profile.authProbe;
  if (!probe) return { required: false, status: "not-required", reason: "auth_probe_not_configured" };
  const nativeArgs = profile.provider === "codex" ? codexConfigurationArgs(profile.nativeConfig) : profile.provider === "claude" && profile.nativeConfigFile ? ["--settings", profile.nativeConfigFile] : [];
  const result = await runCommand(profile.command, [...nativeArgs, ...(probe.args ?? [])], {
    timeoutMs: probe.timeoutMs ?? 8_000,
    maxOutputBytes: 65_536,
    allowCmdShim: true,
    env: { ...process.env, ...profile.env, ...(profile.provider === "claude" ? profile.nativeConfig?.env : {}) },
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (probe.kind === "claude") {
    try {
      const payload = JSON.parse(result.stdout);
      if (payload.loggedIn === true) return { required: true, status: "ready", method: payload.authMethod ?? null, provider: payload.apiProvider ?? null };
      return { required: true, status: "needs-auth", reason: "claude_not_logged_in" };
    } catch {
      return { required: true, status: "needs-auth", reason: result.ok ? "claude_auth_status_unparseable" : "claude_auth_status_failed" };
    }
  }
  if (probe.kind === "codex") {
    if (result.ok && /logged in/i.test(output) && !/not logged|logged out|unauthorized/i.test(output)) {
      return { required: true, status: "ready", method: /api key/i.test(output) ? "api-key" : "unknown" };
    }
    if (await codexProviderDoesNotRequireOpenAiAuth()) {
      return { required: false, status: "not-required", reason: "provider_config_no_auth" };
    }
    return { required: true, status: "needs-auth", reason: "codex_not_logged_in" };
  }
  return result.ok
    ? { required: true, status: "ready" }
    : { required: true, status: "needs-auth", reason: "auth_probe_failed" };
}

async function codexProviderDoesNotRequireOpenAiAuth() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  try {
    const config = await readFile(path.join(home, "config.toml"), "utf8");
    return /requires_openai_auth\s*=\s*false/i.test(config);
  } catch {
    return false;
  }
}

function wrapperIdFor(profile: AgentProfile) {
  const id = String(profile?.managedWrapper ?? "").trim();
  return WRAPPER_ID_PATTERN.test(id) ? id : null;
}

export interface RuntimeProbe {
  availability: string; reason?: string;
  capabilities?: string[];
  runtime: { command: string; args?: string[]; available: boolean; installRequired?: boolean; version?: string | null };
  auth?: { required: boolean; status: string; reason?: string; method?: string | null; provider?: string | null };
  wrapper?: { mode: string; id?: string; version?: string; transport?: string; installRequired: boolean; available: boolean; entry?: string; runtimeCommand?: string; runtimeArgs?: string[] };
}
export class ManagedWrapperRegistry {
  root: string; probeCache = new Map<string, RuntimeProbe>();
  constructor({ root }: { root: string }) {
    this.root = root;

  }

  descriptor(profile: AgentProfile) {
    const id = wrapperIdFor(profile);
    if (!id) return null;
    return {
      mode: "bundled",
      id,
      version: WRAPPER_VERSION,
      transport: "stdio-proxy",
      installRequired: false,
      entry: path.join(this.root, `${id}.js`),
      runtimeCommand: profile.runtimeCommand ?? profile.command,
      runtimeArgs: [...(profile.runtimeArgs ?? profile.args ?? [])],
    };
  }

  async probe(profile: AgentProfile, { refresh = false } = {}): Promise<RuntimeProbe> {
    const cacheKey = profile.id;
    if (!refresh && this.probeCache.has(cacheKey)) return this.probeCache.get(cacheKey)!;
    const descriptor = this.descriptor(profile);
    if (!descriptor) {
      const available = await commandExists(profile.command);
      const result: RuntimeProbe = {
        availability: available ? "ready" : "needs-runtime",
        reason: available ? "native_runtime_ready" : "runtime_not_found",
        wrapper: { mode: "native", installRequired: !available, available },
        capabilities: profile.capabilities ?? [],
        runtime: {
          command: profile.command,
          args: [...(profile.args ?? [])],
          available,
          installRequired: !available,
        },
      };
      if (!available) {
        this.probeCache.set(cacheKey, result);
        return result;
      }
      if (profile.versionArgs) {
        const versionResult = await runCommand(profile.command, profile.versionArgs, {
          timeoutMs: profile.versionTimeoutMs ?? 8_000,
          maxOutputBytes: 65_536,
          allowCmdShim: true,
        });
        const version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
        result.runtime.version = version;
        if (profile.minVersion && version && compareVersions(version, profile.minVersion) < 0) {
          result.availability = "incompatible";
          result.reason = "runtime_version_incompatible";
        }
      }
      result.auth = await probeAuth(profile);
      if (result.availability === "ready" && result.auth.status === "needs-auth") {
        result.availability = "needs-auth";
        result.reason = result.auth.reason ?? "auth_required";
      }
      this.probeCache.set(cacheKey, result);
      return result;
    }

    let wrapperAvailable = false;
    try {
      await access(descriptor.entry);
      wrapperAvailable = true;
    } catch {
      wrapperAvailable = false;
    }
    if (!wrapperAvailable) {
      const result: RuntimeProbe = {
        availability: "unavailable",
        reason: "bundled_wrapper_missing",
        wrapper: { ...descriptor, entry: undefined, available: false },
        runtime: { command: descriptor.runtimeCommand, args: descriptor.runtimeArgs, available: false, installRequired: true },
      };
      this.probeCache.set(cacheKey, result);
      return result;
    }

    const runtimeAvailable = await commandExists(descriptor.runtimeCommand);
    const result: RuntimeProbe = {
      availability: runtimeAvailable ? "ready" : "needs-runtime",
      reason: runtimeAvailable ? "bundled_wrapper_ready" : "runtime_not_found",
      capabilities: profile.capabilities ?? [],
      wrapper: { ...descriptor, entry: undefined, available: true },
      runtime: {
        command: descriptor.runtimeCommand,
        args: descriptor.runtimeArgs,
        available: runtimeAvailable,
        installRequired: !runtimeAvailable,
      },
    };
    this.probeCache.set(cacheKey, result);
    return result;
  }

  invocation(profile: AgentProfile) {
    const descriptor = this.descriptor(profile);
    if (!descriptor) return { command: profile.command, args: [...(profile.args ?? [])] };
    return {
      command: process.execPath,
      args: [
        descriptor.entry,
        "--runtime",
        descriptor.runtimeCommand,
        "--runtime-args-json",
        JSON.stringify(descriptor.runtimeArgs),
        "--wrapper-id",
        descriptor.id,
      ],
    };
  }

  clear(profileId: string | null = null) {
    if (profileId) this.probeCache.delete(profileId);
    else this.probeCache.clear();
  }
}

export { WRAPPER_VERSION };
