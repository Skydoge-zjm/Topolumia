import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import {
  X,
  RefreshCw,
  LoaderCircle,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { api } from "@/shared/lib/api";
import { environmentHeaders } from "@/features/environments/ssh/ssh";
import type {
  CatalogEnvironment,
  PackagePage,
} from "@/features/environments/types/environmentCatalog";
import styles from "../tree/EnvironmentTree.module.css";

export function EnvironmentPackagesDialog({
  environment,
  project,
  sshId,
  en,
  canManage,
  onClose,
}: {
  environment: CatalogEnvironment;
  project: string;
  sshId?: string;
  en: boolean;
  canManage: boolean;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const initialRequest = useRef(false);
  const client = useQueryClient();
  const prefix = [
    "environment-packages",
    project,
    sshId ?? "local",
    environment.id,
    environment.cacheKey,
  ];
  const key = [...prefix, query, offset];
  const headers = environmentHeaders(project, sshId);
  const endpoint = `/api/tools-environment/catalog/environments/${environment.id}/packages`;
  const inventory = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<PackagePage>(
        `${endpoint}?q=${encodeURIComponent(query)}&offset=${offset}&limit=50`,
        { headers, signal },
      ),
    refetchInterval: (q) => (q.state.data?.status === "running" ? 900 : false),
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: () =>
      api<PackagePage>(`${endpoint}/refresh`, {
        method: "POST",
        headers,
        body: "{}",
      }),
    onSuccess: (data) => {
      client.setQueryData(key, {
        ...data,
        items: [],
        offset,
        nextOffset: null,
      });
      void client.invalidateQueries({ queryKey: prefix });
    },
  });
  const startRefresh = refresh.mutate;
  useEffect(() => {
    if (
      inventory.data?.status === "unchecked" &&
      canManage &&
      !initialRequest.current
    ) {
      initialRequest.current = true;
      startRefresh();
    }
  }, [inventory.data?.status, canManage, startRefresh]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [search]);
  const data = inventory.data;
  const loading =
    inventory.isPending || refresh.isPending || data?.status === "running";
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content aria-describedby={undefined} className={styles.packageDialog}>
          <header className={styles.dialogHeader}>
            <div>
              <Dialog.Title>
                {environment.name} ·{" "}
                {en ? "All packages and versions" : "全部包与版本"}
              </Dialog.Title>

            </div>
            <Dialog.Close
              className={styles.iconButton}
              aria-label={en ? "Close package inventory" : "关闭包清单"}
            >
              <X size={18} />
            </Dialog.Close>
          </header>
          <code className={styles.packagePath}>{environment.prefix}</code>
          <div className={styles.packageToolbar}>
            <label className={styles.search}>
              <span className={styles.srOnly}>
                {en ? "Search packages" : "搜索包名"}
              </span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={en ? "Search package names" : "搜索包名"}
                autoComplete="off"
              />
            </label>
            {canManage && (
              <button
                className="button"
                disabled={loading}
                onClick={() => refresh.mutate()}
              >
                <RefreshCw size={14} />
                {en ? "Refresh inventory" : "刷新包清单"}
              </button>
            )}
          </div>
          <div className={styles.packageMeta}>
            <span>
              {data?.kind === "conda-and-pip" ||
              (!data && environment.source === "conda")
                ? en
                  ? "Conda packages, including pip entries"
                  : "Conda 包清单，包含 pip 记录"
                : en
                  ? "Python distributions visible to this interpreter"
                  : "此解释器可见的 Python 发行包"}
            </span>
            {data?.checkedAt && (
              <time dateTime={data.checkedAt}>
                {new Date(data.checkedAt).toLocaleString(
                  en ? "en-US" : "zh-CN",
                )}
              </time>
            )}
          </div>
          <div className={styles.packageBody} aria-busy={loading}>
            {loading ? (
              <p className={styles.message} role="status">
                <LoaderCircle className={styles.spinning} size={17} />
                {en
                  ? "Reading this environment's package inventory…"
                  : "正在读取此环境的完整包清单…"}
              </p>
            ) : inventory.error || refresh.error || data?.status === "error" ? (
              <div className={styles.message} role="alert">
                <p>
                  {en
                    ? "The package inventory could not be read. Check the interpreter or Conda configuration and retry."
                    : (data?.detail ??
                      (inventory.error ?? refresh.error)?.message)}
                </p>
                <button
                  className="button"
                  onClick={() => {
                    if (canManage) refresh.mutate();
                    else void inventory.refetch();
                  }}
                >
                  {en ? "Retry" : "重试"}
                </button>
              </div>
            ) : data?.status === "unchecked" ? (
              <p className={styles.message}>
                {en
                  ? "No package inventory"
                  : "暂无包清单"}
              </p>
            ) : (
              <table
                className={styles.packageTable}
                aria-label={
                  en
                    ? "Installed package names and versions"
                    : "环境中的包及版本"
                }
              >
                <thead>
                  <tr>
                    <th scope="col">{en ? "Package" : "包名"}</th>
                    <th scope="col">{en ? "Version" : "版本"}</th>
                    <th scope="col">{en ? "Source" : "来源"}</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.items.map((item, index) => (
                    <tr key={`${item.name}:${item.version}:${index}`}>
                      <th scope="row">{item.name}</th>
                      <td>{item.version}</td>
                      <td>
                        {item.source === "conda"
                          ? "Conda"
                          : item.source === "pip"
                            ? "pip"
                            : "Python"}
                      </td>
                    </tr>
                  ))}
                  {data?.status === "completed" && !data.items.length && (
                    <tr>
                      <td colSpan={3}>
                        {search
                          ? en
                            ? "No matching packages"
                            : "没有匹配的包"
                          : en
                            ? "No installed distributions found"
                            : "未发现已安装的包"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
          <footer className={styles.packageFooter}>
            <span>
              {loading
                ? en
                  ? "Reading inventory…"
                  : "正在读取清单…"
                : data?.status === "completed"
                  ? en
                    ? `${data.matched} matches / ${data.total} packages`
                    : `匹配 ${data.matched} 项 / 共 ${data.total} 个包`
                  : en
                    ? "No verified inventory"
                    : "尚无有效清单"}
            </span>
            {data?.status === "completed" && (
              <div>
                <button
                  className="button"
                  aria-label={en ? "Previous package page" : "上一页包"}
                  disabled={loading || offset === 0}
                  onClick={() => setOffset((n) => Math.max(0, n - 50))}
                >
                  <ChevronLeft size={15} />
                </button>
                <span>{Math.floor(offset / 50) + 1}</span>
                <button
                  className="button"
                  aria-label={en ? "Next package page" : "下一页包"}
                  disabled={loading || data?.nextOffset == null}
                  onClick={() => setOffset(data?.nextOffset ?? 0)}
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
