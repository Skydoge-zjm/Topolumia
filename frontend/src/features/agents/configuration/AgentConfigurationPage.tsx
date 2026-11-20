import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import { Circle, CircleAlert, CircleCheck, RefreshCw } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import type { CollaborationContext } from "@/shared/types/api";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import { AutocompleteInput } from "@/shared/ui/AutocompleteInput";
import { useEditorActivity } from "./useEditorActivity";
import {
  FormActions,
  NativeAgentConfigEditor,
} from "./NativeAgentConfigEditor";
import styles from "./AgentConfigurationPage.module.css";

interface CheckState {
  status: "unchecked" | "ready" | "unavailable";
  detail: string;
  checkedAt: string | null;
  recovery: string | null;
}
export interface ConfiguredAgent extends CheckState {
  id: string;
  label: string;
  provider: string;
  model: string;
  models: Array<{ id: string; label: string }>;
  isDefault: boolean;
  installed: boolean | null;
  version: string | null;
  authStatus: string;
  resolvedModel: string | null;
  nativeConfiguration?: {
    available: boolean;
    provider: string;
    configKey?: string;
    filename: string;
  } | null;
}
export interface AgentConfiguration {
  schemaVersion: string;
  project: { id: string; name: string };
  agents: ConfiguredAgent[];
  integration: CheckState;
}
type CheckSelection = { profileId?: string; integration?: true };
const idleEditor = { dirty: false, busy: false };
const localeText = (en: boolean, chinese: string, english: string) =>
  en ? english : chinese;

function engineOrder(agent: ConfiguredAgent) {
  const key = agent.nativeConfiguration?.configKey ?? agent.id;
  if (agent.provider === "opencode") return key === "opencode-v2" ? 2 : 4;
  if (agent.provider === "codex") return 0;
  if (agent.provider === "claude") return 1;
  return 3;
}

function checkTime(value: string | null, en: boolean) {
  if (!value) return localeText(en, "尚未检查", "Not checked yet");
  return new Date(value).toLocaleString(en ? "en-US" : "zh-CN", {
    hour12: false,
  });
}

function Status({
  children,
  state,
}: {
  children: React.ReactNode;
  state: CheckState["status"];
}) {
  const Icon =
    state === "ready"
      ? CircleCheck
      : state === "unavailable"
        ? CircleAlert
        : Circle;
  return (
    <span className={styles[state]}>
      <Icon size={14} aria-hidden="true" />
      {children}
    </span>
  );
}

function RuntimeStatus({
  agent,
  en,
  action,
}: {
  agent: ConfiguredAgent;
  en: boolean;
  action: React.ReactNode;
}) {
  const installation =
    agent.installed == null
      ? "unchecked"
      : agent.installed
        ? "ready"
        : "unavailable";
  const authenticated =
    agent.authStatus === "ready" || agent.authStatus === "not-required";
  return (
    <div className={styles.statusSection}>
      <div className={styles.statusRow}>
        <strong>{en ? "Runtime status" : "运行时状态"}</strong>
        <div className={styles.statusItems}>
          <Status state={installation}>
            {agent.installed == null
              ? localeText(en, "安装待检", "Installation pending")
              : agent.installed
                ? agent.version
                  ? localeText(en, "已安装 · ", "Installed · ") + agent.version
                  : localeText(en, "已安装", "Installed")
                : localeText(en, "未安装", "Not installed")}
          </Status>
          <Status
            state={
              authenticated
                ? "ready"
                : agent.authStatus === "needs-auth"
                  ? "unavailable"
                  : "unchecked"
            }
          >
            {agent.authStatus === "not-required"
              ? localeText(en, "无需单独认证", "No separate sign-in needed")
              : agent.authStatus === "ready"
                ? localeText(en, "认证可用", "Signed in")
                : agent.authStatus === "needs-auth"
                  ? localeText(en, "需要登录", "Sign-in required")
                  : localeText(en, "认证待检", "Authentication pending")}
          </Status>
          <time dateTime={agent.checkedAt ?? undefined}>
            {checkTime(agent.checkedAt, en)}
          </time>
        </div>
        {action}
      </div>
      {agent.status !== "unchecked" && (agent.detail || agent.recovery) && (
        <div className={styles.diagnostics}>
          {agent.detail && <p>{agent.detail}</p>}
          {agent.recovery && <p>{agent.recovery}</p>}
        </div>
      )}
    </div>
  );
}

export function AgentConfigurationPage() {
  const en = useUiStore((state) => state.locale === "en");
  const client = useQueryClient();
  const project = projectId();
  const key = ["agent-configuration", project];
  const inventory = useQuery({
    queryKey: key,
    queryFn: () => api<AgentConfiguration>("/api/agent-configuration"),
    retry: false,
  });
  const context = useQuery({
    queryKey: ["collaboration-context", project],
    queryFn: () => api<CollaborationContext>("/api/collaboration/context"),
  });
  const canManage = Boolean(
    context.data?.permissions?.some(
      (permission) =>
        permission === "*" || permission === "project.manageSettings",
    ),
  );
  const [selection, setSelection] = useState("");
  const [editor, setEditor] = useState(idleEditor);
  const [notice, setNotice] = useState("");
  const check = useMutation({
    mutationFn: (selection: CheckSelection) =>
      api<AgentConfiguration>("/api/agent-configuration/check", {
        method: "POST",
        headers: { "x-rw-project-id": project },
        body: JSON.stringify(selection),
      }),
    onSuccess: (data) => client.setQueryData(key, data),
  });
  const configure = useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: { model?: string; makeDefault?: true };
    }) =>
      api<AgentConfiguration>(
        `/api/agent-configuration/profiles/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "x-rw-project-id": project },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: (data, { input }) => {
      client.setQueryData(key, data);
      setNotice(
        input.makeDefault
          ? localeText(en, "已更新默认 Agent。", "Default Agent updated.")
          : localeText(
              en,
              "Agent 配置已保存，将用于新建会话。",
              "Agent settings saved for new sessions.",
            ),
      );
      void client.invalidateQueries({ queryKey: ["agent-profiles", project] });
      void client.invalidateQueries({ queryKey: ["settings", project] });
    },
  });
  const agents = [...(inventory.data?.agents ?? [])].sort(
    (a, b) => engineOrder(a) - engineOrder(b),
  );
  const agent =
    agents.find((item) => item.id === selection) ??
    agents.find((item) => item.isDefault) ??
    agents[0];
  const allBusy = check.isPending || configure.isPending || editor.busy;
  const startCheck = (scope: CheckSelection) => {
    setNotice("");
    check.mutate(scope);
  };
  const chooseAgent = (id: string) => {
    if (allBusy || id === agent?.id) return;
    if (
      editor.dirty &&
      !window.confirm(
        localeText(en, "放弃未保存的配置？", "Discard unsaved configuration?"),
      )
    )
      return;
    setEditor(idleEditor);
    setNotice("");
    configure.reset();
    setSelection(id);
  };
  const defaultControl = agent && (
    <div className={styles.settingRow}>
      <span>{en ? "Default Agent" : "默认 Agent"}</span>
      <button
        type="button"
        role="switch"
        aria-checked={agent.isDefault}
        aria-label={
          en
            ? `Set ${agent.label} as default Agent`
            : `将 ${agent.label} 设为默认 Agent`
        }
        className={styles.defaultSwitch}
        disabled={!canManage || allBusy || agent.isDefault}
        onClick={() =>
          configure.mutate({ id: agent.id, input: { makeDefault: true } })
        }
      >
        <span className={styles.switchTrack} aria-hidden="true" />
        {agent.isDefault
          ? localeText(en, "当前默认引擎", "Current default engine")
          : localeText(en, "设为默认 Agent", "Set as default Agent")}
      </button>
    </div>
  );
  const integration = inventory.data?.integration;
  const engines = agents
    .filter((item) => item.nativeConfiguration?.available)
    .map((item) => item.label);

  return (
    <section
      className={`agent-configuration-layout ${styles.page}`}
      data-testid="agent-configuration-page"
      translate="no"
    >
      <header className={styles.header}>
        <h1>{en ? "Agent configuration" : "Agent 配置"}</h1>
        <button
          type="button"
          className="button"
          disabled={!canManage || allBusy || !inventory.data}
          onClick={() => startCheck({})}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {check.isPending &&
          !check.variables?.profileId &&
          !check.variables?.integration
            ? localeText(en, "正在检查…", "Checking…")
            : localeText(en, "检查全部 Agent", "Check all Agents")}
        </button>
      </header>
      {inventory.isPending && (
        <LoadingSkeleton
          layout="configuration"
          label={localeText(
            en,
            "正在读取 Agent 配置…",
            "Loading Agent configuration…",
          )}
        />
      )}
      {inventory.error && (
        <div className={styles.error} role="alert">
          {inventory.error.message}
          <button
            type="button"
            className="button"
            onClick={() => void inventory.refetch()}
          >
            {en ? "Retry" : "重试"}
          </button>
        </div>
      )}
      {check.error && (
        <p className={styles.error} role="alert">
          {check.error.message}
        </p>
      )}
      {configure.error && (
        <p className={styles.error} role="alert">
          {configure.error.message}
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {agent && (
        <Tabs.Root
          className={styles.panel}
          value={agent.id}
          onValueChange={chooseAgent}
          activationMode="manual"
        >
          <Tabs.List
            className={styles.engines}
            aria-label={en ? "Agent engine" : "Agent 引擎"}
          >
            {agents.map((item) => {
              const legacy =
                item.provider === "opencode" &&
                engineOrder(item) === 4 &&
                agents.some((engine) => engineOrder(engine) === 2);
              return (
                <Tabs.Trigger
                  key={item.id}
                  value={item.id}
                  className={styles.engine}
                  disabled={allBusy && item.id !== agent.id}
                >
                  <span className={styles.engineDot} aria-hidden="true" />
                  {legacy
                    ? item.label.replace(/s*[（(][^）)]*[）)]$/, "")
                    : item.label}
                  {legacy && <small>{en ? "Legacy" : "旧版"}</small>}
                  {item.isDefault && (
                    <small className={styles.defaultLabel}>
                      {en ? "Default" : "默认"}
                    </small>
                  )}
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>
          <Tabs.Content
            value={agent.id}
            key={agent.id}
            className={styles.enginePanel}
          >
            <RuntimeStatus
              agent={agent}
              en={en}
              action={
                canManage && (
                  <button
                    type="button"
                    className="button"
                    disabled={allBusy}
                    onClick={() => startCheck({ profileId: agent.id })}
                  >
                    {check.isPending && check.variables?.profileId === agent.id
                      ? localeText(en, "检查中…", "Checking…")
                      : localeText(en, "检查", "Check")}
                  </button>
                )
              }
            />
            {canManage && agent.nativeConfiguration?.available ? (
              <NativeAgentConfigEditor
                agent={agent}
                en={en}
                disabled={check.isPending || configure.isPending}
                defaultControl={defaultControl}
                onActivity={setEditor}
                onSaved={() => {
                  setNotice(
                    localeText(
                      en,
                      "原生配置已保存，将用于新建和重启会话。",
                      "Native configuration saved for new and restarted sessions.",
                    ),
                  );
                  void client.invalidateQueries({ queryKey: key });
                  void client.invalidateQueries({
                    queryKey: ["agent-profiles", project],
                  });
                }}
              />
            ) : (
              <ProfileForm
                key={agent.id + ":" + agent.model}
                agent={agent}
                en={en}
                editable={canManage}
                disabled={allBusy}
                defaultControl={defaultControl}
                onActivity={setEditor}
                onSave={(model) =>
                  configure.mutate({ id: agent.id, input: { model } })
                }
              />
            )}
          </Tabs.Content>
        </Tabs.Root>
      )}
      {integration && (
        <section className={styles.mcp} aria-labelledby="agent-research-mcp">
          <h2 id="agent-research-mcp">{en ? "Research MCP" : "科研 MCP"}</h2>
          <div className={styles.panel}>
            <div className={styles.statusSection}>
              <div className={styles.statusRow}>
                <strong>{en ? "Interface status" : "接口状态"}</strong>
                <div className={styles.statusItems}>
                  <Status state={integration.status}>
                    {integration.status === "unchecked"
                      ? localeText(en, "尚未检查", "Not checked yet")
                      : integration.status === "ready"
                        ? localeText(en, "可用", "Ready")
                        : localeText(en, "需处理", "Needs attention")}
                  </Status>
                  {integration.checkedAt && (
                    <time dateTime={integration.checkedAt}>
                      {checkTime(integration.checkedAt, en)}
                    </time>
                  )}
                </div>
                {canManage && (
                  <button
                    type="button"
                    className="button"
                    disabled={allBusy}
                    onClick={() => startCheck({ integration: true })}
                  >
                    {check.isPending && check.variables?.integration
                      ? localeText(en, "检查中…", "Checking…")
                      : localeText(en, "检查科研接口", "Check integration")}
                  </button>
                )}
              </div>
              {integration.status !== "unchecked" &&
                (integration.detail || integration.recovery) && (
                  <div className={styles.diagnostics}>
                    {integration.detail && <p>{integration.detail}</p>}
                    {integration.recovery && <p>{integration.recovery}</p>}
                  </div>
                )}
            </div>
            <div className={styles.settingRow}>
              <span>{en ? "Connection" : "连接模式"}</span>
              <span>
                {en ? "Local MCP · project context" : "本地 MCP · 项目上下文"}
              </span>
            </div>
            {engines.length > 0 && (
              <div className={styles.settingRow}>
                <span>{en ? "Agent integration" : "关联引擎"}</span>
                <span>{engines.join(" / ")}</span>
              </div>
            )}
          </div>
        </section>
      )}
    </section>
  );
}

function ProfileForm({
  agent,
  en,
  editable,
  disabled,
  defaultControl,
  onActivity,
  onSave,
}: {
  agent: ConfiguredAgent;
  en: boolean;
  editable: boolean;
  disabled: boolean;
  defaultControl: React.ReactNode;
  onActivity: (state: typeof idleEditor) => void;
  onSave: (model: string) => void;
}) {
  const [draft, setDraft] = useState(agent.model);
  const dirty = editable && draft !== agent.model;
  useEditorActivity(dirty, false, onActivity);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !disabled && draft.trim()) onSave(draft.trim());
      }}
    >
      {defaultControl}
      <div className={styles.settingRow}>
        <span>{en ? "Default model" : "默认模型"}</span>
        {editable ? (
          <div className={styles.settingControl}>
            <AutocompleteInput
              ariaLabel={en ? "Default model" : "默认模型"}
              suggestionsLabel={en ? "Show model suggestions" : "显示模型建议"}
              options={agent.models.map((model) => ({
                value: model.id,
                label: model.label,
              }))}
              value={draft}
              onChange={setDraft}
              disabled={disabled}
              maxLength={160}
            />
          </div>
        ) : (
          <span>
            {agent.model ||
              localeText(
                en,
                "跟随本机运行时默认值",
                "Follow the local runtime default",
              )}
          </span>
        )}
      </div>
      {editable && (
        <FormActions
          en={en}
          dirty={dirty}
          disabled={disabled}
          invalid={!draft.trim()}
          reset={() => setDraft(agent.model)}
        />
      )}
    </form>
  );
}
