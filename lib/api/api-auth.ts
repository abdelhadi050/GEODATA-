/**
 * GEODATA HUB — API authentication / authorization guards (M3).
 *
 * Authentication identity ALWAYS comes from the server-side session
 * (NextAuth cookie → getSessionUser(), DB-fresh). User IDs, roles, and
 * organization IDs supplied by clients are never trusted — the actor's
 * organization is read from the database record on every request.
 */
import { getSessionUser, type SessionUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { can, type Capability } from "@/lib/rbac";

/** Require an authenticated, active session. Throws 401 otherwise. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw Errors.unauthenticated();
  return user;
}

/**
 * Require a capability for the DB-fresh role. Throws 403 otherwise.
 * Services keep their own checks (defense in depth); route handlers use
 * this to fail fast before doing any work.
 */
export function requireCapability(
  user: SessionUser,
  capability: Capability,
): SessionUser {
  if (!can(user.role, capability)) {
    throw Errors.forbidden("Your role cannot perform this action");
  }
  return user;
}
