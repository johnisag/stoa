import type Database from "better-sqlite3";
import { queries } from "@/lib/db/queries";
import type { FleetArtifactRow, FleetTaskRow } from "@/lib/fleet/types";

const ARTIFACT_METADATA_COLUMNS = `
  id, fleet_run_id, task_id, worker_id, attempt, plan_hash,
  base_sha, head_sha, content_hash, metadata_json, byte_count,
  artifact_type, title, '' AS body, severity, actor,
  body_pruned_at, created_at
`;

const ACTIONABLE_ARTIFACT_METADATA_COLUMNS = `
  id, fleet_run_id, task_id, worker_id, attempt, plan_hash,
  base_sha, head_sha, content_hash, '{}' AS metadata_json, byte_count,
  artifact_type, title, '' AS body, severity, actor,
  body_pruned_at, created_at
`;

// The normal detail window is deliberately small. This larger, metadata-only
// supplement keeps current blockers actionable without allowing one corrupted
// run to make its detail response grow without limit.
const ACTIONABLE_ARTIFACT_METADATA_LIMIT = 1_000;

export interface FleetDetailArtifactMetadata {
  rows: FleetArtifactRow[];
  total: number;
  hasMore: boolean;
}

function taskArtifactIds(tasks: FleetTaskRow[]): string[] {
  const ids = new Set<string>();
  for (const task of tasks) {
    for (const id of [
      task.report_artifact_id,
      task.diff_artifact_id,
      task.verification_artifact_id,
    ]) {
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Return the bounded newest artifact window plus every artifact referenced by a
 * task and current blocker metadata. Task references are bounded by the task
 * graph; blockers have their own hard ceiling. Bodies remain excluded.
 */
export function loadFleetDetailArtifactMetadata(
  db: Database.Database,
  runId: string,
  tasks: FleetTaskRow[],
  currentPlanHash: string | null,
  recentLimit: number
): FleetDetailArtifactMetadata {
  if (!Number.isSafeInteger(recentLimit) || recentLimit < 1) {
    throw new RangeError("recentLimit must be a positive safe integer");
  }

  const recent = queries
    .listFleetArtifactsForRun(db)
    .all(runId, recentLimit) as FleetArtifactRow[];
  const rowsById = new Map(recent.map((row) => [row.id, row]));
  const referencedStatement = db.prepare(
    `SELECT ${ARTIFACT_METADATA_COLUMNS}
     FROM fleet_artifacts
     WHERE fleet_run_id = ? AND id = ?`
  );
  for (const artifactId of taskArtifactIds(tasks)) {
    if (rowsById.has(artifactId)) continue;
    const row = referencedStatement.get(runId, artifactId) as
      FleetArtifactRow | undefined;
    if (row) rowsById.set(row.id, row);
  }

  const actionable = db
    .prepare(
      `SELECT ${ACTIONABLE_ARTIFACT_METADATA_COLUMNS}
       FROM fleet_artifacts
       WHERE fleet_run_id = ?
         AND severity = 'blocker'
         AND (plan_hash = ? OR plan_hash IS NULL)
         AND (
           task_id IS NULL OR
           head_sha IS NULL OR
           EXISTS (
             SELECT 1
             FROM fleet_tasks task
             WHERE task.id = fleet_artifacts.task_id
               AND task.fleet_run_id = fleet_artifacts.fleet_run_id
               AND (task.head_sha IS NULL OR task.head_sha = fleet_artifacts.head_sha)
           )
         )
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(
      runId,
      currentPlanHash,
      ACTIONABLE_ARTIFACT_METADATA_LIMIT
    ) as FleetArtifactRow[];
  for (const row of actionable) {
    // Keep the richer row when this blocker is already in the bounded recent
    // window or is task-referenced. Only the supplemental copy is compact.
    if (!rowsById.has(row.id)) rowsById.set(row.id, row);
  }

  const rows = [...rowsById.values()].sort(
    (left, right) =>
      right.created_at.localeCompare(left.created_at) ||
      right.id.localeCompare(left.id)
  );
  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM fleet_artifacts WHERE fleet_run_id = ?`)
    .get(runId) as { n: number };
  return {
    rows,
    total: count.n,
    hasMore: count.n > rows.length,
  };
}

export function countFleetEventsForDetail(
  db: Database.Database,
  runId: string
): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM fleet_events WHERE fleet_run_id = ?`)
    .get(runId) as { n: number };
  return row.n;
}
