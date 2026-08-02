import type Database from "better-sqlite3";
import { getDb, type Session } from "@/lib/db";
import { backendKeyForSession } from "@/lib/providers/registry";
import { statusDetector, type SessionStatus } from "@/lib/status-detector";
import { insertFleetEvent } from "./durable-write";
import {
  FLEET_STATUS_CAPTURE_HARD_MAX_PER_TICK,
  FLEET_STATUS_MAX_CANDIDATES,
  FLEET_STATUS_MAX_CAPTURE_INTERVAL_MS,
  decideFleetStatusObservation,
  selectDueFleetStatusWorkers,
  type FleetStatusWorkerCandidate,
} from "./status-aggregation";

const ACTIVE_WORKER_STATUSES = ["running", "waiting_for_operator"] as const;

interface FleetStatusRuntimeRow extends Session {
  fleet_run_id: string;
  fleet_worker_id: string;
  fleet_session_id: string;
  fleet_attempt: number;
  fleet_worker_status: string;
  fleet_rendered_status: string | null;
  fleet_rendered_status_stability_count: number;
  fleet_rendered_status_last_captured_at: string | null;
  fleet_rendered_status_next_capture_at: string | null;
}

export interface FleetRenderedStatusObservation {
  status: SessionStatus;
  rendered: string;
}

export interface FleetStatusRuntimeDeps {
  db: Database.Database;
  now: () => Date;
  observe: (session: Session) => Promise<FleetRenderedStatusObservation>;
}

function runtimeDeps(
  overrides: Partial<FleetStatusRuntimeDeps>
): FleetStatusRuntimeDeps {
  return {
    db: overrides.db ?? getDb(),
    now: overrides.now ?? (() => new Date()),
    observe:
      overrides.observe ??
      (async (session) => {
        const detail = await statusDetector.getStatusDetail(
          backendKeyForSession(session)
        );
        return { status: detail.status, rendered: detail.lastLine };
      }),
  };
}

function transaction<T>(db: Database.Database, callback: () => T): T {
  if (db.inTransaction) return callback();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function candidate(row: FleetStatusRuntimeRow): FleetStatusWorkerCandidate {
  return {
    runId: row.fleet_run_id,
    workerId: row.fleet_worker_id,
    sessionId: row.fleet_session_id,
    attempt: row.fleet_attempt,
    workerStatus: row.fleet_worker_status,
    lastCapturedAt: row.fleet_rendered_status_last_captured_at,
    nextCaptureAt: row.fleet_rendered_status_next_capture_at,
  };
}

function identity(value: FleetStatusWorkerCandidate): string {
  return `${value.runId}\u0000${value.workerId}`;
}

function statusRows(db: Database.Database): FleetStatusRuntimeRow[] {
  return db
    .prepare(
      `SELECT s.*,
              w.fleet_run_id AS fleet_run_id,
              w.id AS fleet_worker_id,
              w.session_id AS fleet_session_id,
              w.attempt AS fleet_attempt,
              w.status AS fleet_worker_status,
              w.rendered_status AS fleet_rendered_status,
              w.rendered_status_stability_count AS fleet_rendered_status_stability_count,
              w.rendered_status_last_captured_at AS fleet_rendered_status_last_captured_at,
              w.rendered_status_next_capture_at AS fleet_rendered_status_next_capture_at
       FROM fleet_workers w
       JOIN sessions s ON s.id = w.session_id
       JOIN fleet_runs r ON r.id = w.fleet_run_id
       WHERE w.status IN (${ACTIVE_WORKER_STATUSES.map(() => "?").join(", ")})
         AND r.status IN ('running', 'reviewing', 'merging', 'paused')
         AND length(w.id) BETWEEN 1 AND 160
         AND w.id GLOB '[A-Za-z0-9]*'
         AND w.id NOT GLOB '*[^A-Za-z0-9._-]*'
         AND length(w.fleet_run_id) BETWEEN 1 AND 160
         AND w.fleet_run_id GLOB '[A-Za-z0-9]*'
         AND w.fleet_run_id NOT GLOB '*[^A-Za-z0-9._-]*'
         AND length(w.session_id) BETWEEN 1 AND 160
         AND w.session_id GLOB '[A-Za-z0-9]*'
         AND w.session_id NOT GLOB '*[^A-Za-z0-9._-]*'
         AND typeof(w.attempt) = 'integer' AND w.attempt > 0
         AND (w.rendered_status_last_captured_at IS NULL OR (
           length(w.rendered_status_last_captured_at) = 24
           AND substr(w.rendered_status_last_captured_at, -1) = 'Z'
           AND julianday(w.rendered_status_last_captured_at) IS NOT NULL
         ))
         AND (w.rendered_status_next_capture_at IS NULL OR (
           length(w.rendered_status_next_capture_at) = 24
           AND substr(w.rendered_status_next_capture_at, -1) = 'Z'
           AND julianday(w.rendered_status_next_capture_at) IS NOT NULL
         ))
         AND 1 = (
           SELECT COUNT(*) FROM fleet_workers bound
           WHERE bound.session_id = w.session_id
             AND bound.status IN ('running', 'waiting_for_operator')
         )
       ORDER BY COALESCE(w.rendered_status_next_capture_at, ''),
                COALESCE(w.rendered_status_last_captured_at, ''), w.id
       LIMIT ?`
    )
    .all(
      ...ACTIVE_WORKER_STATUSES,
      FLEET_STATUS_MAX_CANDIDATES
    ) as FleetStatusRuntimeRow[];
}

function scheduleCaptureFailure(
  deps: FleetStatusRuntimeDeps,
  row: FleetStatusRuntimeRow,
  observedAt: Date
): boolean {
  const nextCaptureAt = new Date(
    observedAt.getTime() + FLEET_STATUS_MAX_CAPTURE_INTERVAL_MS
  ).toISOString();
  return (
    deps.db
      .prepare(
        `UPDATE fleet_workers
         SET rendered_status_last_captured_at = ?,
             rendered_status_next_capture_at = ?,
             rendered_status_error = 'rendered status capture failed'
         WHERE id = ? AND fleet_run_id = ? AND session_id = ? AND attempt = ?
           AND status IN ('running', 'waiting_for_operator')
           AND rendered_status_last_captured_at IS ?
           AND rendered_status_next_capture_at IS ?`
      )
      .run(
        observedAt.toISOString(),
        nextCaptureAt,
        row.fleet_worker_id,
        row.fleet_run_id,
        row.fleet_session_id,
        row.fleet_attempt,
        row.fleet_rendered_status_last_captured_at,
        row.fleet_rendered_status_next_capture_at
      ).changes === 1
  );
}

/**
 * Capture one globally bounded, deterministic batch across every Fleet run.
 * The status detector itself reads the rendered VT screen through the selected
 * SessionBackend; this runtime never consumes raw terminal bytes.
 */
export async function reconcileFleetRenderedStatuses(
  overrides: Partial<FleetStatusRuntimeDeps> = {},
  options: { maxCaptures?: number } = {}
): Promise<number> {
  const deps = runtimeDeps(overrides);
  const observedAt = deps.now();
  const rows = statusRows(deps.db);
  const byIdentity = new Map(
    rows.map((row) => [identity(candidate(row)), row])
  );
  const selected = selectDueFleetStatusWorkers(rows.map(candidate), {
    now: observedAt,
    maxCaptures: options.maxCaptures ?? FLEET_STATUS_CAPTURE_HARD_MAX_PER_TICK,
  });
  const captured = await Promise.all(
    selected.map(async (selectedCandidate) => {
      const row = byIdentity.get(identity(selectedCandidate));
      if (!row) return null;
      try {
        return { row, observation: await deps.observe(row) };
      } catch {
        return { row, observation: null };
      }
    })
  );
  let persisted = 0;
  for (const item of captured) {
    if (!item) continue;
    if (!item.observation) {
      if (scheduleCaptureFailure(deps, item.row, observedAt)) persisted += 1;
      continue;
    }
    const decision = decideFleetStatusObservation({
      previousStatus: item.row.fleet_rendered_status,
      previousStableCount: item.row.fleet_rendered_status_stability_count,
      observedStatus: item.observation.status,
      rendered: item.observation.rendered,
      observedAt,
    });
    if (!decision.accepted) {
      if (scheduleCaptureFailure(deps, item.row, observedAt)) persisted += 1;
      continue;
    }
    let changed = false;
    try {
      changed = transaction(deps.db, () => {
        const update = deps.db
          .prepare(
            `UPDATE fleet_workers
           SET rendered_status = ?, rendered_status_summary = ?,
               rendered_status_summary_redacted = ?,
               rendered_status_replacement_count = ?,
               rendered_status_stability_count = ?,
               rendered_status_last_captured_at = ?,
               rendered_status_next_capture_at = ?, rendered_status_error = NULL
           WHERE id = ? AND fleet_run_id = ? AND session_id = ? AND attempt = ?
             AND status IN ('running', 'waiting_for_operator')
             AND rendered_status_last_captured_at IS ?
             AND rendered_status_next_capture_at IS ?`
          )
          .run(
            decision.status,
            decision.summary.summary,
            decision.summary.redacted ? 1 : 0,
            decision.summary.replacementCount,
            decision.stableCount,
            observedAt.toISOString(),
            decision.nextCaptureAt,
            item.row.fleet_worker_id,
            item.row.fleet_run_id,
            item.row.fleet_session_id,
            item.row.fleet_attempt,
            item.row.fleet_rendered_status_last_captured_at,
            item.row.fleet_rendered_status_next_capture_at
          );
        if (update.changes !== 1) return false;
        if (decision.transition) {
          insertFleetEvent(deps.db, {
            runId: item.row.fleet_run_id,
            eventType: decision.transition.eventType,
            actor: "fleet-status",
            payload: JSON.stringify({
              workerId: item.row.fleet_worker_id,
              sessionId: item.row.fleet_session_id,
              attempt: item.row.fleet_attempt,
              from: decision.transition.from,
              to: decision.transition.to,
              summary: decision.transition.summary,
            }),
            createdAt: observedAt.toISOString(),
          });
        }
        return true;
      });
    } catch {
      // A per-run event quota or corrupt row must not block the single global
      // status batch (and therefore every other Fleet run). Roll the transition
      // back, record only a generic bounded failure, and retry after max backoff.
      if (scheduleCaptureFailure(deps, item.row, observedAt)) persisted += 1;
      continue;
    }
    if (changed) persisted += 1;
  }
  return persisted;
}
