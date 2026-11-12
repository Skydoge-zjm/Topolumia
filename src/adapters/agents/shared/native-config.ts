import path from "node:path";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { AgentProfile, NativeConfig } from "../../../domain/agents/agent-types.js";

export function mergeNativeConfig(base: unknown, override: Record<string, unknown> | undefined): NativeConfig {
  const object = base && typeof base === "object" && !Array.isArray(base) ? base as Record<string, unknown> : {};
  const result: Record<string, unknown> = { ...object };
  for (const [key, value] of Object.entries(override ?? {}))
    result[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? mergeNativeConfig(object[key], value as Record<string, unknown>)
        : value;
  return result;
}
export async function claudeSettingsFile(profile: AgentProfile, sessionAllows: Set<string>) {
  if (!profile.nativeConfigFile) return null;
  if (!sessionAllows.size) return profile.nativeConfigFile;
  const config = profile.nativeConfig ?? {};
  const permissions = Array.isArray(config.permissions) ? undefined : config.permissions;
  const allow = Array.isArray(permissions?.allow)
    ? permissions.allow
    : [];
  const settings = mergeNativeConfig(config, {
    permissions: { allow: [...new Set([...allow, ...sessionAllows])] },
  });
  const content = JSON.stringify(settings, null, 2) + "\n";
  const hash = createHash("sha256").update(content).digest("hex"),
    directory = path.dirname(profile.nativeConfigFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `snapshots-session-${hash}-settings.json`),
    temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
  return file;
}
