import type Database from "better-sqlite3";
import { queries } from "@/lib/db/queries";
import type { FleetArtifactRow, FleetTaskRow } from "@/lib/fleet/types";

const ARTIFACT_METADATA_COLUMNS = `
  id, fleet_run_id, task_id, worker_id, attempt, plan_hash,
  base_sha, head_sha, content_hash, metadata_json, byte_count,
  artifact_type, title, '' AS body, severity, actor,
  body_pruned_at, created_at
`;

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
 * task. The latter is bounded by the task graph and keeps exact report, diff,
 * and verification evidence discoverable even after newer review artifacts
 * push it outside the normal metadata window.
 */
export function loadFleetDetailArtifactMetadata(
  db: Database.Database,
  runId: string,
  tasks: FleetTaskRow[],
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
