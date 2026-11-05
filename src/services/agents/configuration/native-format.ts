import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { AppError } from "../../../lib/errors.js";

export const nativeFormats = {
  codex: {
    filename: "config.toml",
    format: "toml",
    schemaUrl: "https://developers.openai.com/codex/config-schema.json",
    docsUrl: "https://developers.openai.com/codex/config-reference/",
  },
  claude: {
    filename: "settings.json",
    format: "json",
    schemaUrl: "https://json.schemastore.org/claude-code-settings.json",
    docsUrl: "https://code.claude.com/docs/en/settings",
  },
  opencode: {
    filename: "opencode.jsonc",
    format: "jsonc",
    schemaUrl: "https://opencode.ai/config.json",
    docsUrl: "https://opencode.ai/docs/config/",
  },
};
const invalid = (message, detail = null) => {
  throw new AppError("AGENT_NATIVE_CONFIG_INVALID", message, {
    status: 422,
    detail,
  });
};
function validateTree(value, depth = 0) {
  if (depth > 32) invalid("配置嵌套不能超过 32 层。");
  if (typeof value === "number" && !Number.isFinite(value))
    invalid("配置中的数值必须是有限数。");
  if (Array.isArray(value)) {
    for (const item of value) validateTree(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object" || value instanceof Date) return;
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      invalid("配置字段名无效。");
    validateTree(item, depth + 1);
  }
}
export function parseNativeConfig(provider, content) {
  if (!nativeFormats[provider]) invalid("未知的 Agent 配置格式。");
  if (typeof content !== "string" || Buffer.byteLength(content) > 524288)
    invalid("配置文件须为不超过 512 KiB 的文本。");
  let value;
  if (provider === "codex") {
    try {
      value = parseToml(content.replace(/^\uFEFF/, ""));
    } catch (error) {
      invalid("TOML 语法无效，请检查标记位置。", {
        line: error.line ?? null,
        column: error.column ?? null,
      });
    }
  } else {
    const errors = [];
    value = parseJsonc(content.replace(/^\uFEFF/, ""), errors, {
      allowTrailingComma: provider === "opencode",
      disallowComments: provider !== "opencode",
      allowEmptyContent: false,
    });
    if (errors.length) {
      const error = errors[0],
        prefix = content.slice(0, error.offset),
        lines = prefix.split(/\r?\n/);
      invalid("JSON 配置语法无效，请检查标记位置。", {
        line: lines.length,
        column: lines.at(-1).length + 1,
        code: printParseErrorCode(error.error),
      });
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("配置根节点必须是对象。");
  validateTree(value);
  for (const key of ["model", "model_provider", "model_reasoning_effort"])
    if (value[key] !== undefined && typeof value[key] !== "string")
      invalid(`${key} 必须是字符串。`, { path: key });
  if (
    value.model !== undefined &&
    (!value.model.trim() || value.model.length > 160)
  )
    invalid("model 必须为 1–160 字符的模型标识。", { path: "model" });
  if (provider === "claude" && value.permissions !== undefined) {
    if (
      !value.permissions ||
      typeof value.permissions !== "object" ||
      Array.isArray(value.permissions)
    )
      invalid("permissions 必须是对象。", { path: "permissions" });
    for (const key of ["allow", "deny", "ask"])
      if (
        value.permissions[key] !== undefined &&
        (!Array.isArray(value.permissions[key]) ||
          value.permissions[key].some((rule) => typeof rule !== "string"))
      )
        invalid(`permissions.${key} 必须是字符串数组。`, {
          path: `permissions.${key}`,
        });
  }
  return value;
}
export function serializeNativeConfig(provider, value) {
  return provider === "codex"
    ? stringifyToml(value)
    : JSON.stringify(value, null, 2) + "\n";
}
export function nativeProfile(profile, config) {
  const result = { ...profile };
  result.model = config.model;
  if (profile.provider === "codex") {
    result.reasoningEffort = config.model_reasoning_effort;
    result.approvalPolicy = config.approval_policy;
    result.sandbox = config.sandbox_mode;
  } else if (profile.provider === "claude") {
    result.reasoningEffort = config.effortLevel;
    result.permissionMode = config.permissions?.defaultMode;
  }
  return result;
}
export function initialNativeConfig(profile) {
  const common = profile.model ? { model: profile.model } : {};
  if (profile.provider === "codex")
    return {
      ...common,
      model_reasoning_effort: profile.reasoningEffort ?? "low",
      approval_policy: profile.approvalPolicy ?? "on-request",
      sandbox_mode: profile.sandbox ?? "workspace-write",
    };
  if (profile.provider === "claude")
    return {
      ...common,
      effortLevel: profile.reasoningEffort ?? "low",
      permissions: { defaultMode: profile.permissionMode ?? "default" },
    };
  return {
    $schema: nativeFormats.opencode.schemaUrl,
    ...common,
    permission: profile.approvalPolicy === "never" ? "allow" : "ask",
  };
}
export function tomlValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${tomlValue(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function codexConfigurationArgs(config = {}) {
  return Object.entries(config)
    .filter(([key]) => key !== "$schema")
    .flatMap(([key, value]) => ["-c", `${key}=${tomlValue(value)}`]);
}
