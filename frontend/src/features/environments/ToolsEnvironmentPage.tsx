import { useSearchParams } from "react-router-dom";
import type { ToolItem, ToolsEnvironment } from "./types/tools";
export type { ToolItem, ToolsEnvironment } from "./types/tools";
import { errorMessage } from "./toolDefinitions";
import { toolPresentation } from "./toolPresentation";
import { ToolStatus } from "./ToolStatus";
import { ToolDetailsDrawer } from "./ToolDetailsDrawer";
import { useEffect, useRef, useState } from "react";
import {
  Boxes,
  ChevronDown,
  Cpu,
  FolderTree,
  Plug,
  RefreshCw,
  Server,
  Wrench,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, projectId } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import type { CollaborationContext } from "@/shared/types/api";
import base from "@/shared/layout/SetupPage.module.css";
import styles from "./ToolsTable.module.css";
import { EnvironmentTree } from "@/features/environments/catalog/tree/EnvironmentTree";
import { SshEnvironmentSelector } from "@/features/environments/ssh/SshEnvironmentSelector";
import { RecordCollectorsPanel } from "./RecordCollectorsPanel";
import { ProjectWorkspacePanel } from "@/features/projects/ProjectWorkspacePanel";
import {
  environmentHeaders,
  sshOverviewKey,
  type SshOverview,
} from "@/features/environments/ssh/ssh";

export function ToolsEnvironmentPage() {
  const en = useUiStore((state) => state.locale === "en");
  const currentProject = projectId();
  const [searchParams] = useSearchParams();
  const [workspaceEditing, setWorkspaceEditing] = useState(searchParams.get("workspace") === "edit");
  const queryClient = useQueryClient();
  const context = useQuery({
    queryKey: ["collaboration-context", currentProject],
    queryFn: () => api<CollaborationContext>("/api/collaboration/context"),
  });
  const [view, setView] = useState<{ project: string; id: string | null }>({ project: currentProject, id: searchParams.get("hostId") });
  const workspace = context.data?.project?.workspace;
  const preferredHost = workspace?.kind === "ssh" && workspace.ownerId === context.data?.actor?.id ? workspace.connectionId ?? "" : "";
  const sshId = view.project === currentProject ? view.id ?? preferredHost : preferredHost;
  const key = ["tools-environment", currentProject, sshId || "local"];
  const headers = environmentHeaders(currentProject, sshId);
  const inventory = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<ToolsEnvironment>("/api/tools-environment", { headers, signal }),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.researchEnvironment?.status === "running"
        ? 1200
        : false,
  });
  const canManage = Boolean(
    context.data?.permissions?.some((permission) =>
      ["*", "project.manageSettings"].includes(permission),
    ),
  );
  const actor = context.data?.actor?.id ?? "";
  const ssh = useQuery({
    queryKey: sshOverviewKey(currentProject, actor),
    queryFn: () => api<SshOverview>("/api/ssh/connections"),
    enabled: Boolean(actor),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.connections.some((p) =>
        ["connecting", "verify_host", "authentication"].includes(p.status),
      )
        ? 700
        : 5000,
  });
  const online =
    !sshId ||
    ssh.data?.connections.find((p) => p.id === sshId)?.status === "connected";
  const canInspect = canManage && online;
  useEffect(() => {
    if (!sshId) return;
    void queryClient.invalidateQueries({
      queryKey: ["tools-environment", currentProject, sshId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["environment-catalog", currentProject, sshId],
    });
  }, [online, sshId, currentProject, queryClient]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const returnFocus = useRef<HTMLElement | null>(null);

  const items = (
    inventory.data
      ? [...inventory.data.environment, ...inventory.data.tools]
      : []
  ).map((item) =>
    item.id === "cuda"
      ? {
          ...item,
          label: en ? "CUDA Toolkit command" : "CUDA Toolkit 命令",
          component: undefined,
          version: undefined,
          status: "unchecked" as ToolItem["status"],
          checkedAt: null,
          summary: item.configuration?.command ?? "nvcc",
        }
      : item.connection
        ? {
            ...item,
            component: undefined,
            status: item.connection.status as ToolItem["status"],
            detail: item.connection.detail ?? "",
            version: undefined,
            checkedAt: item.connection.checkedAt,
            summary:
              item.configuration?.baseUrl || item.configuration?.logdir || "—",
          }
        : item,
  );
  const { label, summary } = toolPresentation(en, inventory.data);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const check = useMutation({
    mutationFn: (toolId: string | null) =>
      api<ToolsEnvironment>("/api/tools-environment/check", {
        method: "POST",
        headers,
        body: JSON.stringify(toolId ? { toolId } : {}),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(key, data);
      setNotice(en ? "Checks completed." : "检查完成，结果已更新。");
    },
  });
  const configure = useMutation({
    mutationFn: async ({
      id,
      input,
    }: {
      id: string;
      input: Record<string, string>;
    }) => {
      await api<ToolsEnvironment>(
        `/api/tools-environment/tools/${encodeURIComponent(id)}`,
        { method: "PATCH", headers, body: JSON.stringify(input) },
      );
      return api<ToolsEnvironment>("/api/tools-environment/check", {
        method: "POST",
        headers,
        body: JSON.stringify({ toolId: id }),
      });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(key, data);
      setNotice(
        en
          ? "Configuration saved and checked."
          : "配置已保存，连接测试已完成。",
      );
      void queryClient.invalidateQueries({
        queryKey: ["environment-catalog", currentProject],
      });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const busy = check.isPending || configure.isPending;

  const status = (item: ToolItem) => <ToolStatus item={item} en={en} />;
  const readiness = (ids: string[]) => {
    const list = ids
      .map((id) => items.find((item) => item.id === id))
      .filter((item): item is ToolItem => Boolean(item));
    return {
      ready: list.filter((item) => ["ready", "installed"].includes(item.status))
        .length,
      missing: list.filter((item) =>
        ["unavailable", "error", "timeout", "not_installed"].includes(
          item.status,
        ),
      ).length,
      total: list.length,
    };
  };
  const allTools = readiness(items.map((item) => item.id));
  const hostLabel = sshId
    ? (ssh.data?.connections.find((item) => item.id === sshId)?.name ??
      (en ? "Remote host" : "远程主机"))
    : en
      ? "Local computer"
      : "本机";

  const openDetails = (item: ToolItem, trigger: HTMLElement | null) => {
    returnFocus.current = trigger;
    configure.reset();
    setNotice("");
    setDraft({ ...(item.configuration ?? {}) });
    setSelectedId(item.id);
  };
  const inspectLabel = (item: ToolItem) =>
    en ? `View ${label(item)} details` : `查看 ${label(item)} 详情`;
  return (
    <section
      className={base.page}
      data-testid="tools-environment-page"
      data-setup-page
    >
      <header className={`${base.header} ${styles.header}`}>
        <div className={styles.heading}>
          <h1>{en ? "Tools & environment" : "工具与环境"}</h1>
          {inventory.data && (
            <div className={styles.statusStrip}>
              <span className={styles.stripItem}>
                <Server size={13} aria-hidden="true" />
                {hostLabel}
              </span>
              <span className={styles.stripItem} title={inventory.data.project.directory}>
                <FolderTree size={13} aria-hidden="true" />
                <code>{inventory.data.project.directory}</code>
              </span>
              <span
                className={styles.stripItem}
                data-state={
                  allTools.missing
                    ? "attention"
                    : allTools.ready < allTools.total
                      ? "idle"
                      : "ready"
                }
              >
                <span className={styles.stripDot} aria-hidden="true" />
                {en
                  ? `${allTools.ready}/${allTools.total} tools ready`
                  : `工具可用 ${allTools.ready}/${allTools.total}`}
              </span>
            </div>
          )}
        </div>
        {inventory.data && (
          <button
            className="button"
            disabled={busy || !canInspect}
            onClick={() => check.mutate(null)}
          >
            <RefreshCw size={14} className={busy ? styles.spinning : undefined} />
            {en ? "Re-check tools" : "重新检查工具"}
          </button>
        )}
      </header>
      <ProjectWorkspacePanel en={en} editable editing={workspaceEditing} onEditingChange={setWorkspaceEditing} onSaved={location => setView({ project: currentProject, id: location.kind === "ssh" && location.ownerId === context.data?.actor?.id ? location.connectionId ?? "" : "" })} />
      <SshEnvironmentSelector
        overview={ssh.data}
        error={ssh.error}
        project={currentProject}
        actor={actor}
        en={en}
        canManage={canManage}
        selectedId={sshId}
        onConfigureDirectory={workspace?.kind === "ssh" && workspace.ownerId === actor && workspace.connectionId === sshId ? () => setWorkspaceEditing(true) : undefined}
        onSelect={(id) => {
          setSelectedId(null);
          setNotice("");
          setView({ project: currentProject, id });
        }}
        onRefresh={() => {
          void queryClient.invalidateQueries({ queryKey: key });
          void queryClient.invalidateQueries({
            queryKey: ["environment-catalog", currentProject],
          });
        }}
      />
      {inventory.isPending && !inventory.data && <LoadingSkeleton layout="rows" label={en ? "Loading tools and environment…" : "正在读取工具与环境…"} />}
      {inventory.error && (
        <div className={base.error} role="alert">
          {errorMessage(inventory.error)}
          <button className="button" onClick={() => void inventory.refetch()}>
            {en ? "Retry" : "重试"}
          </button>
        </div>
      )}
      {check.error && !selected && (
        <div className={base.error} role="alert">
          {errorMessage(check.error)}
        </div>
      )}
      {notice && !selected && (
        <p className={base.notice} role="status">
          {notice}
        </p>
      )}
      {inventory.data && (
        <>
          <RecordCollectorsPanel en={en} sshId={sshId} canManage={canManage && workspace?.kind !== "unassigned"} online={Boolean(online)} />
          <EnvironmentTree
            key={`${currentProject}:${actor}:${sshId}`}
            project={currentProject}
            scope={`${context.data?.actor?.id ?? ""}:${currentProject}`}
            en={en}
            canManage={canInspect}
            sshId={sshId || undefined}
            showCurrent={!ssh.data?.current}
            onConfigure={(id, trigger) => {
              const item = items.find((item) => item.id === id);
              if (item) openDetails(item, trigger);
            }}
            onActivated={() => {
              void queryClient.invalidateQueries({ queryKey: key });
              void queryClient.invalidateQueries({
                queryKey: sshOverviewKey(currentProject, actor),
              });
            }}
          />
          <section
            className={styles.toolSection}
            aria-label={en ? "Tool health" : "工具状态"}
          >
            <div className={styles.toolSectionHeading}>
              <h2>{en ? "Tools" : "工具"}</h2>
              <span>
                {`${allTools.total} · ${allTools.missing}`}
              </span>
            </div>
            <div className={styles.toolGroups}>
              {[
                {
                  name: en ? "Host resources" : "主机资源",
                  ids: ["nvidia"],
                  icon: Cpu,
                },
                {
                  name: en ? "Host tools" : "主机工具",
                  ids: ["git", "docker", "uv", "cuda"],
                  icon: Wrench,
                },
                {
                  name: en ? "Project service connections" : "项目服务连接",
                  ids: ["mlflow", "wandb", "tensorboard"],
                  icon: Plug,
                },
                {
                  name: sshId
                    ? en
                      ? "Topolumia runtime · local service"
                      : "Topolumia 运行时 · 本机服务"
                    : en
                      ? "Topolumia runtime"
                      : "Topolumia 运行时",
                  ids: ["node"],
                  icon: Boxes,
                },
              ].map((group) => {
                const health = readiness(group.ids),
                  Icon = group.icon;
                return (
                  <details
                    key={group.name}
                    className={styles.toolGroup}
                    data-state={
                      health.missing
                        ? "attention"
                        : health.ready < health.total
                          ? "idle"
                          : "ready"
                    }
                  >
                    <summary>
                      <span className={styles.groupIcon}>
                        <Icon size={14} aria-hidden="true" />
                      </span>
                      <span className={styles.groupTitle}>{group.name}</span>
                      <span className={styles.groupHealth}>
                        <b>{health.ready}</b>/
                        {health.total}
                      </span>
                      <ChevronDown
                        size={15}
                        className={styles.groupChevron}
                        aria-hidden="true"
                      />
                    </summary>
                    <ul>
                      {group.ids.map((id) => {
                        const item = items.find((item) => item.id === id);
                        if (!item) return null;
                        return (
                          <li key={id} className={styles.groupItem}>
                            <button
                              aria-label={inspectLabel(item)}
                              onClick={(event) =>
                                openDetails(item, event.currentTarget)
                              }
                            >
                              {label(item)}
                            </button>
                            <span className={styles.groupSummary}>
                              {summary(item)}
                            </span>
                            {status(item)}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                );
              })}
            </div>
          </section>
        </>
      )}
      <ToolDetailsDrawer
        selected={selected}
        en={en}
        canManage={canManage}
        online={online}
        busy={busy}
        draft={draft}
        notice={notice}
        inventory={inventory.data}
        check={check}
        configure={configure}
        returnFocus={returnFocus}
        onClose={() => setSelectedId(null)}
        setDraft={setDraft}
        setNotice={setNotice}
      />
    </section>
  );
}
