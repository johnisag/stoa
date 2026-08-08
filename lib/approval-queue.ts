/**
 * Unified approval queue — aggregates items needing human attention from
 * across Stoa's subsystems into a single queue. Pure read layer.
 *
 * Sources:
 *   1. Fleet tasks in `waiting_for_operator` or `blocked` status
 *   2. Guardrail BLOCK violations (when a persistence layer exists)
 *
 * Each item is normalized to a common shape so the UI can render one queue.
 */

import { getDb, queries } from "./db";

/** A single item in the approval queue. */
export interface ApprovalQueueItem {
  id: string;
  /** The source subsystem: "fleet" or "guardrail". */
  source: "fleet" | "guardrail";
  /** The session id the item is about (if known). */
  sessionId: string | null;
  /** Human-readable title. */
  title: string;
  /** Longer description / context. */
  description: string;
  /** Severity: how urgently does this need attention. */
  severity: "info" | "warn" | "block";
  /** ISO timestamp when the item was created/last updated. */
  timestamp: string;
}

/** Fleet task row shape for the attention query. */
interface FleetTaskAttentionRow {
  id: string;
  fleet_run_id: string;
  session_id: string | null;
  title: string;
  status: string;
  updated_at: string;
}

/**
 * Collect all items needing human attention.
 */
export function getApprovalQueue(): ApprovalQueueItem[] {
  const db = getDb();
  const items: ApprovalQueueItem[] = [];

  // Fleet tasks needing attention.
  try {
    const fleetTasks = queries
      .listFleetTasksNeedingAttention(db)
      .all() as FleetTaskAttentionRow[];
    for (const task of fleetTasks) {
      items.push({
        id: `fleet:${task.id}`,
        source: "fleet",
        sessionId: task.session_id,
        title: task.title || `Task ${task.id.slice(0, 8)}`,
        description:
          task.status === "waiting_for_operator"
            ? "Fleet task waiting for operator approval."
            : "Fleet task is blocked by a dependency.",
        severity: task.status === "waiting_for_operator" ? "warn" : "info",
        timestamp: task.updated_at,
      });
    }
  } catch {
    // Fleet tables may not exist in some test DBs.
  }

  // Guardrail violations (real-time only; no persistence yet → empty).
  // When guardrail violations gain a persistence layer, add them here.

  // Sort by most recent first.
  items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return items;
}

/** Count of pending approval items (for badge rendering). */
export function getApprovalQueueCount(): number {
  return getApprovalQueue().length;
}
