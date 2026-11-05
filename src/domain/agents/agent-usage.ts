export interface AgentTokenCounts {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  uncachedInputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
}
export interface AgentUsageSnapshot {
  provider?: string;
  scope?: "step" | "turn" | "session";
  lastScope?: "step" | "turn" | null;
  costScope?: "step" | "turn" | "session";
  cost?: number | null;
  turnCost?: number | null;
  tokenUsage?: { last?: Partial<AgentTokenCounts>; total?: Partial<AgentTokenCounts> };
}
interface ClaudeNativeUsage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

export function claudeTokenCounts(usage: ClaudeNativeUsage = {}): AgentTokenCounts {
  const uncachedInputTokens = Number(usage.input_tokens ?? 0);
  const cachedInputTokens = Number(usage.cache_read_input_tokens ?? 0);
  const cacheWriteInputTokens = Number(usage.cache_creation_input_tokens ?? 0);
  const inputTokens = uncachedInputTokens + cachedInputTokens + cacheWriteInputTokens;
  const outputTokens = Number(usage.output_tokens ?? 0);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, uncachedInputTokens, cachedInputTokens, cacheWriteInputTokens };
}

export function tokenCountDelta(current: AgentTokenCounts, previous?: AgentTokenCounts): AgentTokenCounts | undefined {
  if (!previous || (Object.keys(current) as Array<keyof AgentTokenCounts>).some(key => Number(current[key]) < Number(previous[key] ?? 0))) return undefined;
  return Object.fromEntries((Object.entries(current) as Array<[keyof AgentTokenCounts, number]>).map(([key, value]) => [key, value - Number(previous[key] ?? 0)])) as unknown as AgentTokenCounts;
}
