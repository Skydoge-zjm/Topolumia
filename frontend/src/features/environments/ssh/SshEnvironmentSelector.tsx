import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { Monitor, Plus, Server, X } from "lucide-react";
import { api } from "@/shared/lib/api";
import { SelectMenu } from "../../../shared/ui/SelectMenu";

import {
  sshOverviewKey,
  type SshOverview,
} from "@/features/environments/ssh/ssh";
import styles from "./SshEnvironmentSelector.module.css";
import { working, statusLabel, endpoint, message } from "./presentation";

import { Status } from "./Status";
import { ConnectionEditor } from "./ConnectionEditor";
import { LoginChallenge } from "./LoginChallenge";
import { ProjectDirectory } from "./ProjectDirectory";
export function SshEnvironmentSelector({
  overview,
  project,
  actor,
  en,
  canManage,
  selectedId,
  onSelect,
  onRefresh,
  error,
  onConfigureDirectory,
}: {
  overview?: SshOverview;
  project: string;
  actor: string;
  en: boolean;
  canManage: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  error?: Error | null;
  onConfigureDirectory?: () => void;
}) {
  const [open, setOpen] = useState(false),
    [editor, setEditor] = useState<string | null>(null),
    [login, setLogin] = useState<string | null>(null),
    [directory, setDirectory] = useState<string | null>(null);
  const [busy, setBusy] = useState(""),
    [notice, setNotice] = useState("");
  const client = useQueryClient(),
    profiles = overview?.connections ?? [],
    viewed = profiles.find((p) => p.id === selectedId),
    current = overview?.current;
  const update = () => {
    void client.invalidateQueries({ queryKey: ["project-workspace", project] });
    void client.invalidateQueries({ queryKey: ["collaboration-context", project] });
    void client.invalidateQueries({ queryKey: sshOverviewKey(project, actor) });
    onRefresh();
  };
  const action = async (id: string, name: string) => {
    setBusy(id);
    setNotice("");
    try {
      await api(endpoint(id, name), {
        method: name ? "POST" : "DELETE",
        headers: { "x-rw-project-id": project },
        ...(name ? { body: "{}" } : {}),
      });
      update();
    } catch (err) {
      setNotice(message(err));
    } finally {
      setBusy("");
    }
  };
  const connect = async (id: string) => {
    setLogin(id);
    setEditor(null);
    setDirectory(null);
    setOpen(true);
    await action(id, "connect");
  };
  const logging = profiles.find((p) => p.id === login),
    editing = profiles.find((p) => p.id === editor),
    configuring = profiles.find((p) => p.id === directory);
  return (
    <>
      <div className={styles.bar}>
        <div className={styles.view}>
          <Monitor size={16} aria-hidden />
          <span className={styles.viewLabel}>
            {en ? "Viewing location" : "查看位置"}
          </span>
          <SelectMenu
            className={styles.locationSelect}
            ariaLabel={en ? "Viewing location" : "查看位置"}
            value={selectedId}
            onChange={onSelect}
            options={[
              { value: "", label: en ? "Local computer" : "本机" },
              ...profiles.map((p) => ({
                value: p.id,
                label: `${p.name} · ${statusLabel(p, en)}`,
              })),
            ]}
          />
          <button className="button" onClick={() => setOpen(true)}>
            <Server size={14} aria-hidden />
            {en ? "Manage SSH" : "SSH管理"}
          </button>
        </div>
        {current && (
          <div className={styles.current}>
            <span>{en ? "Project current environment" : "项目当前环境"}</span>
            <strong>
              {current.kind === "local"
                ? en
                  ? "Local"
                  : "本机"
                : current.hostLabel}{" "}
              /{" "}
              {current.source === "conda"
                ? "Conda / "
                : current.source === "venv"
                  ? "venv / "
                  : ""}
              {current.name === "unselected" ? en ? "Select Python environment" : "待选择 Python 环境" : ["default", "custom"].includes(current.name)
                ? en
                  ? "Python"
                  : "Python"
                : current.name}
            </strong>
            {current.kind === "ssh" &&
              (!current.connected || current.needsReview) && (
                <small>
                  {current.needsReview
                    ? en
                      ? "Needs verification"
                      : "待重新验证"
                    : en
                      ? "Offline"
                      : "离线"}
                </small>
              )}
          </div>
        )}
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error.message}
          <button className="button" onClick={update}>
            {en ? "Retry" : "重试"}
          </button>
        </div>
      )}
      {viewed && (
        <div className={styles.banner}>
          <div>
            <Status profile={viewed} en={en} />
            <p>
              {viewed.effective
                ? `${viewed.effective.user}@${viewed.effective.host}:${viewed.effective.port}`
                : viewed.mode === "alias"
                  ? `SSH · ${viewed.alias}`
                  : `${viewed.user}@${viewed.host}:${viewed.port}`}
              {viewed.status !== "connected"
                ? en
                  ? " · Saved results"
                  : " · 已保存结果"
                : ""}
            </p>
            {viewed.error && <p>{viewed.error}</p>}
          </div>
          <div className={styles.actions}>
            {viewed.status !== "connected" && canManage && (
              <button
                className="button primary"
                disabled={busy === viewed.id}
                onClick={() => void connect(viewed.id)}
              >
                {working(viewed)
                  ? en
                    ? "Continue sign-in"
                    : "继续登录"
                  : en
                    ? "Connect"
                    : "连接"}
              </button>
            )}
            {canManage && (
              <button
                className="button"
                onClick={() => {
                  if (onConfigureDirectory) { onConfigureDirectory(); return; }
                  setEditor(null);
                  setLogin(null);
                  setDirectory(viewed.id);
                  setOpen(true);
                }}
              >
                {en ? "Project directory" : "项目目录"}
              </button>
            )}
          </div>
        </div>
      )}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content aria-describedby={undefined} className={styles.drawer}>
            <header className={styles.heading}>
              <div>
                <Dialog.Title>
                  {en ? "SSH connections" : "SSH 连接"}
                </Dialog.Title>

              </div>
              <Dialog.Close
                className={styles.close}
                aria-label={en ? "Close SSH connections" : "关闭 SSH 连接"}
              >
                <X size={20} />
              </Dialog.Close>
            </header>
            <div className={styles.body}>
              {notice && (
                <p className={styles.error} role="alert">
                  {notice}
                </p>
              )}
              {editor ? (
                <ConnectionEditor
                  key={editor}
                  profile={editing}
                  project={project}
                  en={en}
                  onBack={() => setEditor(null)}
                  onSaved={(p) => {
                    update();
                    onSelect(p.id);
                    void connect(p.id);
                  }}
                />
              ) : configuring ? (
                <ProjectDirectory
                  key={directory}
                  connection={configuring}
                  project={project}
                  en={en}
                  onBack={() => setDirectory(null)}
                  onSaved={() => {
                    setDirectory(null);
                    update();
                  }}
                />
              ) : logging?.challenge ? (
                <LoginChallenge
                  key={logging.challenge.id}
                  challenge={logging.challenge}
                  connection={logging.id}
                  project={project}
                  en={en}
                  onUpdate={update}
                  onCancel={() => {
                    void action(logging.id, "disconnect");
                    setLogin(null);
                  }}
                />
              ) : (
                <>
                  {logging && (
                    <div className={styles.banner} role="status">
                      <Status profile={logging} en={en} />
                      {working(logging) ? (
                        <button
                          className="button"
                          onClick={() => {
                            void action(logging.id, "disconnect");
                            setLogin(null);
                          }}
                        >
                          {en ? "Cancel" : "取消连接"}
                        </button>
                      ) : logging.status === "connected" ? (
                        <button
                          className="button"
                          onClick={() => {
                            onSelect(logging.id);
                            setOpen(false);
                            setLogin(null);
                          }}
                        >
                          {en ? "View environments" : "查看环境"}
                        </button>
                      ) : null}
                      {logging.error && <p>{logging.error}</p>}
                      {logging.storageWarning && (
                        <p>{logging.storageWarning}</p>
                      )}
                    </div>
                  )}
                  <div className={styles.actions} style={{ marginBottom: 20 }}>
                    {canManage && (
                      <button
                        className="button primary"
                        onClick={() => {
                          setEditor("new");
                          setLogin(null);
                        }}
                      >
                        <Plus size={14} />
                        {en ? "Add SSH connection" : "添加 SSH 连接"}
                      </button>
                    )}
                  </div>
                  {!profiles.length && (
                    <p>
                      {en
                        ? "No SSH connections"
                        : "暂无 SSH 连接"}
                    </p>
                  )}
                  {profiles.map((p) => (
                    <article key={p.id} className={styles.connection}>
                      <div className={styles.connectionHeading}>
                        <Server size={16} aria-hidden />
                        <strong>{p.name}</strong>
                        <Status profile={p} en={en} />
                      </div>
                      <p>
                        {p.mode === "alias"
                          ? `SSH · ${p.alias}`
                          : `${p.user}@${p.host}:${p.port}`}
                        {p.info?.platform ? ` · ${p.info.platform}` : ""}
                        {p.remembered
                          ? en
                            ? " · Credential remembered"
                            : " · 已保存加密凭据"
                          : ""}
                      </p>
                      <div className={styles.actions}>
                        <button
                          className="button"
                          onClick={() => {
                            onSelect(p.id);
                            setOpen(false);
                          }}
                        >
                          {en ? "View" : "查看"}
                        </button>
                        {canManage && (
                          <>
                            {p.status === "connected" ? (
                              <button
                                className="button"
                                disabled={busy === p.id}
                                onClick={() => void action(p.id, "disconnect")}
                              >
                                {en ? "Disconnect" : "断开"}
                              </button>
                            ) : (
                              <button
                                className="button"
                                disabled={busy === p.id}
                                onClick={() => void connect(p.id)}
                              >
                                {working(p)
                                  ? en
                                    ? "Continue"
                                    : "继续登录"
                                  : en
                                    ? "Connect"
                                    : "连接"}
                              </button>
                            )}
                            <button
                              className="button"
                              onClick={() => {
                                setEditor(p.id);
                                setLogin(null);
                              }}
                            >
                              {en ? "Edit" : "编辑"}
                            </button>
                            {p.remembered && (
                              <button
                                className="button"
                                disabled={busy === p.id}
                                onClick={() =>
                                  void action(p.id, "forget-credentials")
                                }
                              >
                                {en ? "Forget credential" : "清除凭据"}
                              </button>
                            )}
                            <button
                              className="button"
                              disabled={busy === p.id}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    en
                                      ? `Remove ${p.name}? The remote host will not be changed.`
                                      : `移除连接“${p.name}”？远程主机不会被修改。`,
                                  )
                                ) {
                                  if (selectedId === p.id) onSelect("");
                                  void action(p.id, "");
                                }
                              }}
                            >
                              {en ? "Remove" : "移除"}
                            </button>
                          </>
                        )}
                      </div>
                    </article>
                  ))}
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
