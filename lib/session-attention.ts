/**
 * "Needs attention" helpers for the session list — pure and deterministic so the
 * count + jump-to-next logic is unit-testable and shared between the header badge
 * and any keyboard shortcut. A session needs attention when it is WAITING for
 * input or has ERRORED.
 *
 * Client-safe: only a type-import of Session.
 */

import type { Session } from "./db";

export type SessionStatusValue =
  | "idle"
  | "running"
  | "waiting"
  | "error"
  | "dead";

/** Statuses keyed by session id (only the `status` field is needed here). */
type StatusMap = Record<string, { status: SessionStatusValue } | undefined>;

export function needsAttention(
  status: SessionStatusValue | undefined
): boolean {
  return status === "waiting" || status === "error";
}

/**
 * How many of the given sessions currently need attention (waiting or error).
 * Counts over the `sessions` list — the same set `nextAttentionSessionId` jumps
 * across — so the badge count never exceeds the reachable jump targets (the
 * raw status map can hold stale/orphaned entries not in the rendered list).
 */
export function countNeedsAttention(
  sessions: Session[],
  statuses: StatusMap | undefined
): number {
  if (!statuses) return 0;
  return sessions.filter((s) => needsAttention(statuses[s.id]?.status)).length;
}

/**
 * The id of the next session in `orderedIds` after `currentId` (wrapping) whose
 * status needs attention (waiting / error), or null when none do. From outside the
 * set (or no current) it starts at the first attention session. The single jump
 * primitive — pure + testable. Callers pass whichever order they navigate (the raw
 * sessions' ids for the sidebar badge, or `getSwitchableSessionOrder` for the
 * keyboard jump) so the badge and the shortcut share ONE logic.
 */
export function nextAttentionSession(
  orderedIds: readonly string[],
  currentId: string | null | undefined,
  statusById: StatusMap | undefined
): string | null {
  if (!statusById) return null;
  const attention = orderedIds.filter((id) =>
    needsAttention(statusById[id]?.status)
  );
  if (attention.length === 0) return null;
  const idx = attention.indexOf(currentId ?? "");
  return attention[(idx + 1) % attention.length];
}

/**
 * The next attention session over a `Session[]` order (the sidebar badge's set).
 * Delegates to `nextAttentionSession` so there's no duplicate jump logic to drift.
 */
export function nextAttentionSessionId(
  sessions: Session[],
  statuses: StatusMap | undefined,
  currentId: string | null | undefined
): string | null {
  return nextAttentionSession(
    sessions.map((s) => s.id),
    currentId,
    statuses
  );
}
