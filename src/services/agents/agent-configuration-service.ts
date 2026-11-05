import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { buildResearchMcpBinding } from "../../agent/research-mcp-binding.js";
import { verifyResearchMcp } from "../../mcp/research-probe.js";
import { AppError } from "../../lib/errors.js";
import {
  discoverOpenCodeModels,
  resolveOpenCodeModelId,
} from "../../adapters/agents/opencode/opencode-server.js";
import { nativeFormats, parseNativeConfig, serializeNativeConfig } from "./configuration/native-format.js";

const modelPattern = /^[\p{L}\p{N}][\p{L}\p{N}._:/@+~-]{0,159}$/u;
const configurationSchema = z
  .strictObject({
    model: z.string().regex(modelPattern).optional(),
    makeDefault: z.literal(true).optional(),
  })
  .refine((value) => value.model !== undefined || value.makeDefault === true);
const checkSchema = z.union([
  z.strictObject({}),
  z.strictObject({ profileId: z.string().min(1).max(160) }),
  z.strictObject({ integration: z.literal(true) }),
]);
const unchecked = {
  status: "unchecked",
  detail: "尚未检查",
  checkedAt: null,
  recovery: null,
};

export class AgentConfigurationService {
  constructor({
    config,
    profileRegistry,
    userSettings,
    applySettings,
    discoverModels = discoverOpenCodeModels,
    nativeConfigs = null,
  }) {
    Object.assign(this, {
      config,
      profileRegistry,
      userSettings,
      applySettings,
      discoverModels,
      nativeConfigs,
    });
    this.results = new Map();
    this.catalogs = new Map();
    this.inFlight = new Map();
    this.generation = 0;
    this.configurationQueue = Promise.resolve();
  }

  profile(id) {
    const profile = this.profileRegistry.profiles.get(id);
    if (!profile)
      throw new AppError("AGENT_PROFILE_NOT_FOUND", "没有找到指定的 Agent。", {
        status: 404,
      });
    return profile;
  }

  inventory() {
    return {
      schemaVersion: "agent-configuration.v1",
      project: { id: this.config.project.id, name: this.config.project.name },
      agents: [...this.profileRegistry.profiles.values()].map((profile) => {
        const models = (
          this.catalogs.get(profile.id)?.models ??
          profile.models ??
          []
        ).map((model) => ({ id: model.id, label: model.label ?? model.id }));
        if (
          profile.model &&
          !models.some((model) => model.id === profile.model)
        )
          models.unshift({ id: profile.model, label: profile.model });
        return {
          id: profile.id,
          label: profile.label,
          provider: profile.provider,
          model: profile.model ?? "",
          models,
          isDefault:
            this.userSettings.settings.agent.defaultProfileId === profile.id,
          installed: null,
          version: null,
          authStatus: "unchecked",
          resolvedModel: null,
          nativeConfiguration: this.nativeConfigs && nativeFormats[profile.provider] ? { available: true, provider: profile.provider, filename: nativeFormats[profile.provider].filename } : null,
          ...unchecked,
          ...this.results.get(profile.id),
        };
      }),
      integration: {
        id: "research-mcp",
        label: "科研 MCP",
        ...unchecked,
        ...this.results.get("@integration"),
      },
    };
  }

  invalidate(profileIds = [...this.profileRegistry.profiles.keys()]) {
    this.generation++;
    for (const id of profileIds) {
      this.catalogs.delete(id);
      this.results.delete(id);
    }
  }

  async configure(id, input) {
    this.profile(id);
    const parsed = configurationSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        "AGENT_CONFIGURATION_INVALID",
        "请输入有效的默认模型，或选择默认 Agent。",
        { status: 422 },
      );
    const update = async () => {
      const profile = this.profile(id);
      let model = parsed.data.model;
      if (model && profile.driver === "opencode-server") {
        const configuredProfile = this.nativeConfigs ? await this.nativeConfigs.snapshot(profile) : profile;
        const catalog = await this.discoverModels(
          { ...configuredProfile, model: undefined },
          this.config.project.root,
        );
        model = resolveOpenCodeModelId(catalog.models, model);
      }
      const agent = {
        ...(model ? { profileModels: { [id]: model } } : {}),
        ...(parsed.data.makeDefault ? { defaultProfileId: id } : {}),
      };
      if (model && this.nativeConfigs) {
        const doc = await this.nativeConfigs.read(profile.provider);
        if (doc.error) throw doc.error;
        await this.nativeConfigs.save(profile.provider, serializeNativeConfig(profile.provider, { ...doc.parsed, model }), doc.revision);
      }
      const updated = await this.userSettings.update({ agent });
      await this.applySettings(updated.settings);
      if (model && model !== profile.model) this.invalidate([id]);
      return this.inventory();
    };
    const pending = this.configurationQueue.then(update);
    this.configurationQueue = pending.catch(() => {});
    return pending;
  }

  configurationDocument(id) { return this.nativeConfigs.document(this.profile(id).provider); }
  async saveConfigurationDocument(id, input) {
    const parsed = z.strictObject({ content: z.string().max(524288), expectedRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).safeParse(input);
    if (!parsed.success) throw new AppError("AGENT_NATIVE_CONFIG_INVALID", "请提供配置正文和当前修订。", { status: 422 });
    const operation = this.configurationQueue.then(async () => {
      const profile = this.profile(id);
      parseNativeConfig(profile.provider, parsed.data.content);
      const doc = await this.nativeConfigs.save(profile.provider, parsed.data.content, parsed.data.expectedRevision);
      this.profileRegistry.applyUserSettings();
      this.invalidate([...this.profileRegistry.profiles.values()].filter(item => item.provider === profile.provider).map(item => item.id));
      return doc;
    });
    this.configurationQueue = operation.catch(() => {}); return operation;
  }
  async check(input = {}, scope = {}) {
    const parsed = checkSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        "AGENT_CHECK_INVALID",
        "请选择有效的 Agent 或科研接口检查。",
        { status: 422 },
      );
    const selected =
      "profileId" in parsed.data
        ? [this.profile(parsed.data.profileId).id]
        : "integration" in parsed.data
          ? ["@integration"]
          : [...this.profileRegistry.profiles.keys(), "@integration"];
    const generation = this.generation;
    await Promise.all(
      selected.map((id) => {
        const key = `${generation}:${id}:${id === "@integration" ? scope.actor?.user?.id ?? "none" : "runtime"}`;
        if (this.inFlight.has(key)) return this.inFlight.get(key);
        const pending = this.probe(id, scope)
          .then(({ catalog, ...result }) => {
            if (this.generation === generation) {
              this.results.set(id, {
                ...result,
                checkedAt: new Date().toISOString(),
              });
              if (catalog) this.catalogs.set(id, catalog);
            }
          })
          .finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, pending);
        return pending;
      }),
    );
    return this.inventory();
  }

  async probe(id, scope = {}) {
    let runtimeResult = {};
    try {
      if (id === "@integration") {
        if (!scope.actor || !scope.collaboration || !scope.baseUrl) throw new Error("科研 MCP 检查需要当前用户与项目授权。");
        const runtimeInstanceId = `probe_${randomUUID()}`;
        try {
          const sessionToken = scope.collaboration.issueAgentCredential(scope.actor, this.config.project.id, runtimeInstanceId, { readOnly: true });
          const checked = await verifyResearchMcp(buildResearchMcpBinding({ baseUrl: scope.baseUrl, projectId: this.config.project.id, sessionToken, cwd: this.config.project.root }));
          return { ...checked, status: "ready", detail: `科研 MCP 握手、授权与 CLI 往返通过；${checked.toolCount} 个工具，使用只读凭据探测。`, recovery: null };
        } finally { scope.collaboration.revokeAgentCredential(runtimeInstanceId); }
      }
      const original = this.profile(id);
      const profile = this.nativeConfigs ? await this.nativeConfigs.snapshot(original) : original;
      const probe = await this.profileRegistry.wrapperRegistry.probe(profile, {
        refresh: true,
      });
      const result = {
        installed: Boolean(probe.runtime?.available),
        version: probe.runtime?.version ?? null,
        authStatus: probe.auth?.status ?? "unchecked",
        resolvedModel: null,
      };
      runtimeResult = result;
      if (probe.availability !== "ready")
        return {
          ...result,
          status: "unavailable",
          detail:
            probe.availability === "needs-auth"
              ? "已安装，尚未完成登录或 Provider 认证。"
              : probe.availability === "incompatible"
                ? "已安装的版本不满足运行要求。"
                : "未找到可用的本机 Agent 运行时。",
          recovery:
            probe.availability === "needs-auth"
              ? "在本机完成该 Agent 的登录或 Provider 认证后重新检查。"
              : "检查该 Agent 的安装、版本和本机配置。",
        };
      if (profile.driver === "opencode-server") {
        const catalog = await this.discoverModels(
          { ...profile, model: undefined },
          this.config.project.root,
        );
        const resolvedModel = profile.model
          ? resolveOpenCodeModelId(catalog.models, profile.model)
          : catalog.model;
        if (!resolvedModel) throw new Error("OpenCode 尚未配置可用模型。");
        return {
          ...result,
          resolvedModel,
          catalog,
          status: "ready",
          detail: "运行时与模型配置检查通过。",
          recovery: null,
        };
      }
      return {
        ...result,
        status: "ready",
        detail: "运行时与认证检查通过。",
        recovery: null,
      };
    } catch (error) {
      return {
        ...runtimeResult,
        status: "unavailable",
        detail: String(error.message)
          .replace(/rw_agent_[A-Za-z0-9_-]+/g, "[redacted]")
          .slice(0, 260),
        recovery:
          id === "@integration"
            ? "检查当前用户授权，并重新构建 MCP 与 CLI 的分发文件。"
            : "检查本机 Agent、Provider 和模型配置后重试。",
      };
    }
  }
}
