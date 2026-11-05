export type PythonSelection =
  | { kind: "default" }
  | { kind: "conda"; prefix: string }
  | { kind: "custom"; pythonCommand: string };
export interface ResearchComponent {
  id: string;
  scope: "research" | "host";
  status: string;
  version?: string | null;
  location?: string;
  detail?: string;
  checkedAt: string | null;
  packageName?: string;
  origin?: "host" | "environment";
  python?: {
    executable: string;
    version: string;
    prefix: string;
    kind: string;
  };
  gpuAvailable?: boolean;
  gpuTest?: string;
  cudaVersion?: string | null;
  cudnnVersion?: string | null;
  ncclVersion?: string | null;
  driverCudaMax?: string | null;
  gpus?: Array<{
    index: number;
    name: string;
    totalMiB: number | null;
    freeMiB: number | null;
    driverVersion: string;
  }>;
  devices?: Array<{ name: string }>;
}
export interface ResearchEnvironment {
  schemaVersion: string;
  fingerprint: string;
  name: string;
  selection: PythonSelection;
  status: "idle" | "running" | "completed";
  startedAt: string | null;
  checkedAt: string | null;
  stale: boolean;
  components: ResearchComponent[];
}
export function componentStatus(status: string, en: boolean) {
  return ({
    pending: ["待检测", "Pending"],
    checking: ["检测中", "Checking"],
    ready: ["可用", "Ready"],
    installed: ["已安装", "Installed"],
    not_installed: ["未安装", "Not installed"],
    error: ["检测失败", "Check failed"],
    unavailable: ["不可用", "Unavailable"],
    timeout: ["超时", "Timed out"],
    unchecked: ["未检查", "Not checked"],
  }[status] ?? [status, status])[en ? 1 : 0];
}
