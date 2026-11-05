import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { ArrowLeft } from "lucide-react";
import { api } from "@/shared/lib/api";

import { type SshConnection } from "@/features/environments/ssh/ssh";
import styles from "./SshEnvironmentSelector.module.css";
import { endpoint, message } from "./presentation";

export function ProjectDirectory({
  connection,
  project,
  en,
  onSaved,
  onBack,
}: {
  connection: SshConnection;
  project: string;
  en: boolean;
  onSaved: () => void;
  onBack: () => void;
}) {
  const settings = useQuery({
    queryKey: ["ssh-project", project, connection.id],
    queryFn: () =>
      api<Record<string, string>>(endpoint(connection.id, "project")),
    retry: false,
  });
  const [directory, setDirectory] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [commands, setCommands] = useState<Record<string, string>>({});
  return (
    <>
      <button className={`button ${styles.back}`} onClick={onBack}>
        <ArrowLeft size={14} />
        {en ? "Connections" : "返回连接列表"}
      </button>
      <form
        className={styles.form}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api(endpoint(connection.id, "project"), {
              method: "PATCH",
              body: JSON.stringify({
                directory: directory ?? settings.data?.directory ?? "",
                ...commands,
              }),
            });
            onSaved();
          } catch (err) {
            setError(message(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h3>
          {en ? "Remote project directory" : "远程项目目录"} · {connection.name}
        </h3>
        <label>
          {en ? "Directory on remote host" : "远程主机上的目录"}
          <input
            value={directory ?? settings.data?.directory ?? ""}
            onChange={(e) => setDirectory(e.target.value)}
            placeholder={
              connection.info?.home
                ? `${connection.info.home}/projects/research`
                : "/home/user/projects/research"
            }
            maxLength={500}
          />

        </label>
        <details>
          <summary>
            {en ? "Remote interpreter and tool paths" : "远程解释器与工具路径"}
          </summary>
          <div className={styles.form} style={{ marginTop: 14 }}>
            <small>
              {en
                ? "Override automatic discovery only when needed. Paths refer to the remote host."
                : "自动发现不可用时可覆盖；路径均指向远程主机。"}
            </small>
            {[
              {
                key: "pythonCommand",
                label: "Python",
                placeholder: "~/miniconda3/bin/python",
              },
              {
                key: "condaCommand",
                label: "Conda",
                placeholder: "~/miniconda3/bin/conda",
              },
              {
                key: "cudaCommand",
                label: "CUDA Toolkit",
                placeholder: "/usr/local/cuda/bin/nvcc",
              },
              {
                key: "nvidiaCommand",
                label: "nvidia-smi",
                placeholder: "/usr/bin/nvidia-smi",
              },
              { key: "uvCommand", label: "uv", placeholder: "~/.local/bin/uv" },
            ].map((field) => (
              <label key={field.key}>
                {field.label}
                <input
                  value={
                    commands[field.key] ?? settings.data?.[field.key] ?? ""
                  }
                  onChange={(e) =>
                    setCommands((p) => ({ ...p, [field.key]: e.target.value }))
                  }
                  placeholder={field.placeholder}
                  maxLength={500}
                />
              </label>
            ))}
          </div>
        </details>
        {settings.error && (
          <p role="alert" className={styles.error}>
            {settings.error.message}
          </p>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div>
          <button
            className="button primary"
            disabled={
              busy || settings.isPending || connection.status !== "connected"
            }
          >
            {busy
              ? en
                ? "Verifying…"
                : "验证中…"
              : en
                ? "Verify and save"
                : "验证并保存"}
          </button>
        </div>
      </form>
    </>
  );
}
