import { AppError } from "../../lib/errors.js";
export function fail(code, message, status = 422, detail = undefined): never { throw new AppError(code, message, { status, detail }); }
export function hasPermission(actor, permission) { return Boolean(actor?.isServerAdmin || actor?.permissions?.includes("*") || actor?.permissions?.includes(permission)); }
export function requirePermission(actor, permission) {
  if (!actor) fail("AUTH_REQUIRED", "Authentication required.", 401);
  if (!hasPermission(actor, permission)) fail("FORBIDDEN", `Permission required: ${permission}`, 403);
}
export function principal(actor) { return actor.principalId ?? actor.user?.id ?? actor.id; }
export function actorIdentity(actor) { return { actorType: actor.isAgent ? "agent" : "human", actorId: actor.user?.id ?? actor.id, principalId: principal(actor), projectId: actor.projectId, sessionId: actor.sessionId ?? null, name: actor.user?.displayName ?? actor.name ?? "Researcher" }; }
