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

/** How many sessions currently need attention (waiting or error). */
export function countNeedsAttention(statuses: StatusMap | undefined): number {
  if (!statuses) return 0;
  let n = 0;
  for (const s of Object.values(statuses)) {
    if (s && needsAttention(s.status)) n++;
  }
  return n;
}

/**
 * The id of the next session needing attention after `currentId` (wrapping), or
 * null if none. From outside the set (or no current), returns the first. Order
 * follows the given `sessions` array.
 */
export function nextAttentionSessionId(
  sessions: Session[],
  statuses: StatusMap | undefined,
  currentId: string | null | undefined
): string | null {
  if (!statuses) return null;
  const attention = sessions.filter((s) =>
    needsAttention(statuses[s.id]?.status)
  );
  if (attention.length === 0) return null;
  const idx = attention.findIndex((s) => s.id === currentId);
  return attention[(idx + 1) % attention.length].id;
}
