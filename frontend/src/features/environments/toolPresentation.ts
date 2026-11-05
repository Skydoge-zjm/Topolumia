import type { ToolItem, ToolsEnvironment } from "./types/tools";
export function toolPresentation(en: boolean, data?: ToolsEnvironment) {
  const inventory = { data };
  const label = (item: ToolItem) =>
    item.id === "workspace"
      ? en
        ? "Project directory"
        : "项目目录"
      : item.label;
  const category = (item: ToolItem) =>
    item.id === "node"
      ? en
        ? "Topolumia runtime"
        : "Topolumia 运行时"
      : {
          environment: en ? "Environment" : "基础环境",
          application: en ? "Topolumia runtime" : "Topolumia 运行时",
          development: en ? "Development" : "开发与执行",
          experiments: en ? "Experiments" : "实验工具",
          acceleration: en ? "GPU / CUDA" : "GPU 加速",
        }[item.category];
  const statusText = (status: ToolItem["status"]) =>
    ({
      unchecked: en ? "Pending" : "待检查",
      ready: en ? "Ready" : "可用",
      not_configured: en ? "Not set" : "未配置",
      unavailable: en ? "Error" : "需处理",
      installed: en ? "Installed" : "已安装",
      not_installed: en ? "Not installed" : "未安装",
      pending: en ? "Pending" : "待检测",
      checking: en ? "Checking" : "检测中",
      error: en ? "Error" : "检测失败",
      timeout: en ? "Timed out" : "超时",
    })[status];
  const date = (value: string | null, compact = false) =>
    value
      ? new Date(value).toLocaleString(
          en ? "en-US" : "zh-CN",
          compact
            ? {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              }
            : { hour12: false },
        )
      : en
        ? "Not checked"
        : "未检查";
  const version = (item: ToolItem) =>
    item.version ??
    (item.status === "ready" &&
    ["node", "python", "git", "docker"].includes(item.id)
      ? item.detail.match(/\bv?\d+\.\d+(?:\.\d+)*(?:[-.][A-Za-z][\w.-]*)?/)?.[0]
      : undefined);
  const location = (item: ToolItem) =>
    item.location ||
    (item.id === "workspace" || item.id === "git"
      ? (inventory.data?.project.directory ?? "—")
      : item.configuration?.baseUrl ||
        item.configuration?.logdir ||
        item.configuration?.command ||
        (item.id === "docker"
          ? en
            ? "Local Docker Engine"
            : "本机 Docker Engine"
          : "—"));
  const summary = (item: ToolItem) =>
    item.connection
      ? `${version(item) ?? "—"} · ${item.connection.status === "not_configured" ? (en ? "Connection not set" : "连接未配置") : item.connection.status === "ready" ? (en ? "Connected" : "已连接") : item.connection.status === "unchecked" ? (en ? "Connection unchecked" : "连接未检查") : en ? "Connection unavailable" : "连接不可用"}`
      : (item.summary ??
        version(item) ??
        (item.component ? "—" : location(item)));
  return { label, category, statusText, date, version, location, summary };
}
