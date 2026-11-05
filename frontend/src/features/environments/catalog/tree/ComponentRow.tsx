import { useState } from "react";

import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";

import {
  componentStatus,
  type ResearchComponent,
} from "@/features/environments/types/researchEnvironment";
import { ResearchComponentDetails } from "../ResearchComponentDetails";

import styles from "./EnvironmentTree.module.css";
import { componentLabel } from "./presentation";

export function ComponentRow({
  component,
  en,
  onCheck,
}: {
  component: ResearchComponent;
  en: boolean;
  onCheck: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const name = componentLabel(component.id);
  return (
    <>
      <tr className={styles.componentRow}>
        <th scope="row">
          <button
            className={styles.rowName}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span>{name}</span>
          </button>
        </th>
        <td className={styles.version}>{component.version ?? "—"}</td>
        <td>
          <span
            className={styles.componentStatus}
            data-status={component.status}
          >
            {["pending", "checking"].includes(component.status) && (
              <LoaderCircle size={12} className={styles.spinning} />
            )}
            {componentStatus(component.status, en)}
          </span>
          {component.gpuAvailable !== undefined &&
            component.status === "ready" && (
              <small className={styles.secondary}>
                {component.gpuAvailable
                  ? en
                    ? "GPU available"
                    : "GPU 可用"
                  : en
                    ? "CPU available"
                    : "CPU 可用"}
              </small>
            )}
          {component.origin && (
            <small className={styles.secondary}>
              {component.origin === "host"
                ? en
                  ? "Provided by host"
                  : "主机提供"
                : en
                  ? "From this environment"
                  : "来自此环境"}
            </small>
          )}
        </td>
        <td className={styles.actionCell}>
          <button
            className={styles.textButton}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? (en ? "Hide" : "收起") : en ? "Details" : "详情"}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4} className={styles.componentDetail}>
            <ResearchComponentDetails
              component={component}
              environmentName={component.location ?? ""}
              en={en}
              onRetry={onCheck}
            />
          </td>
        </tr>
      )}
    </>
  );
}
