/** Keep validation errors actionable without requiring another schema lookup. */
export function inputIssues(schema, input, issues) {
  const unwrap = (node, value) => {
    for (;;) {
      if (["optional", "nullable", "default"].includes(node?.type)) node = node.unwrap ? node.unwrap() : node.removeDefault();
      else if (node?.type === "union" && node.def.discriminator) {
        const key = node.def.discriminator;
        node = node.options.find(option => option.shape[key]?.safeParse(value?.[key]).success);
      } else return node;
    }
  };
  return issues.slice(0, 6).map(issue => {
    let node = schema, value = input;
    for (const key of issue.path) {
      node = unwrap(node, value);
      node = typeof key === "number" ? node?.element : node?.shape?.[key] ?? node?.valueType;
      value = value?.[key];
    }
    node = unwrap(node, value);
    const allowedFields = node?.shape ? Object.keys(node.shape) : undefined;
    return {
      path: issue.path.join("."), message: issue.message,
      ...(issue.code === "unrecognized_keys" && allowedFields ? { allowedFields, recovery: "Use only these fields. Preserve other research details in freely titled content blocks." } : {}),
      ...(issue.values ? { allowedValues: issue.values } : {}),
    };
  });
}
