type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask"; [key: string]: unknown };

export function openCodeV2PermissionValue(value: Record<string, any>) {
  const rules = value.permissions;
  if (!Array.isArray(rules)) return value.permission;
  if (rules.length === 1 && rules[0].action === "*" && rules[0].resource === "*") return rules[0].effect;
  return rules;
}

export function setOpenCodeV2Permission(value: Record<string, any>, effect: unknown) {
  const existing: Rule[] = Array.isArray(value.permissions) ? value.permissions : [];
  const exceptions = existing.filter(rule => rule.action !== "*" || rule.resource !== "*");
  const permissions = effect === undefined ? exceptions : [{ action: "*", resource: "*", effect }, ...exceptions];
  const next: Record<string, any> = { ...value, permissions: permissions.length ? permissions : undefined };
  delete next.permission;
  return next;
}
