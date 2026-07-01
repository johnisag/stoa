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
  "idle" | "running" | "waiting" | "error" | "dead";

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

/**
 * Attention tiers for the fleet bar (#15), most-urgent first: an agent BLOCKED on
 * your input, then one that ERRORED, then one that finished and is IDLE-DONE
 * (awaiting your glance), then the ones happily RUNNING (which don't need you at
 * all), then OTHER (dead/unknown). This deliberately ranks idle-done ABOVE running
 * — the "who needs me now" order, the OPPOSITE of the htop-style "what's active"
 * view in lib/agent-monitor.ts (monitorStatusRank puts running above idle).
 */
export type AttentionTier =
  "blocked" | "errored" | "idle-done" | "running" | "other";

const TIER_RANK: Record<AttentionTier, number> = {
  blocked: 0,
  errored: 1,
  "idle-done": 2,
  running: 3,
  other: 4,
};

/**
 * Map a raw status to its attention tier. `waiting` = blocked on your input,
 * `error` = errored, `idle` = finished/settled, `running` = busy, `dead`/unknown =
 * other. v1 treats every `idle` as idle-done — a session only goes idle AFTER
 * working, so the rare never-worked idle just sits in the same low tier (no new
 * persisted "done" state needed).
 */
export function attentionTier(
  status: SessionStatusValue | undefined
): AttentionTier {
  switch (status) {
    case "waiting":
      return "blocked";
    case "error":
      return "errored";
    case "idle":
      return "idle-done";
    case "running":
      return "running";
    default:
      return "other"; // dead / undefined
  }
}

/** Attention priority for sorting — lower = more urgent (blocked 0 … other 4). */
export function attentionRank(status: SessionStatusValue | undefined): number {
  return TIER_RANK[attentionTier(status)];
}

/**
 * Sessions ordered attention-first (blocked > errored > idle-done > running >
 * other), preserving the input order WITHIN a tier via an index tiebreak — so the
 * result is deterministic regardless of the engine's Array.sort stability. Pure →
 * unit-tested; drives the fleet bar's chip order.
 */
export function rankSessionsByAttention(
  sessions: Session[],
  statuses: StatusMap | undefined
): Session[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => {
      const byRank =
        attentionRank(statuses?.[a.session.id]?.status) -
        attentionRank(statuses?.[b.session.id]?.status);
      return byRank !== 0 ? byRank : a.index - b.index;
    })
    .map((x) => x.session);
}
