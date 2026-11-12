import type { AgentModel } from "./agent-types.js";
import { AppError } from "../../lib/errors.js";

export interface AgentModelCatalog {
  models: Array<AgentModel & { reasoningEfforts: string[] }>;
  model: string | null;
  reasoningEfforts: string[];
}

export function resolveCatalogModel(models: AgentModel[], requested: string): string {
  const exact = models.find(model => model.id === requested);
  if (exact) return exact.id;
  const matches = models.filter(model => model.id.slice(model.id.indexOf("/") + 1) === requested);
  if (matches.length === 1) return matches[0].id;
  throw new AppError(matches.length > 1 ? "OPENCODE_MODEL_AMBIGUOUS" : "OPENCODE_MODEL_UNAVAILABLE",
    matches.length > 1 ? "多个 Provider 配置了同名模型，请选择完整的 provider/model。" : "所选模型不在已配置的模型列表中。", { status: 422 });
}
