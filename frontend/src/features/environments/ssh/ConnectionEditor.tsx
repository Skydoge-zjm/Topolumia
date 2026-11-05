import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { ArrowLeft } from "lucide-react";
import { api } from "@/shared/lib/api";
import { SelectMenu } from "../../../shared/ui/SelectMenu";
import { AutocompleteInput } from "../../../shared/ui/AutocompleteInput";
import {
  type SshConfiguration,
  type SshConnection,
} from "@/features/environments/ssh/ssh";
import styles from "./SshEnvironmentSelector.module.css";
import { endpoint, message } from "./presentation";

export function ConnectionEditor({
  profile,
  project,
  en,
  onSaved,
  onBack,
}: {
  profile?: SshConnection;
  project: string;
  en: boolean;
  onSaved: (p: SshConnection) => void;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState<SshConfiguration>(
    profile ?? {
      name: "",
      mode: "alias",
      alias: "",
      host: "",
      port: 22,
      user: "",
      auth: "agent",
      keyPath: "",
      timeoutSeconds: 10,
      keepAlive: true,
    },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [resolved, setResolved] = useState<{
    host: string;
    port: number;
    user: string;
  } | null>(null);
  const [resolving, setResolving] = useState(false);
  const aliases = useQuery({
    queryKey: ["ssh-aliases", project],
    queryFn: () => api<{ aliases: string[] }>("/api/ssh/aliases"),
    retry: false,
  });
  const set = (key: string, value: string | number | boolean) => {
    setDraft((p) => ({ ...p, [key]: value }));
    if (key === "alias") setResolved(null);
  };
  return (
    <>
      <button className={`button ${styles.back}`} onClick={onBack}>
        <ArrowLeft size={14} />
        {en ? "Connections" : "返回连接列表"}
      </button>
      <form
        className={styles.form}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          const common = {
            name:
              draft.name.trim() ||
              (draft.mode === "alias" ? draft.alias : draft.host),
            mode: draft.mode,
            timeoutSeconds: draft.timeoutSeconds,
            keepAlive: draft.keepAlive,
          };
          const input =
            draft.mode === "alias"
              ? { ...common, alias: draft.alias }
              : {
                  ...common,
                  host: draft.host,
                  port: draft.port,
                  user: draft.user,
                  auth: draft.auth,
                  keyPath: draft.auth === "key" ? draft.keyPath : "",
                };
          try {
            const p = await api<SshConnection>(
              profile ? endpoint(profile.id) : "/api/ssh/connections",
              {
                method: profile ? "PATCH" : "POST",
                body: JSON.stringify(input),
              },
            );
            onSaved(p);
          } catch (err) {
            setError(message(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          {en ? "Connection name" : "连接名称"}
          <input
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            maxLength={120}
            placeholder={en ? "e.g. WSL research" : "例如 WSL 科研环境"}
          />
        </label>
        <label>
          {en ? "Connection method" : "配置方式"}
          <SelectMenu
            ariaLabel={en ? "Connection method" : "配置方式"}
            value={draft.mode}
            onChange={(value) => set("mode", value)}
            options={[
              {
                value: "alias",
                label: en
                  ? "SSH config alias (recommended)"
                  : "SSH 配置别名（推荐）",
              },
              {
                value: "manual",
                label: en ? "Host, port and user" : "手动填写主机",
              },
            ]}
          />
        </label>
        {draft.mode === "alias" ? (
          <>
            <label>
              {en ? "SSH alias" : "SSH 别名"}
              <AutocompleteInput
                required
                ariaLabel={en ? "SSH alias" : "SSH 别名"}
                suggestionsLabel={
                  en ? "Show SSH alias suggestions" : "显示 SSH 别名建议"
                }
                options={(aliases.data?.aliases ?? []).map((value) => ({
                  value,
                  label: value,
                }))}
                value={draft.alias ?? ""}
                onChange={(value) => set("alias", value)}
                placeholder="wsl"
                maxLength={120}
                autoComplete="off"
                pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
              />

            </label>
            <div>
              <button
                type="button"
                className="button"
                disabled={resolving || !draft.alias}
                onClick={async () => {
                  setResolving(true);
                  setError("");
                  try {
                    setResolved(
                      await api("/api/ssh/resolve", {
                        method: "POST",
                        body: JSON.stringify({ alias: draft.alias }),
                      }),
                    );
                  } catch (err) {
                    setError(message(err));
                  } finally {
                    setResolving(false);
                  }
                }}
              >
                {resolving
                  ? en
                    ? "Resolving…"
                    : "解析中…"
                  : en
                    ? "Check configuration"
                    : "解析配置"}
              </button>
            </div>
            {resolved && (
              <div className={styles.resolved} role="status">
                {resolved.user}@{resolved.host}:{resolved.port}
              </div>
            )}
          </>
        ) : (
          <>
            <div className={styles.columns}>
              <label>
                {en ? "Host" : "主机地址"}
                <input
                  required
                  value={draft.host ?? ""}
                  onChange={(e) => set("host", e.target.value)}
                  placeholder="192.168.1.20"
                  maxLength={120}
                />
              </label>
              <label>
                {en ? "Port" : "端口"}
                <input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.port ?? 22}
                  onChange={(e) => set("port", Number(e.target.value))}
                />
              </label>
            </div>
            <label>
              {en ? "Username" : "登录用户"}
              <input
                required
                value={draft.user ?? ""}
                onChange={(e) => set("user", e.target.value)}
                autoComplete="username"
                maxLength={120}
              />
            </label>
            <label>
              {en ? "Authentication" : "认证方式"}
              <SelectMenu
                ariaLabel={en ? "Authentication" : "认证方式"}
                value={draft.auth}
                onChange={(value) => set("auth", value)}
                options={[
                  { value: "agent", label: "ssh-agent" },
                  { value: "key", label: en ? "Private key file" : "私钥文件" },
                  {
                    value: "password",
                    label: en ? "Password / interactive" : "密码 / 交互认证",
                  },
                ]}
              />
            </label>
            {draft.auth === "key" && (
              <label>
                {en ? "Private key path" : "私钥路径"}
                <input
                  required
                  value={draft.keyPath ?? ""}
                  onChange={(e) => set("keyPath", e.target.value)}
                  maxLength={500}
                  placeholder="~/.ssh/id_ed25519"
                />

              </label>
            )}
          </>
        )}
        <details>
          <summary>{en ? "Advanced settings" : "高级设置"}</summary>
          <div className={styles.form} style={{ marginTop: 14 }}>
            <label>
              {en ? "Connection timeout (seconds)" : "连接超时（秒）"}
              <input
                type="number"
                min={3}
                max={60}
                required
                value={draft.timeoutSeconds}
                onChange={(e) => set("timeoutSeconds", Number(e.target.value))}
              />
            </label>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={draft.keepAlive}
                onChange={(e) => set("keepAlive", e.target.checked)}
              />
              {en ? "Keep connection alive" : "保持连接"}
            </label>
          </div>
        </details>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button className="button primary" disabled={busy}>
            {busy
              ? en
                ? "Saving…"
                : "保存中…"
              : en
                ? "Save and connect"
                : "保存并连接"}
          </button>
          <button
            type="button"
            className="button"
            onClick={onBack}
            disabled={busy}
          >
            {en ? "Cancel" : "取消"}
          </button>
        </div>
      </form>
    </>
  );
}
