/** Omit documentation annotations while retaining schema fields and validation keywords. */
function stripAnnotations(value) {
  if (Array.isArray(value)) return value.map(stripAnnotations);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          !(
            ["description", "title"].includes(key) && typeof item === "string"
          ) && !(key === "examples" && Array.isArray(item)),
      )
      .map(([key, item]) => [
        key,
        ["const", "enum", "default"].includes(key)
          ? item
          : stripAnnotations(item),
      ]),
  );
}

export function compactSchemaOutput(value) {
  const schema = stripAnnotations(value);
  if (!schema?.$defs || typeof schema.$defs !== "object") return schema;
  const names = new Map<string, string>();
  const definitions = new Map<string, unknown>();
  const identities = new Map<string, string>();
  for (const [name, definition] of Object.entries(schema.$defs)) {
    const identity = JSON.stringify(definition);
    let compactName = identities.get(identity);
    if (!compactName) {
      compactName = "s" + definitions.size;
      identities.set(identity, compactName);
      definitions.set(compactName, definition);
    }
    names.set(name, compactName);
  }
  const rewrite = (input) => {
    if (Array.isArray(input)) return input.map(rewrite);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input).map(([key, item]) => [
        key,
        ["const", "enum", "default"].includes(key)
          ? item
          : key === "$ref" && typeof item === "string"
            ? item.replace(/^#\/\$defs\/([^/]+)/, (prefix, encoded) => {
                const name = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
                return names.has(name) ? "#/$defs/" + names.get(name) : prefix;
              })
            : rewrite(item),
      ]),
    );
  };
  return rewrite({
    ...schema,
    $defs: Object.fromEntries(definitions),
  });
}
