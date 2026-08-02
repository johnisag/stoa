import type Database from "better-sqlite3";
import { backendKeyForSession } from "./providers/registry";

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
  parent_session_id: string | null;
  tmux_name: string | null;
  agent_type: string | null;
  worktree_path: string | null;
}

export interface ConductorSessionDeletionPlan {
  conductorId: string;
  claimedAt: string;
  interactiveWorkers: SessionDeletionChild[];
  detachableFleetChildren: SessionDeletionChild[];
}

interface ClassifiedConductorSessionDeletion {
  conductor: SessionDeletionChild;
  interactiveWorkers: SessionDeletionChild[];
  detachableFleetChildren: SessionDeletionChild[];
}

interface DeletionClaimRow {
  conductor_session_id: string;
  state: "claimed" | "deleted";
  created_at: string;
}

interface DeletionClaimMemberRow extends SessionDeletionChild {
  disposition: "delete" | "detach";
}

/** A claimed or completed delete permanently fences the session identity. The
 * completed row is intentionally a tombstone: a stale browser must not recreate
 * the backend after the sessions row has disappeared. */
export function isSessionDeletionFenced(
  db: Database.Database,
  sessionId: string
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM session_deletion_claim_members
         WHERE session_id = ? AND disposition = 'delete'
         LIMIT 1`
      )
      .get(sessionId)
  );
}

/** Backend-key form of the same fence for the PTY websocket, whose attach
 * protocol predates durable session ids and carries only the process key. */
export function isSessionDeletionBackendKeyFenced(
  db: Database.Database,
  backendKey: string
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM session_deletion_claim_members
         WHERE backend_key = ? AND disposition = 'delete'
         LIMIT 1`
      )
      .get(backendKey)
  );
}

/** One process-side deletion fence check for a durable session identity and
 * every backend key an in-flight create/rename could make live. Keep this
 * shared so tmux and PTY-facing routes cannot accidentally protect only the
 * session id while reusing a completed backend-key tombstone. */
export function isSessionDeletionBoundaryFenced(
  db: Database.Database,
  sessionId: string,
  backendKeys: readonly string[]
): boolean {
  return (
    isSessionDeletionFenced(db, sessionId) ||
    backendKeys.some((backendKey) =>
      isSessionDeletionBackendKeyFenced(db, backendKey)
    )
  );
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

function rowMatches(
  left: SessionDeletionChild,
  right: SessionDeletionChild
): boolean {
  return (
    left.id === right.id &&
    roleOf(left) === roleOf(right) &&
    left.conductor_session_id === right.conductor_session_id &&
    left.parent_session_id === right.parent_session_id &&
    left.tmux_name === right.tmux_name &&
    left.agent_type === right.agent_type &&
    left.worktree_path === right.worktree_path
  );
}

function rowsMatch(
  left: readonly SessionDeletionChild[],
  right: readonly SessionDeletionChild[]
): boolean {
  if (left.length !== right.length) return false;
  const candidates = new Map(right.map((row) => [row.id, row]));
  return (
    candidates.size === right.length &&
    left.every((row) => {
      const candidate = candidates.get(row.id);
      return candidate !== undefined && rowMatches(row, candidate);
    })
  );
}

const SESSION_DELETION_ROW_SELECT = `
  SELECT id, session_role, conductor_session_id, parent_session_id,
         tmux_name, agent_type, worktree_path
  FROM sessions`;

function readSessionDeletionRow(
  db: Database.Database,
  sessionId: string
): SessionDeletionChild | undefined {
  return db
    .prepare(`${SESSION_DELETION_ROW_SELECT} WHERE id = ?`)
    .get(sessionId) as SessionDeletionChild | undefined;
}

function readDirectChildren(
  db: Database.Database,
  conductorId: string
): SessionDeletionChild[] {
  return db
    .prepare(
      `${SESSION_DELETION_ROW_SELECT}
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

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Find restrictive references outside the sessions graph before any backend
 * stop. SQLite exposes FK metadata even on legacy connections where enforcement
 * is disabled, so this protects both current and upgraded databases. */
function assertNoRestrictingForeignKeyBlockers(
  db: Database.Database,
  deletionIds: readonly string[]
): void {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    // Incoming sessions relationships need disposition-aware classification;
    // they were exhaustively checked above rather than treated as generic FKs.
    if (name === "sessions") continue;
    const foreignKeys = db
      .prepare(`PRAGMA foreign_key_list(${quoteSqlIdentifier(name)})`)
      .all() as Array<{
      table: string;
      from: string;
      to: string | null;
      on_delete: string;
    }>;
    for (const foreignKey of foreignKeys) {
      if (
        foreignKey.table !== "sessions" ||
        (foreignKey.to !== null && foreignKey.to !== "id") ||
        !["NO ACTION", "RESTRICT"].includes(foreignKey.on_delete.toUpperCase())
      ) {
        continue;
      }
      const blocker = db
        .prepare(
          `SELECT 1
           FROM ${quoteSqlIdentifier(name)}
           WHERE ${quoteSqlIdentifier(foreignKey.from)}
             IN (${placeholders(deletionIds)})
           LIMIT 1`
        )
        .get(...deletionIds);
      if (blocker) {
        throw new ConductorSessionDeletionRejectedError(
          "Cannot delete this session while another database record still references it."
        );
      }
    }
  }
}

function classifyConductorChildren(
  db: Database.Database,
  conductorId: string,
  options: { preflightForeignKeyBlockers?: boolean } = {}
): ClassifiedConductorSessionDeletion {
  const conductor = readSessionDeletionRow(db, conductorId);
  if (!conductor) {
    throw new ConductorSessionDeletionRejectedError("Session not found.");
  }
  if (roleOf(conductor) !== "interactive") {
    throw new ConductorSessionDeletionRejectedError(
      "Only an interactive session can be deleted through this route."
    );
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
        `${SESSION_DELETION_ROW_SELECT}
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
  if (options.preflightForeignKeyBlockers !== false) {
    assertNoRestrictingForeignKeyBlockers(db, deletionIds);
  }
  return { conductor, interactiveWorkers, detachableFleetChildren };
}

function readClaimMembers(
  db: Database.Database,
  conductorId: string
): DeletionClaimMemberRow[] {
  return db
    .prepare(
      `SELECT session_id AS id, session_role, conductor_session_id,
              parent_session_id, tmux_name, agent_type, worktree_path,
              disposition
       FROM session_deletion_claim_members
       WHERE claim_conductor_session_id = ?
       ORDER BY session_id`
    )
    .all(conductorId) as DeletionClaimMemberRow[];
}

function readActiveDeletionClaim(
  db: Database.Database,
  conductorId: string
): ConductorSessionDeletionPlan | undefined {
  const claim = db
    .prepare(
      `SELECT conductor_session_id, state, created_at
       FROM session_deletion_claims
       WHERE conductor_session_id = ?`
    )
    .get(conductorId) as DeletionClaimRow | undefined;
  if (!claim) return undefined;
  if (claim.state !== "claimed") return undefined;

  const members = readClaimMembers(db, conductorId);
  const conductor = members.find((member) => member.id === conductorId);
  const interactiveWorkers = members.filter(
    (member) => member.id !== conductorId && member.disposition === "delete"
  );
  const detachableFleetChildren = members.filter(
    (member) => member.disposition === "detach"
  );
  if (
    !conductor ||
    conductor.disposition !== "delete" ||
    roleOf(conductor) !== "interactive" ||
    interactiveWorkers.some((worker) => roleOf(worker) !== "interactive") ||
    detachableFleetChildren.some(
      (child) => !DETACHABLE_FLEET_SESSION_ROLE_SET.has(roleOf(child))
    )
  ) {
    throw new ConductorSessionDeletionRejectedError(
      "The durable session deletion claim is invalid; manual recovery is required."
    );
  }

  const current = classifyConductorChildren(db, conductorId, {
    preflightForeignKeyBlockers: false,
  });
  if (
    !rowMatches(current.conductor, conductor) ||
    !rowsMatch(current.interactiveWorkers, interactiveWorkers) ||
    !rowsMatch(current.detachableFleetChildren, detachableFleetChildren)
  ) {
    throw new ConductorSessionDeletionRejectedError(
      "The durable session deletion claim no longer matches the session graph; manual recovery is required."
    );
  }

  return {
    conductorId,
    claimedAt: claim.created_at,
    interactiveWorkers,
    detachableFleetChildren,
  };
}

/** Atomically validate the complete allowed relationship graph and publish a
 * durable claim before any backend is stopped. SQLite triggers then freeze the
 * claimed members and reject new conductor/parent attachments. Replaying the
 * call after a request failure or process restart returns the same claim. */
export function claimConductorSessionDeletion(
  db: Database.Database,
  conductorId: string
): ConductorSessionDeletionPlan {
  const claim = () => {
    const existing = readActiveDeletionClaim(db, conductorId);
    if (existing) return existing;

    const classified = classifyConductorChildren(db, conductorId);
    const members: Array<{
      row: SessionDeletionChild;
      disposition: "delete" | "detach";
    }> = [
      { row: classified.conductor, disposition: "delete" },
      ...classified.interactiveWorkers.map((row) => ({
        row,
        disposition: "delete" as const,
      })),
      ...classified.detachableFleetChildren.map((row) => ({
        row,
        disposition: "detach" as const,
      })),
    ];
    const memberIds = members.map(({ row }) => row.id);
    const overlap = db
      .prepare(
        `SELECT session_id
         FROM session_deletion_claim_members
         WHERE session_id IN (${placeholders(memberIds)})
         LIMIT 1`
      )
      .get(...memberIds) as { session_id: string } | undefined;
    if (overlap) {
      throw new ConductorSessionDeletionRejectedError(
        "A related session deletion is already in progress."
      );
    }

    db.prepare(
      `INSERT INTO session_deletion_claims (conductor_session_id)
       VALUES (?)`
    ).run(conductorId);
    const insertMember = db.prepare(
      `INSERT INTO session_deletion_claim_members
       (claim_conductor_session_id, session_id, disposition, session_role,
        conductor_session_id, parent_session_id, tmux_name, agent_type,
        backend_key, worktree_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const { row, disposition } of members) {
      insertMember.run(
        conductorId,
        row.id,
        disposition,
        roleOf(row),
        row.conductor_session_id,
        row.parent_session_id,
        row.tmux_name,
        row.agent_type,
        backendKeyForSession(row),
        row.worktree_path
      );
    }

    return readActiveDeletionClaim(db, conductorId)!;
  };

  return db.transaction(claim).immediate();
}

/** Atomically detach known Fleet evidence, delete ordinary workers/conductor,
 * and turn the claim into a compact identity tombstone. The tombstone prevents
 * an already-started writer from attaching to a now-deleted id even when a
 * legacy SQLite connection has foreign-key enforcement disabled. A failed FK,
 * trigger, or write rolls the whole commit back to the retryable claimed state. */
export function commitConductorSessionDeletion(
  db: Database.Database,
  expected: ConductorSessionDeletionPlan
): void {
  const commit = () => {
    const claimed = readActiveDeletionClaim(db, expected.conductorId);
    if (!claimed) {
      if (!readSessionDeletionRow(db, expected.conductorId)) return;
      throw new ConductorSessionDeletionRejectedError(
        "Session deletion was not claimed; retry the operation."
      );
    }
    if (
      claimed.claimedAt !== expected.claimedAt ||
      !rowsMatch(claimed.interactiveWorkers, expected.interactiveWorkers) ||
      !rowsMatch(
        claimed.detachableFleetChildren,
        expected.detachableFleetChildren
      )
    ) {
      throw new ConductorSessionDeletionRejectedError(
        "Session deletion claim changed; retry the operation."
      );
    }

    // Keep only deleted identities after completion. Detachable Fleet sessions
    // remain live and must not be fenced once their conductor FK is cleared.
    db.prepare(
      `DELETE FROM session_deletion_claim_members
       WHERE claim_conductor_session_id = ? AND disposition = 'detach'`
    ).run(expected.conductorId);
    const completed = db
      .prepare(
        `UPDATE session_deletion_claims
         SET state = 'deleted', completed_at = datetime('now')
         WHERE conductor_session_id = ? AND state = 'claimed'`
      )
      .run(expected.conductorId);
    if (completed.changes !== 1) {
      throw new ConductorSessionDeletionRejectedError(
        "Session deletion claim changed; retry the operation."
      );
    }

    const fleetIds = claimed.detachableFleetChildren.map((child) => child.id);
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
      ...claimed.interactiveWorkers.map((worker) => worker.id),
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
