import { createHash, randomUUID } from "node:crypto";

export function stableStringify(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export function sha256(value: unknown): string {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash("sha256").update(input).digest("hex");
}

export function versionHash(value: unknown): string {
  return `sha256:${sha256(stableStringify(value))}`;
}

export function compactId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}
