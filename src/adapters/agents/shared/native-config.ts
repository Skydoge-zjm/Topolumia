import path from "node:path";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

export function mergeNativeConfig(base, override) {
  if (!base || typeof base !== "object" || Array.isArray(base)) base = {};
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {}))
    result[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? mergeNativeConfig(base[key], value)
        : value;
  return result;
}
export async function claudeSettingsFile(profile, sessionAllows) {
  if (!profile.nativeConfigFile) return null;
  if (!sessionAllows.size) return profile.nativeConfigFile;
  const config = profile.nativeConfig ?? {};
  const allow = Array.isArray(config.permissions?.allow)
    ? config.permissions.allow
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
