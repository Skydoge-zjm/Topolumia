import type { AppConfig } from "../../config.js";
import type { AgentProfile, AgentDriverOptions, AgentAdapterContract } from "../../domain/agents/agent-types.js";
import type { NativeAgentConfigStore } from "./configuration/native-config-store.js";
import type { AgentModelCatalog } from "../../domain/agents/agent-model-catalog.js";
import type { RuntimeProbe } from "./managed-wrapper-registry.js";
import path from "node:path";
import { AppError } from "../../lib/errors.js";
import { AcpProcessDriver } from "../../adapters/agents/acp/acp-agent-driver.js";
import { ClaudeCodeAgentAdapter } from "../../adapters/agents/claude/claude-code-agent-adapter.js";
import { CodexAgentAdapter } from "../../adapters/agents/codex/codex-agent-adapter.js";
import { createOpenCodeAdapter, discoverOpenCodeModels, openCodeDriver, openCodeVersionProfile, assertOpenCodeBinding } from "../../adapters/agents/opencode/opencode-runtime.js";
import { ManagedWrapperRegistry } from "./managed-wrapper-registry.js";

function publicProfile(profile: AgentProfile, probe: RuntimeProbe) {
  if (profile.model && !(profile.models ?? []).some(model => model.id === profile.model)) {
    profile = { ...profile, models: [{ id: profile.model, label: profile.model }, ...(profile.models ?? [])] };
  }
  const runtimeCommand = probe.runtime?.command ?? profile.command;
  const wrapper = probe.wrapper
    ? {
      mode: probe.wrapper.mode,
      id: probe.wrapper.id,
      version: probe.wrapper.version,
      transport: probe.wrapper.transport,
      installRequired: probe.wrapper.installRequired,
      available: probe.wrapper.available,
    }
    : null;
  return {
    id: profile.id,
    label: profile.label,
    provider: profile.provider,
    transport: profile.transport ?? (profile.driver === "codex-app-server" ? "codex-app-server-stdio" : profile.driver === "claude-cli-stream" ? "claude-cli-stream-json" : "acp-stdio"),
    source: profile.source,
    driver: profile.driver ?? "acp-stdio",
    description: profile.description,
    model: profile.model ?? null,
    reasoningEffort: profile.reasoningEffort ?? null,
    models: Array.isArray(profile.models) ? profile.models.map((model) => ({ id: String(model.id), label: String(model.label ?? model.id), ...(Array.isArray(model.reasoningEfforts) ? { reasoningEfforts: model.reasoningEfforts.map(String) } : {}) })) : [],
    reasoningEfforts: Array.isArray(profile.reasoningEfforts) ? profile.reasoningEfforts.map((effort) => String(effort)) : [],
    approvalPolicy: profile.approvalPolicy ?? null,
    permissionMode: profile.permissionMode ?? null,
    sandbox: profile.sandbox ?? null,
    availability: probe.availability,
    availabilityReason: probe.reason,
    wrapper,
    runtime: {
      // Do not expose an absolute executable path or environment values to the browser.
      command: path.isAbsolute(runtimeCommand) ? path.basename(runtimeCommand) : runtimeCommand,
      required: profile.requiresRuntime ?? runtimeCommand,
      available: probe.runtime?.available ?? false,
      installRequired: probe.runtime?.installRequired ?? false,
      version: probe.runtime?.version ?? null,
    },
    auth: probe.auth ?? { required: false, status: "not-required" },
    capabilities: probe.capabilities ?? (probe.availability === "ready" ? ["initialize", "session", "prompt", "stream", "cancel", "capability-negotiation"] : []),
  };
}

export class AgentProfileRegistry {
  config: AppConfig; nativeConfigs: NativeAgentConfigStore | null;
  profiles: Map<string, AgentProfile>; wrapperRegistry: ManagedWrapperRegistry;
  probes: Map<string, RuntimeProbe>; modelCatalogs: Map<string, { at: number; value: Promise<AgentModelCatalog> }>;
  constructor(config: AppConfig, { nativeConfigs = null }: { nativeConfigs?: NativeAgentConfigStore | null } = {}) {
    this.config = config;
    this.nativeConfigs = nativeConfigs;
    this.profiles = new Map((config.agentSessions?.profiles ?? []).map((profile) => [profile.id, Object.freeze({ ...(nativeConfigs?.effective(profile) ?? profile) })]));
    this.wrapperRegistry = new ManagedWrapperRegistry({ root: config.agentSessions.managedWrappersRoot });
    this.probes = new Map();
    this.modelCatalogs = new Map();
  }

  async descriptors({ refresh = false } = {}) {
    const result = [];
    for (const profile of this.profiles.values()) {
      const probe = await this.#probe(profile, { refresh });
      let described = profile;
      if (openCodeDriver(profile.driver) && probe.availability === "ready") {
        try {
          let catalog = this.modelCatalogs.get(profile.id);
          if (!catalog || Date.now() - catalog.at > 30_000 || (refresh && Date.now() - catalog.at > 1_000)) {
            catalog = { at: Date.now(), value: this.nativeConfigs ? this.nativeConfigs.snapshot(profile).then(profile => discoverOpenCodeModels(profile, this.config.project?.root ?? process.cwd())) : discoverOpenCodeModels(profile, this.config.project?.root ?? process.cwd()) };
            this.modelCatalogs.set(profile.id, catalog);
          }
          const discovered = await catalog.value;
          described = { ...profile, ...discovered, reasoningEffort: null };
        } catch {
          this.modelCatalogs.delete(profile.id);
          result.push(publicProfile(profile, { ...probe, availability: "unavailable", reason: "opencode_server_unavailable" }));
          continue;
        }
      }
      result.push(publicProfile(described, probe));
    }
    return result;
  }

  async get(profileId: string) {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new AppError("AGENT_PROFILE_NOT_FOUND", "没有找到指定的 Agent profile。", {
        status: 404,
        detail: { profileId },
      });
    }
    const probe = await this.#probe(profile, { refresh: true });
    if (probe.availability !== "ready") {
      const message = probe.availability === "needs-runtime"
        ? `${profile.label} 未找到所需 runtime（${profile.requiresRuntime ?? profile.runtimeCommand ?? profile.command}）。`
        : probe.availability === "needs-auth"
          ? `${profile.label} 已安装，但当前登录状态不可用。`
          : probe.availability === "incompatible"
            ? `${profile.label} 的 runtime 版本不兼容。`
            : `${profile.label} 当前不可用。`;
      throw new AppError("AGENT_PROFILE_UNAVAILABLE", message, {
        status: 503,
        detail: {
          profileId,
          availability: probe.availability,
          reason: probe.reason,
          runtime: {
            command: path.isAbsolute(probe.runtime?.command ?? "")
              ? path.basename(probe.runtime.command)
              : probe.runtime?.command,
            required: profile.requiresRuntime ?? probe.runtime?.command ?? profile.command,
            available: probe.runtime?.available ?? false,
            installRequired: probe.runtime?.installRequired ?? false,
            version: probe.runtime?.version ?? null,
          },
          auth: probe.auth ?? { required: false, status: "not-required" },
          wrapper: probe.wrapper
            ? {
              mode: probe.wrapper.mode,
              id: probe.wrapper.id,
              version: probe.wrapper.version,
              transport: probe.wrapper.transport,
              installRequired: probe.wrapper.installRequired,
              available: probe.wrapper.available,
            }
            : null,
        },
        retryable: true,
      });
    }
    return profile;
  }

  async createAdapter(profileId: string, options: AgentDriverOptions = {}): Promise<AgentAdapterContract> {
    const configured = this.profiles.get(profileId);
    if (configured) assertOpenCodeBinding(configured, options.expectedDriver);
    const base = await this.get(profileId);
    const profile = this.nativeConfigs ? await this.nativeConfigs.snapshot(base) : base;
    const invocation = this.wrapperRegistry.invocation(profile);
    const driverProfile = {
      ...profile,
      command: invocation.command,
      args: invocation.args,
      model: options.model ?? profile.model,
      reasoningEffort: options.reasoningEffort ?? profile.reasoningEffort,
    };
    const driverOptions = {
      cwd: this.config.project?.root,
      ...options,
    };
    if (profile.driver === "codex-app-server") return new CodexAgentAdapter(driverProfile, driverOptions);
    if (profile.driver === "claude-cli-stream") return new ClaudeCodeAgentAdapter(driverProfile, driverOptions);
    if (openCodeDriver(profile.driver)) return createOpenCodeAdapter(driverProfile, driverOptions);
    return new AcpProcessDriver(driverProfile, driverOptions);
  }

  applyUserSettings() {
    this.profiles = new Map((this.config.agentSessions?.profiles ?? []).map((profile) => [profile.id, Object.freeze({ ...(this.nativeConfigs?.effective(profile) ?? profile) })]));
    this.probes.clear();
    this.modelCatalogs.clear();
    this.wrapperRegistry.probeCache.clear();
  }

  async #probe(profile: AgentProfile, options: { refresh?: boolean } = {}): Promise<RuntimeProbe> {
    if (!options.refresh && this.probes.has(profile.id)) return this.probes.get(profile.id)!;
    let effective;
    try { effective = this.nativeConfigs ? await this.nativeConfigs.snapshot(profile) : profile; }
    catch { return { availability: "unavailable", reason: "native_configuration_invalid", runtime: { command: profile.command, available: false }, auth: { required: false, status: "unchecked" } }; }
    const probe = await this.wrapperRegistry.probe(openCodeVersionProfile(effective), options);
    this.probes.set(profile.id, probe);
    return probe;
  }
}
