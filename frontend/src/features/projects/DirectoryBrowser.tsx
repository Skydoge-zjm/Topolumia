import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Folder, ArrowUp, Home, ChevronRight } from "lucide-react";
import { api } from "@/shared/lib/api";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import type { DirectoryPage } from "./projectWorkspace";
import styles from "./ProjectWorkspace.module.css";

export function DirectoryBrowser({
  kind,
  connectionId = "",
  initialPath,
  en,
  onSelect,
  onClose,
}: {
  kind: "local" | "ssh";
  connectionId?: string;
  initialPath: string;
  en: boolean;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [location, setLocation] = useState(initialPath),
    [address, setAddress] = useState(initialPath),
    [offset, setOffset] = useState(0),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("");
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (list.current) list.current.scrollTop = 0;
  }, [location, filter, offset]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilter(search.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const query = useQuery({
    queryKey: [
      "project-directory",
      kind,
      connectionId,
      location,
      filter,
      offset,
    ],
    queryFn: ({ signal }) =>
      api<DirectoryPage>(
        "/api/project-workspaces/directories?" +
          new URLSearchParams({
            kind,
            connectionId,
            directory: location,
            q: filter,
            offset: String(offset),
          }),
        { signal },
      ),
    retry: false,
  });
  useEffect(() => {
    if (query.data?.directory)
      setAddress((current) =>
        !current || current === location ? query.data!.directory : current,
      );
  }, [query.data, location]);
  const open = (path: string) => {
    setLocation(path);
    setAddress(path);
    setOffset(0);
    setSearch("");
    setFilter("");
  };
  return (
    <ResearchDialog
      title={en ? "Select a directory" : "选择目录"}
      onClose={onClose}
      className={styles.directoryDialog}
    >
      <div className={styles.browser}>
        <div className={styles.browserContent}>
          <div className={styles.browserControls}>
            <div className={styles.pathRow}>
              <label className={styles.pathField}>
                {en ? "Directory path" : "目录路径"}
                <input
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.stopPropagation();
                      open(address.trim());
                    }
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <button
                type="button"
                className="button"
                onClick={() => open(address.trim())}
              >
                {en ? "Open" : "打开"}
              </button>
            </div>
            <div className={styles.browserNavigation}>
              <button type="button" className="button" onClick={() => open("")}>
                <Home size={16} aria-hidden />
                {en ? "Home" : "主目录"}
              </button>
              <button
                type="button"
                className="button"
                disabled={!query.data?.parent || query.isFetching}
                onClick={() => query.data?.parent && open(query.data.parent)}
              >
                <ArrowUp size={16} aria-hidden />
                {en ? "Parent" : "上一级"}
              </button>
              {query.data?.roots.map((root) => (
                <button
                  type="button"
                  className="button"
                  key={root.path}
                  onClick={() => open(root.path)}
                >
                  {root.name}
                </button>
              ))}
            </div>
            <label>
              {en ? "Find a folder" : "筛选文件夹"}
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>
          <div className={styles.browserResults}>
            <code
              className={styles.currentPath}
              title={query.data?.directory ?? location}
            >
              {query.data?.directory ?? location}
            </code>
            <div
              ref={list}
              className={styles.folderList}
              aria-label={en ? "Folders" : "文件夹"}
              aria-busy={query.isFetching}
            >
              {query.isPending && (
                <LoadingSkeleton
                  className={styles.folderLoading}
                  layout="rows"
                  label={en ? "Reading folders…" : "正在读取文件夹…"}
                />
              )}
              {query.error && (
                <div role="alert" className={styles.folderError}>
                  <div>{query.error.message}</div>
                  <button
                    type="button"
                    className="button"
                    onClick={() => void query.refetch()}
                  >
                    {en ? "Retry" : "重试"}
                  </button>
                </div>
              )}
              {query.data && !query.error && (
                <div
                  className={styles.folderEntries}
                  key={JSON.stringify([location, filter, offset])}
                >
                  {query.data.entries.map((entry) => (
                    <button
                      type="button"
                      key={entry.path}
                      onClick={() => open(entry.path)}
                    >
                      <Folder size={16} aria-hidden />
                      <span>{entry.name}</span>
                      <ChevronRight
                        size={16}
                        className={styles.folderArrow}
                        aria-hidden
                      />
                    </button>
                  ))}
                  {!query.data.entries.length && (
                    <p className={styles.emptyFolders}>
                      {filter
                        ? en
                          ? "No matching folders"
                          : "没有符合条件的文件夹"
                        : en
                          ? "No subfolders"
                          : "此目录没有子文件夹"}
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className={styles.browserMeta}>
              <span>
                {query.data &&
                  !query.error &&
                  (query.data.partial
                    ? en
                      ? "Many folders · narrow your search"
                      : "目录项较多，可筛选文件夹"
                    : en
                      ? `${query.data.total} folders`
                      : `${query.data.total} 个文件夹`)}
              </span>
              {query.data &&
                !query.error &&
                (offset > 0 || query.data.nextOffset !== null) && (
                  <div className={styles.browserTools}>
                    <button
                      type="button"
                      className="button"
                      disabled={!offset || query.isFetching}
                      onClick={() => setOffset(Math.max(0, offset - 100))}
                    >
                      {en ? "Previous" : "上一页"}
                    </button>
                    <span>
                      {query.data.total ? offset + 1 : 0}–
                      {offset + query.data.entries.length} / {query.data.total}
                    </span>
                    <button
                      type="button"
                      className="button"
                      disabled={
                        query.data.nextOffset === null || query.isFetching
                      }
                      onClick={() => setOffset(query.data!.nextOffset!)}
                    >
                      {en ? "Next" : "下一页"}
                    </button>
                  </div>
                )}
            </div>
          </div>
        </div>
        <footer className={styles.dialogActions}>
          <button type="button" className="button" onClick={onClose}>
            {en ? "Cancel" : "取消"}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={
              !query.data ||
              query.isFetching ||
              Boolean(query.error) ||
              address.trim() !== query.data.directory
            }
            onClick={() => query.data && onSelect(query.data.directory)}
          >
            {en ? "Use this directory" : "选择此目录"}
          </button>
        </footer>
      </div>
    </ResearchDialog>
  );
}
