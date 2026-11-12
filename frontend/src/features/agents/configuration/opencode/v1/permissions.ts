export function openCodeV1PermissionValue(value: Record<string, any>) {
  return value.permissions ?? value.permission;
}

export function setOpenCodeV1Permission(value: Record<string, any>, permission: unknown) {
  const next: Record<string, any> = { ...value, permission };
  delete next.permissions;
  return next;
}
