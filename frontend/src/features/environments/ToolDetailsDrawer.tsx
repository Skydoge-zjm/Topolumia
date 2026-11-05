import { useId, useRef } from "react";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import base from "@/shared/layout/SetupPage.module.css";
import styles from "./ToolsTable.module.css";

import type { Dispatch, SetStateAction, RefObject } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { ToolItem, ToolsEnvironment } from "./types/tools";
import { fields, errorMessage } from "./toolDefinitions";
import { toolPresentation } from "./toolPresentation";
import { ToolStatus } from "./ToolStatus";
type Props = {
  selected: ToolItem | null;
  en: boolean;
  canManage: boolean;
  online: boolean;
  busy: boolean;
  draft: Record<string, string>;
  notice: string;
  inventory?: ToolsEnvironment;
  check: UseMutationResult<ToolsEnvironment, Error, string | null>;
  configure: UseMutationResult<
    ToolsEnvironment,
    Error,
    { id: string; input: Record<string, string> }
  >;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  setDraft: Dispatch<SetStateAction<Record<string, string>>>;
  setNotice: Dispatch<SetStateAction<string>>;
};
export function ToolDetailsDrawer({
  selected,
  en,
  canManage,
  online,
  busy,
  draft,
  notice,
  inventory,
  check,
  configure,
  returnFocus,
  onClose,
  setDraft,
  setNotice,
}: Props) {
  const formId = useId();
  const drawerTitle = useRef<HTMLHeadingElement | null>(null);
  const { label, statusText, date, version, location } =
    toolPresentation(en, inventory);
  const status = (item: ToolItem) => <ToolStatus item={item} en={en} />;
  return (
    <Dialog.Root
      open={Boolean(selected)}
      onOpenChange={(open) => {
        if (!open && !configure.isPending) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content aria-describedby={undefined}
          className={styles.drawer}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            drawerTitle.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (configure.isPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (configure.isPending) event.preventDefault();
          }}
        >
          {selected && (
            <>
              <header className={styles.drawerHeader}>
                <div className={styles.drawerHeading}>
                  <Dialog.Title ref={drawerTitle} tabIndex={-1}>
                    {label(selected)}
                  </Dialog.Title>
                  {status(selected)}
                </div>

                <Dialog.Close asChild>
                  <button
                    className={styles.close}
                    aria-label={en ? "Close details" : "关闭详情"}
                    disabled={configure.isPending}
                  >
                    <X size={18} />
                  </button>
                </Dialog.Close>
              </header>
              <div className={styles.drawerBody}>
                <dl className={styles.facts}>
                  {version(selected) && (
                    <div>
                      <dt>{en ? "Version" : "版本"}</dt>
                      <dd>{version(selected)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>{en ? "Location / command" : "连接位置 / 命令"}</dt>
                    <dd>{location(selected)}</dd>
                  </div>
                  <div>
                    <dt>{en ? "Last checked" : "最近检查"}</dt>
                    <dd>{date(selected.checkedAt)}</dd>
                  </div>
                </dl>
                {selected.facts?.length ? (
                  <section className={styles.detailSection}>
                    <h3>{en ? "Environment details" : "环境信息"}</h3>
                    <dl className={styles.facts}>
                      {selected.facts
                        .filter((fact) => fact.value !== location(selected))
                        .map((fact, index) => (
                          <div key={`${fact.label}-${index}`}>
                            <dt>{en ? fact.labelEn : fact.label}</dt>
                            <dd>
                              {en ? (fact.valueEn ?? fact.value) : fact.value}
                            </dd>
                          </div>
                        ))}
                    </dl>
                  </section>
                ) : null}
                {selected.id === "nvidia" && (
                  <p className={base.detail}>
                    {en
                      ? "Driver CUDA compatibility is separate from installed CUDA Toolkit and framework runtimes."
                      : "驱动支持的 CUDA 上限、已安装 Toolkit 和框架运行库是不同信息。"}
                  </p>
                )}
                {selected.connection && (
                  <section className={styles.detailSection}>
                    <h3>{en ? "Adapter connection" : "适配器连接"}</h3>
                    <p className={base.detail}>
                      {statusText(
                        selected.connection.status as ToolItem["status"],
                      )}
                    </p>
                    <p className={base.detail}>{selected.connection.detail}</p>
                  </section>
                )}
                <section className={styles.detailSection}>
                  <h3>{en ? "Diagnostics" : "检查结果"}</h3>
                  <p className={base.detail}>
                    {selected.status === "unchecked"
                      ? en
                        ? "Not checked"
                        : "待检查"
                      : selected.status === "not_configured"
                        ? en
                          ? "Not configured"
                          : "尚未配置"
                        : selected.detail}
                  </p>
                  {selected.recovery && selected.status === "unavailable" && (
                    <p className={base.recovery}>{selected.recovery}</p>
                  )}
                </section>
                {selected.credential && (
                  <section className={styles.detailSection}>
                    <h3>{en ? "Authentication" : "认证"}</h3>
                    <p className={base.credential}>
                      <code>{selected.credential.environmentVariable}</code> ·{" "}
                      {selected.credential.available
                        ? en
                          ? "Available to workbench"
                          : "工作台可读取"
                        : en
                          ? "Not set"
                          : "未设置"}
                    </p>
                  </section>
                )}
                {selected.configurable && selected.id !== "python" && (
                  <section className={styles.detailSection}>
                    <h3>{en ? "Configuration" : "工具配置"}</h3>
                    {canManage && (online || Boolean(selected.connection)) ? (
                      <form
                        id={formId}
                        onSubmit={(event) => {
                          event.preventDefault();
                          configure.mutate({
                            id: selected.id,
                            input: { ...draft },
                          });
                        }}
                      >
                        {(fields[selected.id] ?? []).map((field) => (
                          <label className="form-field" key={field.key}>
                            {en ? field.en : field.zh}
                            <input
                              autoComplete="off"
                              type={field.key === "baseUrl" ? "url" : "text"}
                              value={draft[field.key] ?? ""}
                              maxLength={field.environmentVariable ? 120 : 500}
                              pattern={
                                field.environmentVariable
                                  ? "[A-Za-z_][A-Za-z0-9_]*"
                                  : undefined
                              }
                              required={field.required}
                              placeholder={field.placeholder}
                              disabled={configure.isPending}
                              onChange={(event) =>
                                setDraft((current) => ({
                                  ...current,
                                  [field.key]: event.target.value,
                                }))
                              }
                            />
                          </label>
                        ))}
                      </form>
                    ) : (
                      <dl className={styles.facts}>
                        {(fields[selected.id] ?? []).map((field) => (
                          <div key={field.key}>
                            <dt>{en ? field.en : field.zh}</dt>
                            <dd>
                              {selected.configuration?.[field.key] || "—"}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </section>
                )}
                {!canManage && (
                  <p className={base.readonly}>
                    {en
                      ? "A project administrator can configure tools and run checks."
                      : "项目管理员可配置工具并运行检查。"}
                  </p>
                )}
                {configure.error && (
                  <div className={base.error} role="alert">
                    {errorMessage(configure.error)}
                  </div>
                )}
                {check.error && (
                  <div className={base.error} role="alert">
                    {errorMessage(check.error)}
                  </div>
                )}
                {notice && (
                  <p className={base.notice} role="status">
                    {notice}
                  </p>
                )}
              </div>
              <footer className={styles.drawerFooter}>
                <Dialog.Close asChild>
                  <button className="button" disabled={configure.isPending}>
                    {en ? "Close" : "关闭"}
                  </button>
                </Dialog.Close>
                <div className={base.actions}>
                  {canManage && (
                    <button
                      className="button"
                      disabled={
                        busy ||
                        selected.status === "not_configured" ||
                        (!online &&
                          !selected.connection &&
                          selected.id !== "node")
                      }
                      onClick={() => {
                        setNotice("");
                        check.mutate(selected.id);
                      }}
                    >
                      {check.isPending && check.variables === selected.id
                        ? en
                          ? "Checking…"
                          : "检查中…"
                        : !selected.connection
                          ? en
                            ? "Check item"
                            : "检查此项"
                          : en
                            ? "Test connection"
                            : "测试连接"}
                    </button>
                  )}
                  {canManage &&
                    selected.configurable &&
                    selected.id !== "python" && (
                      <button
                        className="button primary"
                        type="submit"
                        form={formId}
                        disabled={busy || (!online && !selected.connection)}
                      >
                        {configure.isPending
                          ? en
                            ? "Saving and checking…"
                            : "正在保存并测试…"
                          : en
                            ? "Save and test"
                            : "保存并测试"}
                      </button>
                    )}
                </div>
              </footer>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
