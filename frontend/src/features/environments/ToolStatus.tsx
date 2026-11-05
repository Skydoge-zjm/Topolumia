import { Check, CircleAlert, LoaderCircle } from "lucide-react";

import base from "@/shared/layout/SetupPage.module.css";
import styles from "./ToolsTable.module.css";

import type { ToolItem } from "./types/tools";
import { toolPresentation } from "./toolPresentation";
export function ToolStatus({ item, en }: { item: ToolItem; en: boolean }) {
  const { statusText } = toolPresentation(en);
  return (
    <span
      className={`${base.status} ${base[item.status === "installed" ? "ready" : ["error", "timeout"].includes(item.status) ? "unavailable" : ["pending", "checking"].includes(item.status) ? "unchecked" : item.status === "not_installed" ? "not_configured" : item.status]} ${styles.statusBadge}`}
    >
      {item.status === "checking" || item.status === "pending" ? (
        <LoaderCircle
          size={12}
          className={styles.checking}
          aria-hidden="true"
        />
      ) : item.status === "ready" || item.status === "installed" ? (
        <Check size={12} aria-hidden="true" />
      ) : item.status === "unavailable" ? (
        <CircleAlert size={12} aria-hidden="true" />
      ) : (
        <span className={base.dot} />
      )}
      {statusText(item.status)}
    </span>
  );
}
