import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FolderPlus,
  FolderOpen,
  Server,
  CheckCircle2,
  HardDrive,
  LoaderCircle,
  AlertCircle,
} from "lucide-react";
import type { ProjectWorkspace } from "@domain/projects/workspace";
import { api, projectId } from "@/shared/lib/api";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { ConnectionEditor } from "@/features/environments/ssh/ConnectionEditor";
import { LoginChallenge } from "@/features/environments/ssh/LoginChallenge";
import {
  endpoint,
  statusLabel,
  working,
} from "@/features/environments/ssh/presentation";
import {
  sshOverviewKey,
  type SshOverview,
} from "@/features/environments/ssh/ssh";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { workspaceChoice, type WorkspaceDraft } from "./projectWorkspace";
import styles from "./ProjectWorkspace.module.css";

export function ProjectWorkspaceFields({
  value,
  onChange,
  en,
  disabled,
  actorId,
  defaultDirectory,
  defaultHost,
  onReadinessChange,
}: {
  value: WorkspaceDraft;
  onChange: (value: WorkspaceDraft) => void;
  en: boolean;
  disabled: boolean;
  actorId: string;
  defaultDirectory?: string;
  defaultHost?: string;
  onReadinessChange?: (ready: boolean) => void;
}) {
  const validationId = useId();
  const [browser, setBrowser] = useState(false),
    [newHost, setNewHost] = useState(false),
    [login, setLogin] = useState<string>(),
    [connectionBusy, setConnectionBusy] = useState(false),
    [connectionError, setConnectionError] = useState("");
  const [validation, setValidation] = useState<{
    key: string;
    status: "checking" | "valid" | "error";
    message?: string;
    directory?: string;
  }>();
  const request = useRef<AbortController | null>(null),
    generation = useRef(0);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (disabled) {
      request.current?.abort();
      generation.current++;
      setValidation(undefined);
    }
  }, [disabled]);
  const ssh = useQuery({
    queryKey: sshOverviewKey(projectId(), actorId),
    enabled: value.kind === "ssh" && Boolean(actorId),
    queryFn: ({ signal }) =>
      api<SshOverview>("/api/ssh/connections", { signal }),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.connections.some((connection) => working(connection))
        ? 700
        : 5000,
    refetchIntervalInBackground: false,
  });
  const selected = ssh.data?.connections.find(
      (connection) => connection.id === value.connectionId,
    ),
    logging = ssh.data?.connections.find(
      (connection) => connection.id === login,
    );
  const key = JSON.stringify([
    workspaceChoice(value),
    value.kind === "ssh" ? selected?.revision : undefined,
    value.kind === "ssh" ? selected?.status : undefined,
  ]);
  const change = (next: WorkspaceDraft) => {
    request.current?.abort();
    generation.current++;
    setValidation(undefined);
    setConnectionError("");
    setBrowser(false);
    onChange(next);
  };
  const check = async (next = value) => {
    if (disabled || !["local", "ssh"].includes(next.kind)) return;
    const choice = workspaceChoice(next),
      directory = "directory" in choice ? choice.directory : "";
    if (
      !directory ||
      (choice.kind === "ssh" && selected?.status !== "connected")
    )
      return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const serial = ++generation.current;
    setValidation({ key, status: "checking" });
    try {
      const result = await api<{ workspace: ProjectWorkspace }>(
        "/api/project-workspaces/validate",
        {
          method: "POST",
          body: JSON.stringify(choice),
          signal: controller.signal,
        },
      );
      if (serial === generation.current)
        setValidation({
          key,
          status: "valid",
          directory: result.workspace.directory,
        });
    } catch (cause) {
      if (!controller.signal.aborted && serial === generation.current)
        setValidation({
          key,
          status: "error",
          message: (cause as Error).message,
        });
    }
  };
  const connect = async (id: string) => {
    setLogin(id);
    setConnectionError("");
    const profile = ssh.data?.connections.find(
      (connection) => connection.id === id,
    );
    if (profile && working(profile)) return;
    setConnectionBusy(true);
    try {
      await api(endpoint(id, "connect"), { method: "POST", body: "{}" });
      await ssh.refetch();
    } catch (cause) {
      setConnectionError((cause as Error).message);
    } finally {
      setConnectionBusy(false);
    }
  };
  const cancelConnection = async () => {
    if (!login || connectionBusy) return;
    setConnectionBusy(true);
    setConnectionError("");
    try {
      await api(endpoint(login, "disconnect"), { method: "POST", body: "{}" });
      await ssh.refetch();
      setLogin(undefined);
    } catch (cause) {
      setConnectionError((cause as Error).message);
    } finally {
      setConnectionBusy(false);
    }
  };
  const directory =
      value.kind === "local" ? value.localDirectory : value.sshDirectory,
    validState = validation?.key === key ? validation : undefined;
  const ready = value.kind === "local" || selected?.status === "connected";
  const canSubmit =
    value.kind === "managed" || (ready && Boolean(directory.trim()));
  useEffect(() => {
    onReadinessChange?.(canSubmit);
  }, [canSubmit, onReadinessChange]);
  return (
    <div
      className={styles.workspaceFields}
      onSubmit={(event) => event.stopPropagation()}
    >
      <fieldset className={styles.locationChoices} disabled={disabled}>
        <legend>{en ? "Working directory" : "工作目录"}</legend>
        <div>
          {(
            [
              [
                "managed",
                en ? "Topolumia default workspace" : "Topolumia 默认工作区",
              ],
              ["local", en ? "Existing local directory" : "本机已有目录"],
              ["ssh", en ? "SSH directory" : "SSH 目录"],
            ] as const
          ).map(([kind, label]) => {
            const Icon =
              kind === "managed"
                ? FolderPlus
                : kind === "local"
                  ? FolderOpen
                  : Server;
            return (
              <label
                key={kind}
                className={value.kind === kind ? styles.selectedChoice : ""}
              >
                <input
                  type="radio"
                  name="project-workspace-kind"
                  value={kind}
                  checked={value.kind === kind}
                  onChange={() => change({ ...value, kind })}
                />
                <Icon size={19} aria-hidden />
                <span>{label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className={styles.locationDetails} key={value.kind}>
        {value.kind === "managed" && defaultDirectory && (
          <dl className={styles.destination}>
            {defaultHost && (
              <div>
                <dt>
                  <HardDrive size={16} aria-hidden />
                  {en ? "Host" : "主机"}
                </dt>
                <dd>{defaultHost}</dd>
              </div>
            )}
            <div>
              <dt>
                <FolderOpen size={16} aria-hidden />
                {en ? "Location" : "保存位置"}
              </dt>
              <dd>
                <code>{defaultDirectory}</code>
              </dd>
            </div>
          </dl>
        )}
        {value.kind === "ssh" && (
          <div className={styles.remoteFields}>
            <div className={styles.pathRow}>
              <label className={styles.pathField}>
                {en ? "SSH host" : "SSH 主机"}
                <SelectMenu
                  ariaLabel={en ? "SSH host" : "SSH 主机"}
                  disabled={disabled || ssh.isPending}
                  value={value.connectionId}
                  onChange={(id) => change({ ...value, connectionId: id })}
                  options={[
                    {
                      value: "",
                      label: ssh.isPending
                        ? en
                          ? "Loading SSH hosts…"
                          : "正在读取 SSH 主机…"
                        : en
                          ? "Select an SSH host"
                          : "选择 SSH 主机",
                    },
                    ...(ssh.data?.connections.map((connection) => ({
                      value: connection.id,
                      label:
                        connection.name + " · " + statusLabel(connection, en),
                    })) ?? []),
                  ]}
                />
              </label>
              <button
                type="button"
                className="button"
                disabled={disabled || ssh.isPending}
                onClick={() => setNewHost(true)}
              >
                {en ? "Add host" : "添加主机"}
              </button>
              {selected && selected.status !== "connected" && (
                <button
                  type="button"
                  className="button"
                  disabled={disabled || connectionBusy}
                  onClick={() => void connect(selected.id)}
                >
                  {working(selected)
                    ? en
                      ? "Continue sign-in"
                      : "继续登录"
                    : en
                      ? "Connect"
                      : "连接"}
                </button>
              )}
            </div>
            {ssh.error && (
              <p role="alert">
                {ssh.error.message}
                <button
                  type="button"
                  className="button"
                  onClick={() => void ssh.refetch()}
                >
                  {en ? "Retry" : "重试"}
                </button>
              </p>
            )}
            {selected && (
              <div role="status" className={styles.connectionState}>
                <span>
                  {selected.name} · {statusLabel(selected, en)}
                </span>
                {selected.error && <span>{selected.error}</span>}
              </div>
            )}
          </div>
        )}
        {(value.kind === "local" || value.kind === "ssh") && (
          <>
            <div className={styles.pathRow}>
              <label className={styles.pathField}>
                {value.kind === "local"
                  ? en
                    ? "Local directory"
                    : "本机目录"
                  : en
                    ? "Directory on the SSH host"
                    : "SSH 主机上的目录"}
                <input
                  required
                  value={directory}
                  disabled={disabled}
                  aria-invalid={validState?.status === "error"}
                  aria-describedby={validState ? validationId : undefined}
                  onChange={(event) =>
                    change({
                      ...value,
                      ...(value.kind === "local"
                        ? { localDirectory: event.target.value }
                        : { sshDirectory: event.target.value }),
                    })
                  }
                  onBlur={() => void check()}
                  placeholder={
                    value.kind === "local"
                      ? en
                        ? "Select or enter an existing directory"
                        : "选择或输入已有目录"
                      : "/home/user/project"
                  }
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={4096}
                />
              </label>
              <button
                type="button"
                className="button"
                disabled={disabled || !ready}
                onClick={() => setBrowser(true)}
              >
                <FolderOpen size={16} aria-hidden />
                {en ? "Browse" : "浏览"}
              </button>
            </div>
            {validState && (
              <p
                id={validationId}
                role={validState.status === "error" ? "alert" : "status"}
                className={
                  validState.status === "error"
                    ? styles.error
                    : styles.validation
                }
              >
                {validState.status === "valid" && (
                  <CheckCircle2 size={15} aria-hidden />
                )}
                {validState.status === "checking" && (
                  <LoaderCircle size={15} className={styles.spin} aria-hidden />
                )}
                {validState.status === "error" && (
                  <AlertCircle size={15} aria-hidden />
                )}
                {validState.status === "checking"
                  ? en
                    ? "Checking directory…"
                    : "正在检查目录…"
                  : validState.status === "valid"
                    ? en
                      ? "Directory is accessible"
                      : "目录可访问"
                    : validState.message}
                {validState.status === "valid" &&
                  validState.directory &&
                  validState.directory !== directory.trim() && (
                    <code>{validState.directory}</code>
                  )}
                {validState.status === "error" && (
                  <button
                    type="button"
                    className={styles.retryLink}
                    disabled={disabled || !ready}
                    onClick={() => void check()}
                  >
                    {en ? "Retry" : "重试"}
                  </button>
                )}
              </p>
            )}
          </>
        )}
      </div>
      {browser && (value.kind === "local" || value.kind === "ssh") && (
        <DirectoryBrowser
          key={value.kind + value.connectionId}
          en={en}
          kind={value.kind}
          connectionId={value.connectionId}
          initialPath={directory}
          onClose={() => setBrowser(false)}
          onSelect={(path) => {
            const next = {
              ...value,
              ...(value.kind === "local"
                ? { localDirectory: path }
                : { sshDirectory: path }),
            };
            change(next);
            setValidation({
              key: JSON.stringify([
                workspaceChoice(next),
                next.kind === "ssh" ? selected?.revision : undefined,
                next.kind === "ssh" ? selected?.status : undefined,
              ]),
              status: "valid",
            });
          }}
        />
      )}
      {newHost && (
        <ResearchDialog
          title={en ? "Add SSH host" : "添加 SSH 主机"}
          onClose={() => setNewHost(false)}
        >
          <ConnectionEditor
            project={projectId()}
            en={en}
            onBack={() => setNewHost(false)}
            onSaved={async (profile) => {
              await ssh.refetch();
              change({ ...value, connectionId: profile.id });
              setNewHost(false);
              await connect(profile.id);
            }}
          />
        </ResearchDialog>
      )}
      {login && (
        <ResearchDialog
          title={en ? "Connect SSH host" : "连接 SSH 主机"}
          onClose={() => setLogin(undefined)}
        >
          {logging?.challenge && connectionError && (
            <p role="alert">{connectionError}</p>
          )}
          {logging?.challenge ? (
            <LoginChallenge
              key={logging.challenge.id}
              challenge={logging.challenge}
              project={projectId()}
              connection={login}
              en={en}
              onUpdate={() => void ssh.refetch()}
              onCancel={() => void cancelConnection()}
            />
          ) : (
            <>
              <p role="status">
                {logging
                  ? statusLabel(logging, en)
                  : en
                    ? "Connecting…"
                    : "正在连接…"}
              </p>
              {(connectionError || logging?.error) && (
                <p role="alert">{connectionError || logging?.error}</p>
              )}
              <div className={styles.actions}>
                {logging?.status === "error" && (
                  <button
                    type="button"
                    className="button"
                    disabled={connectionBusy}
                    onClick={() => void connect(login)}
                  >
                    {en ? "Retry" : "重试"}
                  </button>
                )}
                <button
                  type="button"
                  className="button"
                  onClick={() => setLogin(undefined)}
                >
                  {logging?.status === "connected"
                    ? en
                      ? "Done"
                      : "完成"
                    : en
                      ? "Close"
                      : "关闭"}
                </button>
              </div>
            </>
          )}
        </ResearchDialog>
      )}
    </div>
  );
}
