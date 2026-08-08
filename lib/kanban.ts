/**
 * Kanban board session classification — inspired by amux's workspace-first
 * model and beacon-fleet's Kanban board.
 *
 * Classifies sessions into Kanban columns based on their lifecycle state,
 * so the board gives a visual workflow overview at a glance.
 *
 * Pure function — no I/O, no side effects. The caller passes the session
 * list + status map, gets back columns with session ids.
 */

import type { Session } from "./db/types";
import type { SessionStatus } from "./status-detector";

/** The Kanban columns in left-to-right order. */
export type KanbanColumnId = "backlog" | "in-progress" | "review" | "done";

export interface KanbanColumn {
  id: KanbanColumnId;
  label: string;
  /** Session ids assigned to this column. */
  sessionIds: string[];
}

export interface KanbanClassificationInput {
  /** The session id. */
  id: string;
  /** The session's lifecycle status from the status detector. */
  status: SessionStatus | undefined;
  /** The session's worker_status (Fleet workers only). */
  workerStatus?: Session["worker_status"];
  /** The session's PR status (if it has a PR). */
  prStatus?: Session["pr_status"];
  /** Whether the session has a parent (child workers go to in-progress). */
  isChild?: boolean;
}

/**
 * Classify a single session into a Kanban column.
 *
 * Classification rules (evaluated in order):
 * 1. worker_status "completed" or "failed" → done
 * 2. PR status "merged" or "closed" → done
 * 3. PR status "open" → review
 * 4. worker_status "running" or "pending" → in-progress
 * 5. status "running" or "waiting" → in-progress
 * 6. status "error" → in-progress (needs attention)
 * 7. status "idle" + has a PR → review (finished work, awaiting merge)
 * 8. status "idle" → done (finished and idle)
 * 9. default → backlog
 */
export function classifySession(
  input: KanbanClassificationInput
): KanbanColumnId {
  // 1. Fleet worker lifecycle states are authoritative.
  if (input.workerStatus === "completed" || input.workerStatus === "failed") {
    return "done";
  }

  // 2. PR status overrides everything else.
  if (input.prStatus === "merged" || input.prStatus === "closed") {
    return "done";
  }
  if (input.prStatus === "open") {
    return "review";
  }

  // 3. Fleet workers in flight.
  if (input.workerStatus === "running" || input.workerStatus === "pending") {
    return "in-progress";
  }

  // 4. Active session states.
  if (input.status === "running" || input.status === "waiting") {
    return "in-progress";
  }

  // 5. Error sessions need attention — keep them visible in-progress.
  if (input.status === "error") {
    return "in-progress";
  }

  // 6. Idle + has an open PR → review (already checked above, but idle
  //    without a PR → done).
  if (input.status === "idle") {
    return "done";
  }

  // 7. Dead or unknown → backlog.
  return "backlog";
}

/**
 * Classify all sessions into Kanban columns. Pure function.
 *
 * @param sessions The full session list.
 * @param statuses The status map (from the status event stream).
 * @returns Four columns with session ids, in display order.
 */
export function classifySessionsForKanban(
  sessions: KanbanClassificationInput[]
): KanbanColumn[] {
  const columns: Record<KanbanColumnId, string[]> = {
    backlog: [],
    "in-progress": [],
    review: [],
    done: [],
  };

  for (const s of sessions) {
    const col = classifySession(s);
    columns[col].push(s.id);
  }

  return [
    { id: "backlog", label: "Backlog", sessionIds: columns.backlog },
    {
      id: "in-progress",
      label: "In Progress",
      sessionIds: columns["in-progress"],
    },
    { id: "review", label: "Review", sessionIds: columns.review },
    { id: "done", label: "Done", sessionIds: columns.done },
  ];
}
