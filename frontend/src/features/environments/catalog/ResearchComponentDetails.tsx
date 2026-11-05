import type { ResearchComponent } from "@/features/environments/types/researchEnvironment";
import { componentStatus } from "@/features/environments/types/researchEnvironment";
import styles from "@/features/environments/ToolsTable.module.css";
export function ResearchComponentDetails({
  component,
  environmentName,
  en,
  onRetry,
}: {
  component: ResearchComponent;
  environmentName: string;
  en: boolean;
  onRetry?: () => void;
}) {
  const c = component;
  const facts: Array<[string, string | number | null | undefined]> = [
    [
      en ? "Scope" : "检测范围",
      c.scope === "host"
        ? en
          ? "Execution host"
          : "执行主机"
        : environmentName,
    ],
    [en ? "Status" : "状态", componentStatus(c.status, en)],
    [en ? "Version" : "版本", c.version],
    [en ? "Location" : "位置", c.location],
    [
      en ? "Toolkit source" : "Toolkit 来源",
      c.origin === "host"
        ? en
          ? "Host"
          : "主机"
        : c.origin === "environment"
          ? environmentName
          : null,
    ],
    [
      en ? "Driver CUDA compatibility" : "驱动支持的 CUDA 上限",
      c.driverCudaMax,
    ],
    [en ? "Framework CUDA" : "框架 CUDA 运行库", c.cudaVersion],
    ["cuDNN", c.cudnnVersion],
    ["NCCL", c.ncclVersion],
    [
      en ? "GPU available" : "GPU 可用",
      c.gpuAvailable === undefined
        ? null
        : c.gpuAvailable
          ? en
            ? "Yes"
            : "是"
          : en
            ? "No"
            : "否",
    ],
    [
      en ? "GPU operation" : "GPU 运算验证",
      c.gpuTest
        ? ({
            passed: en ? "Passed" : "通过",
            failed: en ? "Failed" : "失败",
            unavailable: en ? "Unavailable" : "不可用",
            not_run: en ? "Not run" : "未执行",
          }[c.gpuTest] ?? c.gpuTest)
        : null,
    ],
    [
      en ? "Last checked" : "检测时间",
      c.checkedAt
        ? new Date(c.checkedAt).toLocaleString(en ? "en-US" : "zh-CN")
        : null,
    ],
  ];
  return (
    <section className={styles.detailSection}>
      <div className={styles.inspectionHeading}>
        <h3>{en ? "Component diagnostics" : "组件检测"}</h3>
        {onRetry && (
          <button
            className="button"
            onClick={onRetry}
            disabled={["pending", "checking"].includes(c.status)}
          >
            {en ? "Check again" : "重新检测此项"}
          </button>
        )}
      </div>
      <dl className={styles.facts}>
        {facts
          .filter(([, value]) => value !== null && value !== undefined)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      {c.detail && (
        <p className={styles.environmentHint}>
          {en && ["error", "unavailable", "timeout"].includes(c.status)
            ? "This component could not complete its check. Other results are retained."
            : c.detail}
        </p>
      )}
      {c.gpus?.map((gpu) => (
        <p key={gpu.index} className={styles.environmentHint}>
          {gpu.name} · {gpu.freeMiB ?? "?"} / {gpu.totalMiB ?? "?"} MiB{" "}
          {en ? "free" : "可用"}
        </p>
      ))}
      {c.devices?.map((device, i) => (
        <p key={i} className={styles.environmentHint}>
          {device.name}
        </p>
      ))}
    </section>
  );
}
