export interface SessionRoleRecord {
  session_role?: string | null;
}

/** Legacy rows with no role are ordinary interactive sessions. Every explicit
 * non-interactive (including future/unknown) role is server-owned and hidden
 * from generic session surfaces. */
export function isInteractiveSessionRole(session: SessionRoleRecord): boolean {
  return !session.session_role || session.session_role === "interactive";
}
