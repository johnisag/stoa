import type { Session } from "./db";
import { backendKeyForSession } from "./providers/registry";
import { isInteractiveSessionRole } from "./session-role";

export interface GenericSessionRouteFailure {
  error: string;
  status: 404 | 409;
}

/** Ordinary session routes must never observe or mutate a server-owned launch
 * profile. Internal sessions have a dedicated owner/API that preserves their
 * exact process identity, admission account, and recovery semantics. */
export function genericSessionRouteFailure(
  session: Session | undefined | null
): GenericSessionRouteFailure | null {
  if (!session) return { error: "Session not found", status: 404 };
  if (!isInteractiveSessionRole(session)) {
    return {
      error: "Internal sessions are managed only by their owning subsystem",
      status: 409,
    };
  }
  return null;
}

/** Type-narrowing companion for handlers after they have returned the failure
 * above. Throwing is unreachable unless a handler accidentally diverges from
 * the shared authorization decision. */
export function assertGenericSessionRouteAccess(
  session: Session | undefined | null
): asserts session is Session {
  const failure = genericSessionRouteFailure(session);
  if (failure) throw new Error(failure.error);
}

/** Resolve a backend key through the same canonical function used by every
 * session operation. SQL concatenation is intentionally not equivalent: an
 * unknown provider falls back to Claude in `backendKeyForSession`, and a raw
 * expression would miss that row and accidentally treat its key as unowned. */
export function backendKeyOwners(
  sessions: readonly Session[],
  key: string,
  excludeSessionId?: string
): Session[] {
  return sessions.filter(
    (session) =>
      session.id !== excludeSessionId && backendKeyForSession(session) === key
  );
}

/** Generic terminal access fails closed for both internal ownership and an
 * already-corrupt duplicate mapping. An unowned key remains valid for the
 * intentionally ephemeral shell surfaces. */
export function genericBackendKeyAccessFailure(
  sessions: readonly Session[],
  key: string
): string | null {
  const owners = backendKeyOwners(sessions, key);
  if (owners.some((session) => !isInteractiveSessionRole(session))) {
    return "Internal sessions cannot be attached through the generic terminal";
  }
  if (owners.length > 1) {
    return "Ambiguous session key cannot be attached through the generic terminal";
  }
  return null;
}
