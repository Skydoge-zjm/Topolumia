import type {
  PythonSelection,
  ResearchEnvironment,
} from "./researchEnvironment";
export type EnvironmentSourceId = "python" | "conda" | "venv";
export interface CatalogEnvironment {
  id: string;
  cacheKey: string;
  source: EnvironmentSourceId;
  name: string;
  prefix: string;
  pythonCommand: string;
  selection: PythonSelection;
  manager: string;
  hasPython: boolean;
  current: boolean;
  version: string | null;
  inspectionStatus: ResearchEnvironment["status"];
  checkedAt: string | null;
}
export interface EnvironmentCatalog {
  schemaVersion: string;
  fingerprint: string;
  current: {
    id: string | null;
    name: string;
    selection: PythonSelection;
    source?: EnvironmentSourceId;
  };
  sources: Array<{
    id: EnvironmentSourceId;
    status: "unloaded" | "loading" | "ready" | "error";
    count: number | null;
    detail: string | null;
    environments: CatalogEnvironment[];
  }>;
}
export interface CatalogInspection {
  environment: CatalogEnvironment;
  inspection: ResearchEnvironment;
}
export interface PackagePage {
  environment: CatalogEnvironment;
  status: "unchecked" | "running" | "completed" | "error";
  kind: "conda-and-pip" | "python-distributions";
  checkedAt: string | null;
  detail: string | null;
  total: number;
  matched: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  items: Array<{
    name: string;
    version: string;
    source: "conda" | "pip" | "python";
  }>;
}
