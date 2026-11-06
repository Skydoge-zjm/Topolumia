import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Bot,
  Check,
  CircleAlert,
  LoaderCircle,
  Settings2,
  Terminal,
  X,
} from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import type { CollaborationContext } from "@/shared/types/api";
import styles from "@/shared/layout/SetupPage.module.css";
import { AutocompleteInput } from "@/shared/ui/AutocompleteInput";
import { NativeAgentConfigEditor } from "./NativeAgentConfigEditor";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";

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
  nativeConfiguration?: { available: boolean; provider: string; filename: string } | null;
}
export interface AgentConfiguration {
  schemaVersion: string;
  project: { id: string; name: string };
  agents: ConfiguredAgent[];
  integration: CheckState;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败";

export function AgentConfigurationPage() {
  const en = useUiStore((state) => state.locale === "en");
  const queryClient = useQueryClient();
  const currentProject = projectId();
  const key = ["agent-configuration", currentProject];
  const inventory = useQuery({
    queryKey: key,
    queryFn: () => api<AgentConfiguration>("/api/agent-configuration"),
    retry: false,
  });
  const context = useQuery({
    queryKey: ["collaboration-context", currentProject],
    queryFn: () => api<CollaborationContext>("/api/collaboration/context"),
  });
  const canManage = Boolean(
    context.data?.permissions?.some((permission) =>
      ["*", "project.manageSettings"].includes(permission),
    ),
  );
  const [editing, setEditing] = useState<ConfiguredAgent | null>(null);
  const [model, setModel] = useState("");
  const [notice, setNotice] = useState("");
  const updateCache = (data: AgentConfiguration) => {
    queryClient.setQueryData(key, data);
  };
  const check = useMutation({
    mutationFn: (selection: { profileId?: string; integration?: true }) =>
      api<AgentConfiguration>("/api/agent-configuration/check", {
        method: "POST",
        headers: { "x-rw-project-id": currentProject },
        body: JSON.stringify(selection),
      }),
    onSuccess: (data) => {
      updateCache(data);
      setNotice(
        en
          ? "Checks completed. Review each Agent's results."
          : "检查完成，请查看各 Agent 的结果。",
      );
    },
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
          headers: { "x-rw-project-id": currentProject },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: (data) => {
      updateCache(data);
      setEditing(null);
      setNotice(
        en
          ? "Agent settings saved. They apply to new sessions."
          : "Agent 配置已保存，将用于新建会话。",
      );
      void queryClient.invalidateQueries({
        queryKey: ["agent-profiles", currentProject],
      });
      void queryClient.invalidateQueries({
        queryKey: ["settings", currentProject],
      });
    },
  });
  const busy = check.isPending || configure.isPending;
  const badge = (item: CheckState) => (
    <span className={`${styles.status} ${styles[item.status]}`}>
      {item.status === "ready" ? (
        <Check size={13} aria-hidden="true" />
      ) : item.status === "unavailable" ? (
        <CircleAlert size={13} aria-hidden="true" />
      ) : (
        <span className={styles.dot} />
      )}
      {item.status === "ready"
        ? en
          ? "Ready"
          : "可用"
        : item.status === "unavailable"
          ? en
            ? "Needs attention"
            : "需处理"
          : en
            ? "Not checked"
            : "待检查"}
    </span>
  );
  const time = (value: string | null) =>
    value
      ? new Date(value).toLocaleString(en ? "en-US" : "zh-CN", {
          hour12: false,
        })
      : en
        ? "Not checked yet"
        : "尚未检查";
  const authentication = (status: string) =>
    ({
      ready: en ? "Available" : "可用",
      "not-required": en ? "Managed by local Provider" : "由本机 Provider 管理",
      "needs-auth": en ? "Sign-in required" : "需要登录",
      unchecked: en ? "Not checked" : "待检查",
    })[status] ?? (en ? "Not checked" : "待检查");
  return (
    <section
      className={styles.page}
      data-setup-page
      data-testid="agent-configuration-page"
    >
      <header className={styles.header}>
        <div>

          <h1>{en ? "Agent configuration" : "Agent 配置"}</h1>

        </div>
        <button
          className="button primary"
          disabled={!canManage || busy || !inventory.data}
          onClick={() => {
            setNotice("");
            check.mutate({});
          }}
        >
          {check.isPending ? (
            <LoaderCircle
              className={styles.spinning}
              size={16}
              aria-hidden="true"
            />
          ) : (
            <Bot size={16} aria-hidden="true" />
          )}
          {check.isPending
            ? en
              ? "Checking…"
              : "正在检查…"
            : en
              ? "Check all Agents"
              : "检查全部 Agent"}
        </button>
      </header>
      {inventory.isPending && !inventory.data && <LoadingSkeleton layout="configuration" label={en ? "Loading Agent configuration…" : "正在读取 Agent 配置…"} />}
      {inventory.error && (
        <div className={styles.error} role="alert">
          {message(inventory.error)}
          <button className="button" onClick={() => void inventory.refetch()}>
            {en ? "Retry" : "重试"}
          </button>
        </div>
      )}
      {check.error && (
        <div className={styles.error} role="alert">
          {message(check.error)}
        </div>
      )}
      {!editing && configure.error && (
        <div className={styles.error} role="alert">
          {message(configure.error)}
        </div>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {inventory.data && (
        <>
          <div className={styles.agentsGrid} aria-busy={busy || inventory.isFetching}>
            {inventory.data.agents.map((agent) => (
              <article
                className={`${styles.panel} ${styles.agentCard}`}
                key={agent.id}
              >
                <header className={styles.itemHeading}>
                  <div className={styles.agentName}>
                    <h2>{agent.label}</h2>
                    {agent.isDefault && (
                      <span className={styles.defaultTag}>
                        {en ? "Default Agent" : "默认 Agent"}
                      </span>
                    )}
                  </div>
                  {badge(agent)}
                </header>
                <dl className={styles.facts}>
                  <div>
                    <dt>{en ? "Installation" : "安装"}</dt>
                    <dd>
                      {agent.installed === null
                        ? en
                          ? "Not checked"
                          : "待检查"
                        : agent.installed
                          ? (agent.version ?? (en ? "Installed" : "已安装"))
                          : en
                            ? "Not installed"
                            : "未安装"}
                    </dd>
                  </div>
                  <div>
                    <dt>{en ? "Authentication" : "认证"}</dt>
                    <dd>{authentication(agent.authStatus)}</dd>
                  </div>
                </dl>
                <div className={styles.modelSummary}>
                  <span>{en ? "Default model" : "默认模型"}</span>
                  <code>
                    {agent.model ||
                      (en ? "Local runtime default" : "使用本机运行时默认值")}
                  </code>
                  {agent.resolvedModel &&
                    agent.resolvedModel !== agent.model && (
                      <small>{agent.resolvedModel}</small>
                    )}
                  {agent.nativeConfiguration?.available && <small>{agent.nativeConfiguration.filename} · {en ? "Native configuration" : "原生配置"}</small>}
                </div>
                {agent.status !== "unchecked" && (
                  <p className={styles.detail}>{agent.detail}</p>
                )}
                {agent.recovery && (
                  <p className={styles.recovery}>{agent.recovery}</p>
                )}
                <time
                  className={styles.checkTime}
                  dateTime={agent.checkedAt ?? undefined}
                >
                  {time(agent.checkedAt)}
                </time>
                {canManage && (
                  <footer className={styles.agentActions}>
                    <div className={styles.actions}>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => {
                          configure.reset();
                          setEditing(agent);
                          setModel(agent.model);
                        }}
                      >
                        <Settings2 size={14} aria-hidden="true" />
                        {en ? "Configure" : "配置"}
                      </button>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => {
                          setNotice("");
                          check.mutate({ profileId: agent.id });
                        }}
                      >
                        {check.isPending &&
                        check.variables?.profileId === agent.id
                          ? en
                            ? "Checking…"
                            : "检查中…"
                          : en
                            ? "Check"
                            : "检查"}
                      </button>
                    </div>
                    {!agent.isDefault && (
                      <button
                        className={styles.textButton}
                        disabled={busy}
                        onClick={() =>
                          configure.mutate({
                            id: agent.id,
                            input: { makeDefault: true },
                          })
                        }
                      >
                        {en ? "Set as default" : "设为默认"}
                      </button>
                    )}
                  </footer>
                )}
              </article>
            ))}
          </div>
          <section className={`${styles.panel} ${styles.integration}`}>
            <header className={styles.itemHeading}>
              <h2>
                <Terminal size={17} aria-hidden="true" />
                {en ? "Research MCP" : "科研 MCP"}
              </h2>
              {badge(inventory.data.integration)}
            </header>
            {inventory.data.integration.status !== "unchecked" && inventory.data.integration.detail && <p className={styles.detail}>{inventory.data.integration.detail}</p>}
            {inventory.data.integration.recovery && (
              <p className={styles.recovery}>
                {inventory.data.integration.recovery}
              </p>
            )}
            <footer className={styles.integrationFooter}>
              <time
                className={styles.checkTime}
                dateTime={inventory.data.integration.checkedAt ?? undefined}
              >
                {time(inventory.data.integration.checkedAt)}
              </time>
              {canManage && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => check.mutate({ integration: true })}
                >
                  {en ? "Check integration" : "检查科研接口"}
                </button>
              )}
            </footer>
          </section>

        </>
      )}
      <Dialog.Root
        open={Boolean(editing && !editing.nativeConfiguration?.available)}
        onOpenChange={(open) => {
          if (!open && !configure.isPending) setEditing(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content aria-describedby={undefined}
            className={`dialog-content ${styles.dialog}`}
            onEscapeKeyDown={(event) => {
              if (configure.isPending) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (configure.isPending) event.preventDefault();
            }}
          >
            <Dialog.Title>
              {en ? "Configure" : "配置"} {editing?.label}
            </Dialog.Title>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (editing)
                  configure.mutate({
                    id: editing.id,
                    input: { model: model.trim() },
                  });
              }}
            >
              <label className="form-field">
                {en ? "Default model" : "默认模型"}
                <AutocompleteInput
                  required
                  maxLength={160}
                  ariaLabel={en ? "Default model" : "默认模型"}
                  suggestionsLabel={
                    en ? "Show model suggestions" : "显示模型建议"
                  }
                  options={(editing?.models ?? []).map((option) => ({
                    value: option.id,
                    label: option.label,
                  }))}
                  autoComplete="off"
                  value={model}
                  disabled={configure.isPending}
                  onChange={setModel}
                />
              </label>
              {configure.error && (
                <div className={styles.error} role="alert">
                  {message(configure.error)}
                </div>
              )}
              <div className="dialog-actions">
                <button
                  type="button"
                  className="button"
                  disabled={configure.isPending}
                  onClick={() => setEditing(null)}
                >
                  {en ? "Cancel" : "取消"}
                </button>
                <button
                  className="button primary"
                  type="submit"
                  disabled={configure.isPending}
                >
                  {configure.isPending
                    ? en
                      ? "Saving…"
                      : "正在保存…"
                    : en
                      ? "Save"
                      : "保存配置"}
                </button>
              </div>
            </form>
            <Dialog.Close asChild>
              <button
                className={styles.close}
                aria-label={en ? "Close configuration" : "关闭配置"}
                disabled={configure.isPending}
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {editing?.nativeConfiguration?.available && <NativeAgentConfigEditor agent={editing} en={en} onClose={() => setEditing(null)} onSaved={() => {
        setEditing(null);
        setNotice(en ? "Native configuration saved for new and restarted sessions." : "原生配置已保存，将用于新建和重启会话。");
        void queryClient.invalidateQueries({ queryKey: key });
        void queryClient.invalidateQueries({ queryKey: ["agent-profiles", currentProject] });
      }} />}
    </section>
  );
}
