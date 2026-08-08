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
export type KanbanColumnId =
  "backlog" | "in-progress" | "blocked" | "review" | "done";

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
}

/**
 * Classify a single session into a Kanban column.
 *
 * Classification rules (evaluated in priority order):
 *
 * 1. PR status "open" → review (an open PR needs human review regardless of
 *    what the worker lifecycle says — a completed worker with an open PR
 *    is NOT done, it's awaiting merge).
 * 2. PR status "merged" or "closed" → done.
 * 3. status "error" → blocked (broken, needs human intervention).
 * 4. status "dead" → done (session exited, no longer active).
 * 5. worker_status "completed" or "failed" → done (but rule 1 already
 *    intercepted if there's an open PR).
 * 6. worker_status "running" or "pending" → in-progress.
 * 7. status "running" or "waiting" → in-progress.
 * 8. status "idle" → done (finished and idle).
 * 9. default → backlog.
 */
export function classifySession(
  input: KanbanClassificationInput
): KanbanColumnId {
  // 1. Open PR needs review FIRST — even a completed/failed worker with an
  //    open PR should land in review, not done.
  if (input.prStatus === "open") {
    return "review";
  }

  // 2. Merged/closed PR → done.
  if (input.prStatus === "merged" || input.prStatus === "closed") {
    return "done";
  }

  // 3. Error sessions are blocked, not in-progress — they need human
  //    intervention and shouldn't be visually conflated with healthy work.
  if (input.status === "error") {
    return "blocked";
  }

  // 4. Dead sessions → done (exited, not backlog).
  if (input.status === "dead") {
    return "done";
  }

  // 5. Fleet worker terminal states → done (open PR already handled above).
  if (input.workerStatus === "completed" || input.workerStatus === "failed") {
    return "done";
  }

  // 6. Fleet workers in flight.
  if (input.workerStatus === "running" || input.workerStatus === "pending") {
    return "in-progress";
  }

  // 7. Active session states.
  if (input.status === "running" || input.status === "waiting") {
    return "in-progress";
  }

  // 8. Idle → done (finished and idle).
  if (input.status === "idle") {
    return "done";
  }

  // 9. Default → backlog.
  return "backlog";
}

/**
 * Classify all sessions into Kanban columns. Pure function.
 *
 * @returns Five columns with session ids, in display order.
 */
export function classifySessionsForKanban(
  sessions: KanbanClassificationInput[]
): KanbanColumn[] {
  const columns: Record<KanbanColumnId, string[]> = {
    backlog: [],
    "in-progress": [],
    blocked: [],
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
    { id: "blocked", label: "Blocked", sessionIds: columns.blocked },
    { id: "review", label: "Review", sessionIds: columns.review },
    { id: "done", label: "Done", sessionIds: columns.done },
  ];
}
