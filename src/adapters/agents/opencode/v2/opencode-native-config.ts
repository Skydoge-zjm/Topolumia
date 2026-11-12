import type { AgentProfile, NativeConfig, NativePermissionRule } from "../../../../domain/agents/agent-types.js";
import { AppError } from "../../../../lib/errors.js";

export const openCodeV2Format = {
  filename: "opencode.jsonc", format: "jsonc", schemaFile: "opencode/v2.json",
  schemaUrl: "https://opencode.ai/config.json", docsUrl: "https://opencode.ai/docs/config/",
};

export function initialOpenCodeV2Config(profile: AgentProfile): NativeConfig {
  const effect = profile.approvalPolicy === "never" ? "allow" : "ask";
  return { $schema: openCodeV2Format.schemaUrl, ...(profile.model ? { model: profile.model } : {}),
    permissions: [{ action: "*", resource: "*", effect },
      ...["read", "glob", "grep", "list"].map(action => ({ action, resource: "*", effect: "allow" as const })),
      { action: "external_directory", resource: "*", effect: "ask" }] };
}

export function validateOpenCodeV2Config(config: NativeConfig): void {
  const model: unknown = config.model;
  if (model !== undefined && typeof model !== "string" && (!model || typeof model !== "object" || Array.isArray(model) ||
    !("providerID" in model) || typeof model.providerID !== "string" || !model.providerID ||
    !("model" in model) || typeof model.model !== "string" || !model.model ||
    ("variant" in model && typeof model.variant !== "string"))) {
    throw new AppError("AGENT_NATIVE_CONFIG_INVALID", "OpenCode 2 model 必须为模型标识或 providerID/model/variant 对象。", { status: 422 });
  }
  if (config.permissions !== undefined && (!Array.isArray(config.permissions) || config.permissions.some(rule =>
    !rule || typeof rule.action !== "string" || typeof rule.resource !== "string" || !["allow", "deny", "ask"].includes(rule.effect)))) {
    throw new AppError("AGENT_NATIVE_CONFIG_INVALID", "OpenCode 2 permissions 必须为 action/resource/effect 规则数组。", { status: 422 });
  }
}

export function openCodeV2Model(config: NativeConfig): { model?: string; reasoningEffort?: string } {
  const value: unknown = config.model;
  if (typeof value === "string") {
    const split = value.lastIndexOf("#");
    return split < 0 ? { model: value } : { model: value.slice(0, split), reasoningEffort: value.slice(split + 1) };
  }
  if (value && typeof value === "object" && "providerID" in value && "model" in value &&
    typeof value.providerID === "string" && typeof value.model === "string") {
    return { model: `${value.providerID}/${value.model}`, reasoningEffort: "variant" in value && typeof value.variant === "string" ? value.variant : undefined };
  }
  return {};
}

export function openCodeV2Rules(config?: NativeConfig): NativePermissionRule[] {
  return Array.isArray(config?.permissions) ? config.permissions : [];
}
