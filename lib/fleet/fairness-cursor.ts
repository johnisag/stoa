import type Database from "better-sqlite3";

export const FLEET_FAIRNESS_CURSOR_REBASE_AT =
  Number.MAX_SAFE_INTEGER - 1_000_000;

const FAIRNESS_TARGETS = {
  costSample: {
    table: "fleet_cost_accounts",
    column: "sample_attempt_cursor",
  },
  supervisorRecovery: {
    table: "fleet_cost_accounts",
    column: "fallback_recovery_cursor",
  },
  supervisorPoll: {
    table: "fleet_runs",
    column: "managed_supervisor_poll_cursor",
  },
  schedulerPoll: {
    table: "fleet_runs",
    column: "scheduler_poll_cursor",
  },
} as const;

export type FleetFairnessCursorTarget = keyof typeof FAIRNESS_TARGETS;

/**
 * Return a safe monotonic starting point for a fairness claim batch.
 *
 * SQLite promotes INTEGER arithmetic to REAL on overflow. Resetting the whole
 * cursor domain before that boundary prevents a permanently imprecise MAX()+1
 * sequence. Call this inside the same immediate transaction that selects and
 * advances the batch; every claim query still tie-breaks reset rows by id.
 */
export function prepareFleetFairnessCursor(
  db: Database.Database,
  target: FleetFairnessCursorTarget
): number {
  const { table, column } = FAIRNESS_TARGETS[target];
  const row = db
    .prepare(`SELECT COALESCE(MAX(${column}), 0) AS cursor FROM ${table}`)
    .get() as { cursor: number };
  const cursor = row.cursor;
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor >= FLEET_FAIRNESS_CURSOR_REBASE_AT
  ) {
    db.prepare(`UPDATE ${table} SET ${column} = 0`).run();
    return 0;
  }
  return cursor;
}
