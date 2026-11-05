import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { api } from "@/shared/lib/api";
import { environmentHeaders } from "@/features/environments/ssh/ssh";
import type { EnvironmentCatalog } from "@/features/environments/types/environmentCatalog";

import styles from "./EnvironmentTree.module.css";
import { sourceLabel } from "./presentation";
import type { SharedProps } from "./types";

import { EnvironmentBranch } from "./EnvironmentBranch";
export function SourceBranch({
  source,
  catalog,
  onCatalog,
  onConfigure,
  ...shared
}: SharedProps & {
  source: EnvironmentCatalog["sources"][number];
  catalog: EnvironmentCatalog;
  onCatalog: (data: EnvironmentCatalog) => void;
  onConfigure: (id: string, trigger: HTMLElement) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedEnvironments, setExpandedEnvironments] = useState(
    new Set<string>(),
  );
  const { project, en, canManage } = shared;
  const client = useQueryClient();
  const key = [
    "environment-catalog",
    project,
    shared.sshId ?? "local",
    "source",
    source.id,
    catalog.fingerprint,
  ];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<EnvironmentCatalog>(
        `/api/tools-environment/catalog/sources/${source.id}`,
        { headers: environmentHeaders(project, shared.sshId), signal },
      ),
    enabled: expanded,
    retry: false,
    staleTime: 30000,
    initialData: source.status === "ready" ? catalog : undefined,
  });
  const refresh = useMutation({
    mutationFn: () =>
      api<EnvironmentCatalog>(
        `/api/tools-environment/catalog/sources/${source.id}?refresh=true`,
        { headers: environmentHeaders(project, shared.sshId) },
      ),
    onSuccess: (data) => {
      client.setQueryData(key, data);
      onCatalog(data);
    },
  });
  useEffect(() => {
    if (query.data) onCatalog(query.data);
  }, [query.data, onCatalog]);
  const selected =
    query.data?.sources.find((item) => item.id === source.id) ?? source;
  const loading = query.isFetching || refresh.isPending;
  const name = sourceLabel(source.id, en, Boolean(shared.sshId));
  return (
    <>
      <tr className={styles.sourceRow}>
        <th scope="row">
          <button
            className={styles.rowName}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <span>{name}</span>
          </button>
        </th>
        <td>—</td>
        <td>
          {loading ? (
            <span className={styles.componentStatus}>
              <LoaderCircle size={12} className={styles.spinning} />
              {en ? "Discovering" : "发现中"}
            </span>
          ) : selected.status === "ready" ? (
            en ? (
              `${selected.environments.length} environments`
            ) : (
              `${selected.environments.length} 个环境`
            )
          ) : selected.status === "error" ? (
            en ? (
              "Unavailable"
            ) : (
              "发现失败"
            )
          ) : en ? (
            "Not discovered"
          ) : (
            "待发现"
          )}
        </td>
        <td className={styles.actionCell}>
          {expanded && (
            <button
              className={styles.iconButton}
              disabled={loading}
              onClick={() => refresh.mutate()}
              aria-label={
                en ? `Refresh ${name} environments` : `刷新 ${name} 环境`
              }
            >
              <RefreshCw size={14} />
            </button>
          )}
          {source.id === "conda" && canManage && (
            <button
              className={styles.iconButton}
              onClick={(event) => onConfigure("conda", event.currentTarget)}
              aria-label={en ? "Configure Conda" : "配置 Conda"}
            >
              <Settings2 size={14} />
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <>
          {(query.error || refresh.error || selected.status === "error") && (
            <tr>
              <td colSpan={4} className={styles.nestedMessage} role="alert">
                {en
                  ? "Environment discovery failed. Refresh the list or configure the manager."
                  : (selected.detail ??
                    (query.error ?? refresh.error)?.message)}
              </td>
            </tr>
          )}
          {loading && !selected.environments.length && (
            <tr>
              <td colSpan={4} className={styles.nestedMessage} role="status">
                {en ? "Discovering environments…" : "正在发现环境…"}
              </td>
            </tr>
          )}
          {!loading &&
            selected.status === "ready" &&
            !selected.environments.length && (
              <tr>
                <td colSpan={4} className={styles.nestedMessage}>
                  {source.id === "python"
                    ? en
                      ? "No standalone Python found. Conda and venv interpreters appear under their own sources."
                      : "未发现独立安装的 Python；Conda、venv 的解释器归入对应来源。"
                    : source.id === "venv"
                      ? en
                        ? "No project venv found. You can add an interpreter manually."
                        : "未发现项目虚拟环境，可手动添加解释器。"
                      : en
                        ? "No environments found"
                        : "未发现环境"}
                </td>
              </tr>
            )}
          {selected.environments.map((environment) => (
            <EnvironmentBranch
              key={`${environment.id}:${environment.cacheKey}`}
              environment={environment}
              expanded={expandedEnvironments.has(environment.id)}
              onToggle={() =>
                setExpandedEnvironments((previous) => {
                  const next = new Set(previous);
                  if (next.has(environment.id)) next.delete(environment.id);
                  else next.add(environment.id);
                  return next;
                })
              }
              {...shared}
            />
          ))}
        </>
      )}
    </>
  );
}
