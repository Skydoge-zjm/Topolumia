/** Omit documentation annotations while retaining schema fields and validation keywords. */
export function compactSchemaOutput(value) {
  if (Array.isArray(value)) return value.map(compactSchemaOutput);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => !(["description", "title"].includes(key) && typeof item === "string") && !(key === "examples" && Array.isArray(item))).map(([key, item]) => [key, compactSchemaOutput(item)]));
}
