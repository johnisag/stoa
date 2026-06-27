/**
 * Pure cache transforms for optimistic session mutations. Kept separate from the
 * react-query hooks so the list-rewrite logic (delete removal, move re-grouping)
 * is deterministic and unit-testable without a query client. Each takes the
 * cached SessionsResponse (possibly undefined while the query is still loading)
 * and returns a new one — never mutating the input.
 */

import type { Session, Group } from "@/lib/db";

export interface SessionsCache {
  sessions: Session[];
  groups: Group[];
  /** Server-resolved absolute home dir + OS case-sensitivity, so client-side path
   * comparison (e.g. the worktree-conflict detector) can canonicalize the same
   * way the server does. Optional: preserved across optimistic spreads, absent
   * only until the first fetch resolves. */
  homeDir?: string;
  isWindows?: boolean;
}

/** Optimistic delete: drop a session from the cached list. */
export function removeSessionFromCache(
  data: SessionsCache | undefined,
  sessionId: string
): SessionsCache | undefined {
  if (!data) return data;
  return {
    ...data,
    sessions: data.sessions.filter((s) => s.id !== sessionId),
  };
}

/** Optimistic rename/move: patch one session's fields in place. */
export function patchSessionInCache(
  data: SessionsCache | undefined,
  sessionId: string,
  patch: Partial<Session>
): SessionsCache | undefined {
  if (!data) return data;
  return {
    ...data,
    sessions: data.sessions.map((s) =>
      s.id === sessionId ? { ...s, ...patch } : s
    ),
  };
}
