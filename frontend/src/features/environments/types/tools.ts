import type { ResearchEnvironment } from "@/features/environments/types/researchEnvironment";
export interface ToolItem {
  id: string;
  label: string;
  description: string;
  status:
    | "unchecked"
    | "ready"
    | "not_configured"
    | "unavailable"
    | "installed"
    | "not_installed"
    | "pending"
    | "checking"
    | "error"
    | "timeout";
  detail: string;
  checkedAt: string | null;
  recovery: string | null;
  configurable: boolean;
  configuration: Record<string, string> | null;
  credential: { environmentVariable: string; available: boolean } | null;
  category:
    | "environment"
    | "development"
    | "experiments"
    | "acceleration"
    | "application";
  version?: string;
  location?: string;
  summary?: string;
  facts?: Array<{
    label: string;
    labelEn: string;
    value: string;
    valueEn?: string;
  }>;
  pythonInspection?: {
    status?: string;
    detail?: string;
    checkedAt: string;
    python?: {
      executable: string;
      version: string;
      prefix: string;
      kind: string;
    };
    frameworks: Array<{
      id: string;
      status: string;
      version?: string | null;
      detail?: string;
      gpuAvailable?: boolean | null;
      gpuTest?: string;
      cudaVersion?: string | null;
      cudnnVersion?: string | null;
      ncclVersion?: string | null;
      devices?: Array<{ name: string; memoryMiB?: number }>;
    }>;
  } | null;
  component?: import("@/features/environments/types/researchEnvironment").ResearchComponent;
  connection?: { status: string; detail?: string; checkedAt: string | null };
}
export interface ToolsEnvironment {
  schemaVersion: string;
  project: { id: string; name: string; directory: string };
  location: "local" | "ssh";
  locationName?: string;
  platform: string;
  environment: ToolItem[];
  tools: ToolItem[];
  researchEnvironment?: ResearchEnvironment;
}
