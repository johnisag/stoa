import type Database from "better-sqlite3";

/** Fleet-owned session roles whose conductor relationship is provenance only.
 * These rows survive deletion of an interactive conductor. Unknown internal
 * roles fail closed so a future subsystem cannot be silently detached. */
export const DETACHABLE_FLEET_SESSION_ROLES = [
  "fleet_worker",
  "fleet_planner",
  "fleet_plan_reviewer",
  "fleet_task_reviewer",
  "fleet_task_fixer",
] as const;

const DETACHABLE_FLEET_SESSION_ROLE_SET = new Set<string>(
  DETACHABLE_FLEET_SESSION_ROLES
);

export interface SessionDeletionChild {
  id: string;
  session_role: string | null;
  conductor_session_id: string | null;
  worktree_path: string | null;
}

export interface ConductorSessionDeletionPlan {
  conductorId: string;
  interactiveWorkers: SessionDeletionChild[];
  detachableFleetChildren: SessionDeletionChild[];
}

export class ConductorSessionDeletionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConductorSessionDeletionRejectedError";
  }
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function roleOf(row: SessionDeletionChild): string {
  return row.session_role ?? "interactive";
}

function idsMatch(
  left: readonly SessionDeletionChild[],
  right: readonly SessionDeletionChild[]
): boolean {
  return (
    left.length === right.length &&
    left.every((row, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        row.id === candidate.id &&
        roleOf(row) === roleOf(candidate) &&
        row.conductor_session_id === candidate.conductor_session_id
      );
    })
  );
}

function readDirectChildren(
  db: Database.Database,
  conductorId: string
): SessionDeletionChild[] {
  return db
    .prepare(
      `SELECT id, session_role, conductor_session_id, worktree_path
       FROM sessions
       WHERE conductor_session_id = ?
       ORDER BY id`
    )
    .all(conductorId) as SessionDeletionChild[];
}

function assertNoParentBlockers(
  db: Database.Database,
  deletionIds: readonly string[]
): void {
  const blocker = db
    .prepare(
      `SELECT id
       FROM sessions
       WHERE parent_session_id IN (${placeholders(deletionIds)})
         AND id NOT IN (${placeholders(deletionIds)})
       LIMIT 1`
    )
    .get(...deletionIds, ...deletionIds) as { id: string } | undefined;
  if (blocker) {
    throw new ConductorSessionDeletionRejectedError(
      "Cannot delete this session while another session still references it as a parent."
    );
  }
}

function classifyConductorChildren(
  db: Database.Database,
  conductorId: string
): ConductorSessionDeletionPlan {
  const conductor = db
    .prepare(`SELECT id FROM sessions WHERE id = ?`)
    .get(conductorId) as { id: string } | undefined;
  if (!conductor) {
    throw new ConductorSessionDeletionRejectedError("Session not found.");
  }

  const directChildren = readDirectChildren(db, conductorId);
  const interactiveWorkers: SessionDeletionChild[] = [];
  const detachableFleetChildren: SessionDeletionChild[] = [];

  for (const child of directChildren) {
    if (child.id === conductorId) {
      throw new ConductorSessionDeletionRejectedError(
        "Cannot delete a session with a self-referential conductor relationship."
      );
    }
    const role = roleOf(child);
    if (role === "interactive") {
      interactiveWorkers.push(child);
    } else if (DETACHABLE_FLEET_SESSION_ROLE_SET.has(role)) {
      detachableFleetChildren.push(child);
    } else {
      throw new ConductorSessionDeletionRejectedError(
        "Cannot delete this session while an unsupported managed child session is attached."
      );
    }
  }

  const deletionIds = [
    conductorId,
    ...interactiveWorkers.map((worker) => worker.id),
  ];
  assertNoParentBlockers(db, deletionIds);

  if (interactiveWorkers.length > 0) {
    const workerIds = interactiveWorkers.map((worker) => worker.id);
    const nestedChildren = db
      .prepare(
        `SELECT id, session_role, conductor_session_id, worktree_path
         FROM sessions
         WHERE conductor_session_id IN (${placeholders(workerIds)})
           AND id NOT IN (${placeholders(deletionIds)})
         ORDER BY id`
      )
      .all(...workerIds, ...deletionIds) as SessionDeletionChild[];

    for (const child of nestedChildren) {
      const role = roleOf(child);
      if (DETACHABLE_FLEET_SESSION_ROLE_SET.has(role)) {
        detachableFleetChildren.push(child);
        continue;
      }
      throw new ConductorSessionDeletionRejectedError(
        role === "interactive"
          ? "Cannot delete this session while a nested interactive worker is attached."
          : "Cannot delete this session while an unsupported managed child session is attached."
      );
    }
  }

  detachableFleetChildren.sort((a, b) => a.id.localeCompare(b.id));
  return { conductorId, interactiveWorkers, detachableFleetChildren };
}

/** Read and validate every session relationship that generic conductor deletion
 * is allowed to mutate. Call this before any backend process is stopped. */
export function planConductorSessionDeletion(
  db: Database.Database,
  conductorId: string
): ConductorSessionDeletionPlan {
  return classifyConductorChildren(db, conductorId);
}

/** Atomically detach known Fleet evidence, delete ordinary workers, and delete
 * the conductor. The relationship snapshot is revalidated inside the write
 * transaction so an async backend stop cannot turn into a broad/racy cascade. */
export function commitConductorSessionDeletion(
  db: Database.Database,
  expected: ConductorSessionDeletionPlan
): void {
  const commit = () => {
    const current = classifyConductorChildren(db, expected.conductorId);
    if (
      !idsMatch(current.interactiveWorkers, expected.interactiveWorkers) ||
      !idsMatch(
        current.detachableFleetChildren,
        expected.detachableFleetChildren
      )
    ) {
      throw new ConductorSessionDeletionRejectedError(
        "Session relationships changed during deletion; retry the operation."
      );
    }

    const fleetIds = current.detachableFleetChildren.map((child) => child.id);
    if (fleetIds.length > 0) {
      const detached = db
        .prepare(
          `UPDATE sessions
           SET conductor_session_id = NULL, updated_at = datetime('now')
           WHERE id IN (${placeholders(fleetIds)})
             AND session_role IN (${placeholders(
               DETACHABLE_FLEET_SESSION_ROLES
             )})`
        )
        .run(...fleetIds, ...DETACHABLE_FLEET_SESSION_ROLES);
      if (detached.changes !== fleetIds.length) {
        throw new ConductorSessionDeletionRejectedError(
          "Session relationships changed during deletion; retry the operation."
        );
      }
    }

    const deletionIds = [
      expected.conductorId,
      ...current.interactiveWorkers.map((worker) => worker.id),
    ];
    const deleted = db
      .prepare(
        `DELETE FROM sessions WHERE id IN (${placeholders(deletionIds)})`
      )
      .run(...deletionIds);
    if (deleted.changes !== deletionIds.length) {
      throw new ConductorSessionDeletionRejectedError(
        "Session relationships changed during deletion; retry the operation."
      );
    }
  };

  // better-sqlite3 nests transaction functions with a savepoint, so this stays
  // atomic even if a caller already owns a broader database transaction.
  db.transaction(commit).immediate();
}
