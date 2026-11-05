import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  PackageSearch,
} from "lucide-react";
import { api } from "@/shared/lib/api";
import { environmentHeaders } from "@/features/environments/ssh/ssh";
import type {
  CatalogEnvironment,
  CatalogInspection,
} from "@/features/environments/types/environmentCatalog";

import styles from "./EnvironmentTree.module.css";

import type { SharedProps } from "./types";
import { ComponentRow } from "./ComponentRow";

export function EnvironmentBranch({
  environment,
  expanded,
  onToggle,
  ...shared
}: SharedProps & {
  environment: CatalogEnvironment;
  expanded: boolean;
  onToggle: () => void;
}) {
  const {
    project,
    en,
    canManage,
    currentId,
    onPackages,
    onActivate,
    activating,
  } = shared;
  const [missingOpen, setMissingOpen] = useState(false);
  const headers = environmentHeaders(project, shared.sshId);
  const client = useQueryClient();
  const key = [
    "environment-inspection",
    project,
    shared.sshId ?? "local",
    environment.id,
    environment.cacheKey,
  ];
  const endpoint = `/api/tools-environment/catalog/environments/${environment.id}`;
  const report = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<CatalogInspection>(endpoint, { headers, signal }),
    enabled: expanded,
    retry: false,
    refetchInterval: (query) =>
      expanded && query.state.data?.inspection.status === "running"
        ? 1100
        : false,
  });
  const check = useMutation({
    mutationFn: (componentId?: string) =>
      api<CatalogInspection>(`${endpoint}/check`, {
        method: "POST",
        headers,
        body: JSON.stringify(
          componentId ? { componentId, refresh: true } : { refresh: true },
        ),
      }),
    onSuccess: (data) => client.setQueryData(key, data),
  });
  const startCheck = check.mutate;
  const automatic = useRef(new Set<string>());
  useEffect(() => {
    if (
      expanded &&
      environment.hasPython &&
      canManage &&
      report.data &&
      !automatic.current.has(report.data.inspection.fingerprint) &&
      (report.data.inspection.status === "idle" || report.data.inspection.stale)
    ) {
      automatic.current.add(report.data.inspection.fingerprint);
      startCheck(undefined);
    }
  }, [expanded, environment.hasPython, canManage, report.data, startCheck]);
  const inspection = report.data?.inspection;
  const python = inspection?.components.find(
    (component) => component.id === "python",
  );
  const components =
    inspection?.components.filter(
      (component) => component.id !== "python" && component.scope !== "host",
    ) ?? [];
  const missing = components.filter(
    (component) => component.status === "not_installed",
  );
  const shown = components.filter(
    (component) => component.status !== "not_installed",
  );
  const busy = check.isPending || inspection?.status === "running";
  const current = environment.id === currentId;
  const version = python?.version ?? environment.version;
  const status = !environment.hasPython
    ? en
      ? "No Python"
      : "未安装 Python"
    : busy
      ? en
        ? "Checking"
        : "检测中"
      : inspection?.status === "completed" || environment.checkedAt
        ? en
          ? "Checked"
          : "已检测"
        : en
          ? "Not checked"
          : "未检测";
  return (
    <>
      <tr className={styles.environmentRow} data-current={current || undefined}>
        <th scope="row">
          <button
            className={styles.rowName}
            aria-label={
              en
                ? `Expand environment ${environment.name}`
                : `展开环境 ${environment.name}`
            }
            aria-expanded={expanded}
            onClick={onToggle}
            title={environment.prefix}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{environment.name}</span>
            {current && (
              <span className={styles.tag}>{en ? "Current" : "当前"}</span>
            )}
            {environment.manager === "uv" && (
              <span className={styles.tag}>uv</span>
            )}
          </button>
        </th>
        <td className={styles.version}>{version ?? "—"}</td>
        <td>
          <span
            className={styles.componentStatus}
            data-status={busy ? "checking" : (python?.status ?? "unchecked")}
          >
            {busy && <LoaderCircle size={12} className={styles.spinning} />}
            {status}
          </span>
        </td>
        <td className={styles.actionCell}>
          {current ? (
            <span className={styles.secondary}>
              {en ? "Project current" : "项目当前"}
            </span>
          ) : (
            canManage && (
              <button
                className="button"
                disabled={!environment.hasPython || Boolean(activating)}
                onClick={() => onActivate(environment)}
              >
                {activating === environment.id
                  ? en
                    ? "Verifying…"
                    : "验证中…"
                  : en
                    ? "Use environment"
                    : "设为当前"}
              </button>
            )
          )}
        </td>
      </tr>
      {expanded && (
        <>
          <tr className={styles.environmentContext}>
            <td colSpan={4}>
              <div className={styles.contextPath}>{environment.prefix}</div>
              <div className={styles.environmentActions}>
                <button
                  className="button"
                  onClick={() => onPackages(environment)}
                >
                  <PackageSearch size={14} />
                  {en ? "View all packages and versions" : "查看所有包及版本"}
                </button>
                {canManage && (
                  <button
                    className="button"
                    disabled={busy || !environment.hasPython}
                    onClick={() => startCheck(undefined)}
                  >
                    <RefreshCw size={14} />
                    {en ? "Check components" : "重新检测组件"}
                  </button>
                )}
                {inspection?.checkedAt && (
                  <time dateTime={inspection.checkedAt}>
                    {new Date(inspection.checkedAt).toLocaleString(
                      en ? "en-US" : "zh-CN",
                    )}
                  </time>
                )}
              </div>
            </td>
          </tr>
          {report.isPending && (
            <tr>
              <td colSpan={4} className={styles.nestedMessage} role="status">
                {en
                  ? "Reading environment diagnostics…"
                  : "正在读取环境检测结果…"}
              </td>
            </tr>
          )}
          {(report.error || check.error) && (
            <tr>
              <td colSpan={4} className={styles.nestedMessage} role="alert">
                {en
                  ? "Environment inspection failed. You can retry."
                  : (report.error ?? check.error)?.message}
                <button
                  className={styles.textButton}
                  onClick={() => {
                    void report.refetch();
                    if (canManage) startCheck(undefined);
                  }}
                >
                  {en ? "Retry" : "重试"}
                </button>
              </td>
            </tr>
          )}
          {!environment.hasPython && (
            <tr>
              <td colSpan={4} className={styles.nestedMessage}>
                {en
                  ? "Python is missing. The Conda package inventory is still available."
                  : "此环境未安装 Python，仍可查看 Conda 包清单。"}
              </td>
            </tr>
          )}
          {inspection?.status === "idle" && !canManage && (
            <tr>
              <td colSpan={4} className={styles.nestedMessage}>
                {en
                  ? "A project administrator can run environment checks."
                  : "项目管理员检测后可查看此环境的组件。"}
              </td>
            </tr>
          )}
          {python && ["error", "timeout"].includes(python.status) && (
            <tr>
              <td colSpan={4} className={styles.nestedMessage}>
                {en
                  ? "Python could not complete diagnostics. Other environments are unaffected."
                  : (python.detail ?? "此环境的 Python 检测失败。")}
              </td>
            </tr>
          )}
          {shown.map((component) => (
            <ComponentRow
              key={component.id}
              component={component}
              en={en}
              onCheck={() => startCheck(component.id)}
            />
          ))}
          {missing.length > 0 && (
            <tr>
              <td colSpan={4} className={styles.missingRow}>
                <button
                  className={styles.rowName}
                  aria-expanded={missingOpen}
                  onClick={() => setMissingOpen((value) => !value)}
                >
                  {missingOpen ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )}
                  {en
                    ? `Common components not installed · ${missing.length}`
                    : `未安装的常用组件 · ${missing.length} 项`}
                </button>
              </td>
            </tr>
          )}
          {missingOpen &&
            missing.map((component) => (
              <ComponentRow
                key={component.id}
                component={component}
                en={en}
                onCheck={() => startCheck(component.id)}
              />
            ))}
        </>
      )}
    </>
  );
}
