import type { ReactNode } from "react";
import { AutocompleteInput } from "@/shared/ui/AutocompleteInput";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import type { ConfiguredAgent } from "./AgentConfigurationPage";
import { openCodeV1PermissionValue } from "./opencode/v1/permissions";
import { openCodeV2PermissionValue } from "./opencode/v2/permissions";

export function CommonAgentSettings({
  agent,
  value,
  update,
  en,
  configKey,
}: {
  agent: ConfiguredAgent;
  value: Record<string, any>;
  update: (path: string[], value: any) => void;
  en: boolean;
  configKey?: string;
}) {
  const effortKey =
    agent.provider === "codex" ? "model_reasoning_effort" : "effortLevel";
  const modelValue = typeof value.model === "string" ? value.model
    : configKey === "opencode-v2" && value.model && typeof value.model.providerID === "string" && typeof value.model.model === "string"
      ? `${value.model.providerID}/${value.model.model}${value.model.variant ? `#${value.model.variant}` : ""}` : "";
  return (
    <div className="native-settings-list">
      <SettingRow label={en ? "Default model" : "默认模型"}>
        <AutocompleteInput
          ariaLabel={en ? "Default model" : "默认模型"}
          suggestionsLabel={en ? "Show model suggestions" : "显示模型建议"}
          placeholder={en ? "Use default model" : "使用默认模型"}
          options={agent.models.map((model) => ({
            value: model.id,
            label: model.label,
          }))}
          value={modelValue}
          onChange={(model) => update(["model"], model || undefined)}
          maxLength={160}
        />
      </SettingRow>
      {agent.provider !== "opencode" && (
        <SettingRow label={en ? "Reasoning effort" : "推理强度"}>
          <ConfigChoice
            label={en ? "Reasoning effort" : "推理强度"}
            value={value[effortKey]}
            onChange={(item) => update([effortKey], item)}
            en={en}
            choices={Object.entries({
              minimal: ["最低", "Minimal"],
              low: ["低", "Low"],
              medium: ["中", "Medium"],
              high: ["高", "High"],
              xhigh: ["很高", "Very high"],
            })
              .filter(
                ([key]) =>
                  agent.provider === "codex" ||
                  ["low", "medium", "high", "xhigh"].includes(key),
              )
              .map(([value, labels]) => ({ value, label: labels[en ? 1 : 0] }))}
          />
        </SettingRow>
      )}
      {agent.provider === "codex" && (
        <>
          <SettingRow label={en ? "Approvals" : "审批方式"}>
            <ConfigChoice
              label={en ? "Approvals" : "审批方式"}
              en={en}
              value={value.approval_policy}
              onChange={(item) => update(["approval_policy"], item)}
              choices={[
                {
                  value: "on-request",
                  label: en ? "Ask when needed" : "按需询问",
                },
                { value: "never", label: en ? "Do not ask" : "不询问" },
              ]}
            />
          </SettingRow>
          <SettingRow label={en ? "File access" : "文件访问"}>
            <ConfigChoice
              label={en ? "File access" : "文件访问"}
              en={en}
              value={
                value.default_permissions
                  ? { profile: value.default_permissions }
                  : value.sandbox_mode
              }
              onChange={(item) => update(["sandbox_mode"], item)}
              choices={[
                { value: "read-only", label: en ? "Read only" : "只读" },
                {
                  value: "workspace-write",
                  label: en ? "Project files" : "项目文件可写",
                },
                {
                  value: "danger-full-access",
                  label: en ? "Full access" : "全部文件可访问",
                },
              ]}
            />
          </SettingRow>
          <details className="native-settings-advanced">
            <summary>
              {en ? "Codex advanced settings" : "Codex 高级设置"}
            </summary>
            <div className="native-settings-advanced-body">
              <NumberSetting
                label={en ? "Context window" : "上下文窗口"}
                ariaLabel={en ? "Context window" : "上下文窗口"}
                value={value.model_context_window}
                onChange={(item) => update(["model_context_window"], item)}
                unit={en ? "tokens" : "tokens"}
                min={1}
              />
              <NumberSetting
                label={en ? "Auto-compaction threshold" : "自动压缩阈值"}
                ariaLabel={en ? "Auto-compaction threshold" : "自动压缩阈值"}
                value={value.model_auto_compact_token_limit}
                onChange={(item) =>
                  update(["model_auto_compact_token_limit"], item)
                }
                unit={en ? "tokens" : "tokens"}
                min={0}
              />
            </div>
          </details>
        </>
      )}
      {agent.provider === "claude" && (
        <SettingRow label={en ? "Permissions" : "权限模式"}>
          <ConfigChoice
            label={en ? "Permissions" : "权限模式"}
            en={en}
            value={value.permissions?.defaultMode}
            onChange={(item) => update(["permissions", "defaultMode"], item)}
            choices={[
              { value: "default", label: en ? "Ask as needed" : "按需确认" },
              {
                value: "acceptEdits",
                label: en ? "Allow file edits" : "自动允许文件编辑",
              },
              { value: "plan", label: en ? "Plan only" : "仅规划" },
              { value: "dontAsk", label: en ? "Do not ask" : "不询问" },
              {
                value: "bypassPermissions",
                label: en ? "Skip permission checks" : "跳过权限检查",
              },
              { value: "auto", label: en ? "Automatic review" : "自动审查" },
            ]}
          />
        </SettingRow>
      )}
      {agent.provider === "opencode" && (
        <SettingRow label={en ? "Tool permissions" : "工具权限"}>
          <ConfigChoice
            label={en ? "Tool permissions" : "工具权限"}
            en={en}
            value={configKey === "opencode-v2" ? openCodeV2PermissionValue(value) : openCodeV1PermissionValue(value)}
            onChange={(item) => update(["permission"], item)}
            choices={[
              { value: "ask", label: en ? "Ask before use" : "调用前确认" },
              { value: "allow", label: en ? "Allow" : "自动允许" },
              { value: "deny", label: en ? "Deny" : "禁止调用" },
            ]}
          />
        </SettingRow>
      )}
    </div>
  );
}

function SettingRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="native-setting-row">
      <span className="native-setting-label">{label}</span>
      <div className="native-setting-control">{children}</div>
    </div>
  );
}

function NumberSetting({
  label,
  ariaLabel,
  value,
  onChange,
  unit,
  min,
}: {
  label: string;
  ariaLabel: string;
  value: any;
  onChange: (value: number | undefined) => void;
  unit: string;
  min?: number;
}) {
  return (
    <div className="native-number-row">
      <label htmlFor={ariaLabel}>{label}</label>
      <div className="native-number-control">
        <input
          id={ariaLabel}
          aria-label={ariaLabel}
          type="number"
          inputMode="numeric"
          min={min}
          step="1"
          value={
            typeof value === "number" && Number.isFinite(value) ? value : ""
          }
          placeholder="跟随默认"
          onChange={(event) => {
            const raw = event.target.value;
            const next = raw === "" ? undefined : Number(raw);
            onChange(
              next === undefined || Number.isFinite(next) ? next : undefined,
            );
          }}
        />
        <span>{unit}</span>
      </div>
    </div>
  );
}

function ConfigChoice({
  label,
  value,
  onChange,
  choices,
  en,
}: {
  label: string;
  value: any;
  onChange: (value: any) => void;
  choices: Array<{ value: string; label: string }>;
  en: boolean;
}) {
  const complex = value !== null && typeof value === "object";
  const selected =
    value === undefined ? "@default" : complex ? "@custom" : String(value);
  const options = [
    { value: "@default", label: en ? "Use default" : "跟随默认" },
    ...choices,
  ];
  if (complex)
    options.push({
      value: "@custom",
      label: en ? "Custom rules" : "自定义规则",
    });
  else if (
    value !== undefined &&
    !choices.some((item) => item.value === selected)
  )
    options.push({ value: selected, label: selected });
  return (
    <SelectMenu
      ariaLabel={label}
      value={selected}
      options={options}
      onChange={(item) => {
        if (item !== "@custom")
          onChange(item === "@default" ? undefined : item);
      }}
    />
  );
}
