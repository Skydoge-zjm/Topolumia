import { AppError } from "../../lib/errors.js";
import type { ActorIdentity, ResearchActor } from "./types.js";
export function fail(code: string, message: string, status = 422, detail: unknown = undefined): never { throw new AppError(code, message, { status, detail }); }
export function hasPermission(actor: ResearchActor | null | undefined, permission: string) { return Boolean(actor?.isServerAdmin || actor?.permissions?.includes("*") || actor?.permissions?.includes(permission)); }
export function requirePermission(actor: ResearchActor | null | undefined, permission: string): asserts actor is ResearchActor {
  if (!actor) fail("AUTH_REQUIRED", "Authentication required.", 401);
  if (!hasPermission(actor, permission)) fail("FORBIDDEN", `Permission required: ${permission}`, 403);
}
export function principal(actor: ResearchActor): string { return actor.principalId ?? actor.user?.id ?? actor.id ?? fail("AUTH_REQUIRED", "An identified research actor is required.", 401); }
export function actorIdentity(actor: ResearchActor): ActorIdentity { return { actorType: actor.isAgent ? "agent" : "human", actorId: actor.user?.id ?? actor.id ?? principal(actor), principalId: principal(actor), projectId: actor.projectId, sessionId: actor.sessionId ?? null, name: actor.user?.displayName ?? actor.name ?? "Researcher" }; }
