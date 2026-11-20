import { useId, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { api, projectId, ApiClientError } from "@/shared/lib/api";
import { copyText } from "@/shared/lib/copyText";
import { AutocompleteInput } from "@/shared/ui/AutocompleteInput";
import { CommonAgentSettings } from "./CommonAgentSettings";
import {
  parseConfig,
  updateConfigSource,
  setConfigPath,
} from "./nativeConfigModel";
import type { NativeConfigDocument } from "./nativeConfigModel";
import type { ConfiguredAgent } from "./AgentConfigurationPage";
import { setOpenCodeV1Permission } from "./opencode/v1/permissions";
import { setOpenCodeV2Permission } from "./opencode/v2/permissions";
import { useEditorActivity } from "./useEditorActivity";
import styles from "./AgentConfigurationPage.module.css";

function configUrl(id: string) {
  return (
    "/api/agent-configuration/profiles/" +
    encodeURIComponent(id) +
    "/native-config"
  );
}

type EditorProps = {
  agent: ConfiguredAgent;
  en: boolean;
  disabled: boolean;
  defaultControl?: ReactNode;
  onActivity: (state: { dirty: boolean; busy: boolean }) => void;
  onSaved: () => void;
};

export function NativeAgentConfigEditor(props: EditorProps) {
  const project = projectId();
  const url = configUrl(props.agent.id);
  const queryKey = ["agent-native-config", project, props.agent.id];
  const query = useQuery({
    queryKey,
    queryFn: () =>
      api<NativeConfigDocument>(url, {
        headers: { "x-rw-project-id": project },
      }),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (query.isPending)
    return (
      <div className={styles.loading} role="status">
        {props.en ? "Reading configuration…" : "读取配置…"}
      </div>
    );
  if (!query.data)
    return (
      <div className={styles.error} role="alert">
        {query.error?.message}
        <button
          type="button"
          className="button"
          onClick={() => void query.refetch()}
        >
          {props.en ? "Retry" : "重试"}
        </button>
      </div>
    );
  return (
    <NativeConfigForm
      {...props}
      document={query.data}
      project={project}
      url={url}
      queryKey={queryKey}
    />
  );
}

type FieldDraft = { name: string; text: string; error: string };

function NativeConfigForm({
  document,
  project,
  url,
  queryKey,
  agent,
  en,
  disabled,
  defaultControl,
  onActivity,
  onSaved,
}: EditorProps & {
  document: NativeConfigDocument;
  project: string;
  url: string;
  queryKey: string[];
}) {
  const client = useQueryClient();
  const sourceId = useId();
  // Keep the revision used to start this draft even if a shared cache entry refreshes.
  const [initial, setInitial] = useState(document);
  const [source, setSource] = useState(document.content);
  const [mode, setMode] = useState("common");
  const [emptyModelSelected, setEmptyModelSelected] = useState(false);
  const [field, setField] = useState<FieldDraft | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const dirty =
    source !== initial.content || emptyModelSelected || Boolean(field?.error);
  const busy = saving || reloading;
  useEditorActivity(dirty, busy, onActivity);

  const parsed = useMemo(() => {
    try {
      return { value: parseConfig(agent.provider, source), error: "" };
    } catch (problem) {
      return { value: null, error: (problem as Error).message };
    }
  }, [agent.provider, source]);
  const model = parsed.value?.model;
  const modelLabel =
    typeof model === "string"
      ? model
      : initial.configKey === "opencode-v2" &&
          model &&
          typeof model.providerID === "string" &&
          typeof model.model === "string"
        ? model.providerID +
          "/" +
          model.model +
          (model.variant ? "#" + model.variant : "")
        : "";
  const specifyModel = Boolean(modelLabel) || emptyModelSelected;
  const invalid = Boolean(
    parsed.error || field?.error || (specifyModel && !modelLabel.trim()),
  );

  const apply = (path: string[], item: unknown, common = false) => {
    if (!parsed.value) return;
    let next = setConfigPath(parsed.value, path, item);
    if (common && agent.provider === "codex" && path[0] === "sandbox_mode")
      next = setConfigPath(next, ["default_permissions"], undefined);
    if (common && agent.provider === "opencode" && path[0] === "permission")
      next = (
        initial.configKey === "opencode-v2"
          ? setOpenCodeV2Permission
          : setOpenCodeV1Permission
      )(parsed.value, item);
    setSource(updateConfigSource(agent.provider, source, parsed.value, next));
    setError("");
  };
  const reset = (next = initial) => {
    setInitial(next);
    setSource(next.content);
    setField(null);
    setEmptyModelSelected(false);
    setError("");
  };
  const updateCommon = (path: string[], item: unknown) => {
    try {
      apply(path, item, true);
    } catch (problem) {
      setError((problem as Error).message);
    }
  };

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (!dirty || invalid || busy || disabled) return;
        setSaving(true);
        setError("");
        try {
          const saved = await api<NativeConfigDocument>(url, {
            method: "PUT",
            headers: { "x-rw-project-id": project },
            body: JSON.stringify({
              content: source,
              expectedRevision: initial.revision,
            }),
          });
          client.setQueryData(queryKey, saved);
          reset(saved);
          onSaved();
        } catch (problem) {
          const detail =
            problem instanceof ApiClientError
              ? (problem.detail as { line?: number; column?: number } | null)
              : null;
          setError(
            (problem as Error).message +
              (detail?.line
                ? " " + detail.line + ":" + (detail.column ?? 1)
                : ""),
          );
        } finally {
          setSaving(false);
        }
      }}
    >
      <Tabs.Root
        value={mode}
        onValueChange={(next) => {
          if (!field?.error) setField(null);
          setMode(next);
        }}
      >
        <Tabs.List
          className={styles.modes}
          aria-label={en ? "Configuration mode" : "配置模式"}
        >
          <Tabs.Trigger className={styles.mode} value="common">
            {en ? "Common settings" : "常用设置"}
          </Tabs.Trigger>
          <Tabs.Trigger className={styles.mode} value="fields">
            {en ? "All settings" : "完整配置项"}
          </Tabs.Trigger>
          <Tabs.Trigger className={styles.mode} value="source">
            {en ? "Native file" : "原生文件"}{" "}
            <code className={styles.filename}>{initial.filename}</code>
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="common">
          {defaultControl}
          <fieldset
            className={styles.fields}
            disabled={busy || disabled || Boolean(field?.error || parsed.error)}
            aria-label={en ? "Common settings" : "常用设置"}
          >
            <div className={styles.settingRow}>
              <span>{en ? "Default model" : "默认模型"}</span>
              <div
                className={styles.modelOptions}
                role="group"
                aria-label={en ? "Default model mode" : "默认模型模式"}
              >
                <label>
                  <input
                    type="radio"
                    name={sourceId + "-model"}
                    checked={!specifyModel}
                    onChange={() => {
                      setEmptyModelSelected(false);
                      updateCommon(["model"], undefined);
                    }}
                  />
                  {en
                    ? "Follow the local runtime default"
                    : "跟随本机运行时默认值"}
                </label>
                <label>
                  <input
                    type="radio"
                    name={sourceId + "-model"}
                    checked={specifyModel}
                    onChange={() => setEmptyModelSelected(true)}
                  />
                  {en ? "Specify a model" : "指定模型"}
                </label>
                {specifyModel && (
                  <AutocompleteInput
                    ariaLabel={en ? "Default model" : "默认模型"}
                    suggestionsLabel={
                      en ? "Show model suggestions" : "显示模型建议"
                    }
                    options={agent.models.map((option) => ({
                      value: option.id,
                      label: option.label,
                    }))}
                    value={modelLabel}
                    maxLength={160}
                    disabled={
                      busy || disabled || Boolean(parsed.error || field?.error)
                    }
                    onChange={(value) => {
                      setEmptyModelSelected(!value.trim());
                      updateCommon(["model"], value || undefined);
                    }}
                  />
                )}
              </div>
            </div>
            <ConfigPath path={initial.path} en={en} />
            <CommonAgentSettings
              agent={agent}
              configKey={initial.configKey}
              en={en}
              value={parsed.value ?? {}}
              update={updateCommon}
            />
          </fieldset>
        </Tabs.Content>
        <Tabs.Content value="fields" className={styles.editorPane}>
          {parsed.value && (
            <FullSettings
              en={en}
              value={parsed.value}
              schema={initial.schema}
              field={field}
              disabled={busy || disabled}
              onSelect={() => setField(null)}
              onChange={(name, text) => {
                try {
                  apply([name], text.trim() ? JSON.parse(text) : undefined);
                  setField({ name, text, error: "" });
                  setEmptyModelSelected(false);
                } catch (problem) {
                  setField({ name, text, error: (problem as Error).message });
                }
              }}
            />
          )}
        </Tabs.Content>
        <Tabs.Content value="source" className={styles.editorPane}>
          <div className={styles.sourceHeader}>
            <label htmlFor={sourceId}>
              <code className={styles.filename}>{initial.filename}</code>
            </label>
            <a href={initial.docsUrl} target="_blank" rel="noopener noreferrer">
              {en ? "Configuration reference" : "配置参考"}
              <ArrowUpRight size={13} aria-hidden="true" />
            </a>
          </div>
          <textarea
            id={sourceId}
            className={styles.source}
            aria-label={en ? "Configuration file content" : "配置文件内容"}
            aria-invalid={Boolean(parsed.error)}
            value={source}
            disabled={busy || disabled}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => {
              setSource(event.target.value);
              setEmptyModelSelected(false);
              setField(null);
              setError("");
            }}
          />
        </Tabs.Content>
      </Tabs.Root>
      {parsed.error && (
        <p className={styles.formError} role="alert">
          {en ? "Check the configuration syntax: " : "请检查配置语法："}
          {parsed.error}
          {mode !== "source" && (
            <button
              type="button"
              className="button"
              onClick={() => setMode("source")}
            >
              {en ? "Edit native file" : "编辑原生文件"}
            </button>
          )}
        </p>
      )}
      {field?.error && (
        <p className={styles.formError} role="alert">
          {field.name} · {field.error}
        </p>
      )}
      {error && (
        <div className={styles.formError} role="alert">
          {error}
          <button
            type="button"
            className="button"
            disabled={busy || disabled}
            onClick={async () => {
              if (
                dirty &&
                !window.confirm(
                  en ? "Reload and discard changes?" : "重新载入并放弃修改？",
                )
              )
                return;
              setReloading(true);
              try {
                const next = await api<NativeConfigDocument>(url, {
                  headers: { "x-rw-project-id": project },
                });
                client.setQueryData(queryKey, next);
                reset(next);
              } catch (problem) {
                setError((problem as Error).message);
              } finally {
                setReloading(false);
              }
            }}
          >
            {en ? "Reload" : "重新载入"}
          </button>
        </div>
      )}
      {source === initial.content && initial.validation && !parsed.error && (
        <p className={styles.formError} role="alert">
          {initial.validation.message}
        </p>
      )}
      <FormActions
        en={en}
        dirty={dirty}
        invalid={invalid}
        disabled={busy || disabled}
        saving={saving}
        reset={() => reset()}
      />
    </form>
  );
}

function ConfigPath({ en, path }: { en: boolean; path: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const feedback = {
    idle: "",
    copied: en ? "Copied" : "已复制",
    failed: en ? "Copy failed" : "复制失败",
  }[status];
  return (
    <div className={styles.settingRow}>
      <span>{en ? "Configuration path" : "配置文件路径"}</span>
      <div className={styles.pathControl}>
        <code title={path}>{path}</code>
        <button
          type="button"
          className="button"
          aria-label={en ? "Copy configuration path" : "复制配置文件路径"}
          onClick={() => {
            void copyText(path).then(
              () => setStatus("copied"),
              () => setStatus("failed"),
            );
          }}
        >
          {status === "copied" ? (
            <Check size={14} aria-hidden="true" />
          ) : (
            <Copy size={14} aria-hidden="true" />
          )}
          {feedback || (en ? "Copy" : "复制")}
        </button>
        <span className="visually-hidden" role="status">
          {feedback}
        </span>
      </div>
    </div>
  );
}

function FullSettings({
  en,
  value,
  schema,
  field,
  disabled,
  onSelect,
  onChange,
}: {
  en: boolean;
  value: Record<string, unknown>;
  schema: NativeConfigDocument["schema"];
  field: FieldDraft | null;
  disabled: boolean;
  onSelect: () => void;
  onChange: (name: string, text: string) => void;
}) {
  const fields = Object.keys({ ...schema.properties, ...value })
    .filter((name) => !["__proto__", "prototype", "constructor"].includes(name))
    .sort((a, b) => a.localeCompare(b));
  const [selected, setSelected] = useState("");
  const name =
    field?.name ||
    (fields.includes(selected)
      ? selected
      : fields.includes("model")
        ? "model"
        : fields[0]);
  const description = schema.properties?.[name]?.description;
  if (!name)
    return (
      <p className={styles.loading}>
        {en ? "No configuration fields available." : "暂无可编辑配置项。"}
      </p>
    );
  return (
    <div className={styles.fullSettings}>
      <div className={styles.settingRow}>
        <span>{en ? "Configuration field" : "配置字段"}</span>
        <select
          className={styles.settingControl}
          aria-label={en ? "Configuration field" : "配置字段"}
          value={name}
          disabled={disabled || Boolean(field?.error)}
          onChange={(event) => {
            setSelected(event.target.value);
            onSelect();
          }}
        >
          {fields.map((key) => (
            <option key={key} value={key}>
              {key}
              {Object.hasOwn(value, key) ? (en ? " · Set" : " · 已设置") : ""}
            </option>
          ))}
        </select>
      </div>
      {typeof description === "string" && (
        <p className={styles.fieldDescription}>{description}</p>
      )}
      <div className={styles.sourceHeader}>
        <code className={styles.filename}>{name}</code>
        <button
          type="button"
          className="button"
          disabled={disabled || (!Object.hasOwn(value, name) && !field?.error)}
          onClick={() => onChange(name, "")}
        >
          {en ? "Unset field" : "清除字段"}
        </button>
      </div>
      <textarea
        className={styles.fieldSource}
        aria-label={en ? "Field value (JSON)" : "字段值（JSON）"}
        aria-invalid={Boolean(field?.error)}
        value={field?.text ?? JSON.stringify(value[name], null, 2) ?? ""}
        placeholder={en ? "Enter a JSON value" : "输入 JSON 值"}
        spellCheck={false}
        disabled={disabled}
        onChange={(event) => onChange(name, event.target.value)}
      />
    </div>
  );
}

export function FormActions({
  en,
  dirty,
  disabled,
  invalid,
  saving,
  reset,
}: {
  en: boolean;
  dirty: boolean;
  disabled: boolean;
  invalid: boolean;
  saving?: boolean;
  reset: () => void;
}) {
  return (
    <footer className={styles.footer}>
      {dirty && <span>{en ? "Unsaved changes" : "有未保存修改"}</span>}
      <button
        type="button"
        className="button"
        disabled={disabled || !dirty}
        onClick={reset}
      >
        {en ? "Reset changes" : "重置修改"}
      </button>
      <button
        type="submit"
        className={dirty ? "button primary" : "button"}
        disabled={disabled || !dirty || invalid}
      >
        {saving
          ? en
            ? "Saving…"
            : "保存中…"
          : en
            ? "Save configuration"
            : "保存配置"}
      </button>
    </footer>
  );
}
