export const scientificFactKeys = ["runName", "status", "group", "params", "metrics", "metricSummary", "protocol", "commit", "branch", "dirty"];

export function sourceCapabilities(source, indexedText = null) {
  const textAvailable = source.capabilities?.text ?? (typeof indexedText === "string" || typeof source.excerpt === "string");
  const factKeys = scientificFactKeys.filter(key => source[key] !== undefined);
  const originalAvailable = source.ref.startsWith("file:") && typeof source.locator === "string";
  const expectedVersion = source.version ?? (source.hash ? "sha256:" + source.hash : undefined);
  return {
    capabilities: { textAvailable, valuesAvailable: factKeys.length > 0, originalAvailable },
    ...(factKeys.length ? { factKeys } : {}),
    ...(textAvailable ? { readHint: { ref: source.ref, expectedVersion } } : factKeys.length ? { readHint: { ref: source.ref, expectedVersion, factPaths: factKeys.map(key => "/" + key).slice(0, 3) } } : {}),
    ...(originalAvailable ? { nativeReadHint: { path: source.locator, instruction: "Read this file using your native file/PDF/image tools. No text index is available unless textAvailable=true." } } : {}),
  };
}
