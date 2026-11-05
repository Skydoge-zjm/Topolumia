import { Fragment, useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "@/shared/lib/api";
import { environmentHeaders } from "@/features/environments/ssh/ssh";
import type {
  EnvironmentCatalog,
  CatalogEnvironment,
} from "@/features/environments/types/environmentCatalog";

import { EnvironmentPackagesDialog } from "../packages/EnvironmentPackagesDialog";
import styles from "./EnvironmentTree.module.css";
import { sourceLabel, currentName } from "./presentation";

import { SourceBranch } from "./SourceBranch";
export function EnvironmentTree({
  project,
  scope,
  en,
  canManage,
  onConfigure,
  onActivated,
  sshId,
  showCurrent = true,
}: {
  project: string;
  scope: string;
  sshId?: string;
  showCurrent?: boolean;
  en: boolean;
  canManage: boolean;
  onConfigure: (id: string, trigger: HTMLElement) => void;
  onActivated: () => void;
}) {
  const client = useQueryClient();
  const key = ["environment-catalog", project, sshId ?? "local"];
  const headers = environmentHeaders(project, sshId);
  const catalog = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<EnvironmentCatalog>("/api/tools-environment/catalog", {
        headers,
        signal,
      }),
    retry: false,
  });
  const setCatalog = useCallback(
    (data: EnvironmentCatalog) =>
      client.setQueryData(
        ["environment-catalog", project, sshId ?? "local"],
        data,
      ),
    [client, project, sshId],
  );
  const [packages, setPackages] = useState<CatalogEnvironment | null>(null);
  const [adding, setAdding] = useState(false);
  const [command, setCommand] = useState("");
  const [notice, setNotice] = useState("");
  const activate = useMutation({
    mutationFn: (environment: CatalogEnvironment) =>
      api<EnvironmentCatalog>(
        `/api/tools-environment/catalog/environments/${environment.id}/activate`,
        { method: "POST", headers, body: "{}" },
      ),
    onSuccess: (data) => {
      setCatalog(data);
      onActivated();
      setNotice(
        en
          ? "Project environment updated."
          : "项目当前环境已更新。查看其它环境仍可继续。",
      );
    },
  });
  const register = useMutation({
    mutationFn: () =>
      api<{ catalog: EnvironmentCatalog; environment: CatalogEnvironment }>(
        "/api/tools-environment/catalog/register",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ pythonCommand: command }),
        },
      ),
    onSuccess: (data) => {
      setCatalog(data.catalog);
      void client.invalidateQueries({ queryKey: key });
      setAdding(false);
      setNotice(
        en
          ? "Interpreter added."
          : "解释器已添加。",
      );
    },
  });
  return (
    <section
      className={styles.environmentSection}
      aria-label={en ? "Research environments" : "科研环境"}
      data-scope={scope}
    >
      <div className={styles.sectionHeading}>
        <div>
          <h2>{en ? "Research environments" : "科研环境"}</h2>

        </div>
        {canManage && (
          <button
            className="button"
            onClick={() => {
              setAdding((value) => !value);
              register.reset();
            }}
          >
            <Plus size={14} />
            {en ? "Add interpreter" : "添加解释器"}
          </button>
        )}
      </div>
          {showCurrent && (
            <div className={styles.currentEnvironment}>
              {en ? "Project current" : "项目当前环境"}：
              <strong>
                {catalog.data
                  ? currentName(catalog.data.current.name, en)
                  : "…"}
              </strong>
              {catalog.data &&
                (catalog.data.current.source ||
                  catalog.data.current.selection.kind === "conda") && (
                  <span className={styles.tag}>
                    {sourceLabel(catalog.data.current.source ?? "conda", en)}
                  </span>
                )}
            </div>
          )}
      {adding && (
        <form
          className={styles.addInterpreter}
          onSubmit={(event) => {
            event.preventDefault();
            register.mutate();
          }}
        >
          <label className="form-field">
            {en ? "Python executable path" : "Python 可执行文件路径"}
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              required
              maxLength={500}
              autoComplete="off"
              placeholder={en ? "Full interpreter path" : "输入解释器完整路径"}
            />
          </label>
          <button className="button primary" disabled={register.isPending}>
            {register.isPending
              ? en
                ? "Verifying…"
                : "验证中…"
              : en
                ? "Verify and add"
                : "验证并添加"}
          </button>
          {register.error && <p role="alert">{register.error.message}</p>}
        </form>
      )}
      {(notice || activate.error) && (
        <p
          className={styles.treeNotice}
          role={activate.error ? "alert" : "status"}
        >
          {activate.error
            ? en
              ? "Environment validation failed. The previous project environment was preserved."
              : activate.error.message
            : notice}
        </p>
      )}
      {catalog.isPending ? (
        <p className={styles.message} role="status">
          {en ? "Reading environment sources…" : "正在读取环境来源…"}
        </p>
      ) : catalog.error ? (
        <div className={styles.message} role="alert">
          <p>{catalog.error.message}</p>
          <button className="button" onClick={() => void catalog.refetch()}>
            {en ? "Retry" : "重试"}
          </button>
        </div>
      ) : (
        catalog.data && (
          <div className={styles.treeScroll}>
            <table
              className={styles.treeTable}
              aria-label={en ? "Research environment tree" : "科研环境列表"}
            >
              <colgroup>
                <col className={styles.nameColumn} />
                <col className={styles.versionColumn} />
                <col className={styles.statusColumn} />
                <col className={styles.actionColumn} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">
                    {en ? "Environment / component" : "环境 / 组件"}
                  </th>
                  <th scope="col">{en ? "Version" : "版本"}</th>
                  <th scope="col">{en ? "Status" : "状态"}</th>
                  <th scope="col">{en ? "Actions" : "操作"}</th>
                </tr>
              </thead>
              <tbody>
                {catalog.data.sources.map((source) => (
                  <Fragment key={`${source.id}:${catalog.data!.fingerprint}`}>
                    <SourceBranch
                      source={source}
                      catalog={catalog.data!}
                      project={project}
                      sshId={sshId}
                      en={en}
                      canManage={canManage}
                      currentId={catalog.data!.current.id}
                      onCatalog={setCatalog}
                      onConfigure={onConfigure}
                      onPackages={setPackages}
                      onActivate={(environment) => {
                        activate.reset();
                        activate.mutate(environment);
                      }}
                      activating={
                        activate.isPending
                          ? (activate.variables?.id ?? null)
                          : null
                      }
                    />
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {packages && (
        <EnvironmentPackagesDialog
          key={`${packages.id}:${packages.cacheKey}`}
          environment={packages}
          project={project}
          sshId={sshId}
          en={en}
          canManage={canManage}
          onClose={() => setPackages(null)}
        />
      )}
    </section>
  );
}
