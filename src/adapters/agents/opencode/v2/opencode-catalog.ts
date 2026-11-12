import type { OpenCodeClient, ModelRef } from "@opencode/client";
import type { AgentModelCatalog } from "../../../../domain/agents/agent-model-catalog.js";
import { resolveCatalogModel } from "../../../../domain/agents/agent-model-catalog.js";
import type { AgentProfile } from "../../../../domain/agents/agent-types.js";
import { OpenCodeV2Server } from "./opencode-server.js";
import { AppError } from "../../../../lib/errors.js";

export async function readOpenCodeV2Catalog(client: OpenCodeClient, directory: string, preferred?: string): Promise<AgentModelCatalog> {
  const location = { directory };
  const [models, providers, selected] = await Promise.all([client.model.list({ location, types: ["chat"] }), client.provider.list({ location }), client.model.default({ location })]);
  const names = new Map(providers.data.map(provider => [provider.id, provider.name]));
  const choices = models.data.filter(model => model.enabled && model.status !== "deprecated" && model.capabilities.input.includes("text") && (!model.type || model.type === "chat"))
    .map(model => ({ id: `${model.providerID}/${model.id}`, label: `${model.name} · ${names.get(model.providerID) ?? model.providerID}`, reasoningEfforts: model.variants.map(variant => variant.id) }));
  if (!choices.length) throw new AppError("OPENCODE_V2_NO_MODELS", "OpenCode 2 没有可用的对话模型，请先配置 Provider。", { status: 503 });
  const defaultID = selected.data ? `${selected.data.providerID}/${selected.data.id}` : undefined;
  return { models: choices, model: preferred ? resolveCatalogModel(choices, preferred) : choices.find(model => model.id === defaultID)?.id ?? choices[0].id, reasoningEfforts: [] };
}

export function openCodeV2ModelRef(catalog: AgentModelCatalog, requested: string, variant?: string | null): ModelRef {
  const id = resolveCatalogModel(catalog.models, requested);
  const model = catalog.models.find(model => model.id === id)!;
  if (variant && !model.reasoningEfforts.includes(variant)) throw new AppError("OPENCODE_VARIANT_UNAVAILABLE", "所选 OpenCode 2 模型不支持该变体。", { status: 422 });
  const split = id.indexOf("/");
  return { providerID: id.slice(0, split), id: id.slice(split + 1), ...(variant ? { variant } : {}) };
}

export async function discoverOpenCodeV2Models(profile: AgentProfile, cwd: string): Promise<AgentModelCatalog> {
  const server = new OpenCodeV2Server();
  try { return await readOpenCodeV2Catalog(await server.start(profile, cwd), cwd, profile.model ?? undefined); }
  finally { await server.close(); }
}
