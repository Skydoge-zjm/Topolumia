import { type SshConnection } from "@/features/environments/ssh/ssh";

export const working = (p: SshConnection) =>
  ["connecting", "verify_host", "authentication"].includes(p.status);
export const statusLabel = (p: SshConnection, en: boolean) =>
  ({
    connected: en ? "Connected" : "已连接",
    disconnected: en ? "Disconnected" : "未连接",
    connecting: en ? "Connecting…" : "连接中…",
    verify_host: en ? "Verify host" : "待验证主机",
    authentication: en ? "Sign in" : "待登录",
    error: en ? "Connection failed" : "连接失败",
  })[p.status];
export const endpoint = (id: string, action = "") =>
  `/api/ssh/connections/${id}${action ? `/${action}` : ""}`;
export const message = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成";
