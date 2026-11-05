import type { CatalogEnvironment } from "@/features/environments/types/environmentCatalog";

export interface SharedProps {
  project: string;
  sshId?: string;
  en: boolean;
  canManage: boolean;
  currentId: string | null;
  onPackages: (environment: CatalogEnvironment) => void;
  onActivate: (environment: CatalogEnvironment) => void;
  activating: string | null;
}
