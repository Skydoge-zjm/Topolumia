export function redactAgentSecrets<T>(value: T): T;
export function redactAgentSecrets(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/rw_agent_[A-Za-z0-9_-]+/g, "[redacted-agent-credential]");
  if (Array.isArray(value)) return value.map(redactAgentSecrets);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const name = key.replace(/_/g, "").toUpperCase();
    const sensitive = ["TOPOLUMIASESSION", "AUTHORIZATION", "PASSWORD"].includes(name)
      || name.endsWith("APIKEY") || typeof item === "string" && name.endsWith("TOKEN");
    return [key, sensitive ? "[redacted]" : redactAgentSecrets(item)];
  }));
  return value;
}
