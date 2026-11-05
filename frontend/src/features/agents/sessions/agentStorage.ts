import { projectId } from "../../../shared/lib/api";

export function agentStorageKey(part: string, sessionId = "") {
  return `topolumia:agent:v1:${localStorage.getItem("topolumia-actor-id") ?? "local"}:${projectId()}:${part}:${sessionId}`;
}
export function readAgentStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function writeAgentStorage(key: string, value: unknown) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* The current draft/view remains usable when browser storage is full. */
  }
}
