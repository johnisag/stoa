import type Database from "better-sqlite3";
import type { Session } from "@/lib/db";
import {
  registerFleetCostAccount,
  releaseFleetCostOwnerReservation,
  reserveFleetCostOwner,
  settleFleetCostOwner,
  type FleetCostOwnerType,
} from "./cost-runtime";
import {
  acquireFleetRuntimeResources,
  fleetResourceLimitsForRun,
  fleetWorkerResourceRequest,
  releaseFleetRuntimeResources,
} from "./resource-runtime";
import type { FleetRunRow } from "./types";

type PaidSessionOwner = Exclude<FleetCostOwnerType, "worker">;

const PAID_SESSION_CORE_LEASE_TYPES = new Set([
  "pty",
  "transport_host",
  "provider",
  "git_operation",
]);

const PAID_SESSION_ADVISORY_LEASE_TYPES = new Set([
  "pty",
  "transport_host",
  "provider",
]);

const PAID_SESSION_NEW_WORKTREE_LEASE_TYPES = new Set([
  ...PAID_SESSION_CORE_LEASE_TYPES,
  "repo_worktree",
  "disk_bytes",
]);

function exactLeaseTypes(
  leases: readonly PaidSessionLeaseRow[],
  expected: ReadonlySet<string>
): boolean {
  const actual = new Set(leases.map((lease) => lease.resource_type));
  return (
    leases.length === expected.size &&
    actual.size === expected.size &&
    [...actual].every((kind) => expected.has(kind))
  );
}

interface PaidSessionLeaseRow {
  id: string;
  resource_type: string;
  resource_key: string;
  status: string;
  lease_expires_at: string | null;
}

class FleetPaidSessionActivationRejected extends Error {}

function timestampMillis(value: string): number | null {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? millis : null;
}

function rejectActivation(): never {
  throw new FleetPaidSessionActivationRejected(
    "Fleet paid-session admission is no longer valid"
  );
}

function transaction<T>(db: Database.Database, fn: () => T): T {
  if (db.inTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export type FleetPaidSessionAdmission =
  | { admitted: true }
  | { admitted: false; reason: "budget" | "resource"; retryAt: string | null };

/** Atomically reserve budget and runtime slots before a paid session launch. */
export function reserveFleetPaidSession(
  db: Database.Database,
  input: {
    run: FleetRunRow;
    ownerType: PaidSessionOwner;
    ownerId: string;
    taskId?: string | null;
    taskType: string;
    provider: string;
    model: string | null;
    repositoryKey: string;
    now: Date;
    leaseExpiresAt: string;
  }
): FleetPaidSessionAdmission {
  return transaction(db, () => {
    const requestedResources = fleetWorkerResourceRequest({
      provider: input.provider,
      repositoryKey: input.repositoryKey,
    }).filter((resource) => {
      if (input.ownerType === "supervisor") {
        return PAID_SESSION_ADVISORY_LEASE_TYPES.has(resource.kind);
      }
      return (
        input.ownerType !== "fixer" ||
        PAID_SESSION_CORE_LEASE_TYPES.has(resource.kind)
      );
    });
    const resources = acquireFleetRuntimeResources(db, {
      runId: input.run.id,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      resources: requestedResources,
      limits: fleetResourceLimitsForRun(input.run),
      now: input.now,
      leaseExpiresAt: input.leaseExpiresAt,
    });
    if (!resources.admitted) {
      return {
        admitted: false,
        reason: "resource",
        retryAt: resources.retryAt,
      };
    }
    const cost = reserveFleetCostOwner(db, {
      runId: input.run.id,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      taskId: input.taskId,
      taskType: input.taskType,
      provider: input.provider,
      model: input.model,
      now: input.now,
    });
    if (!cost.reserved) {
      releaseFleetRuntimeResources(db, {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        now: input.now,
      });
      return { admitted: false, reason: "budget", retryAt: null };
    }
    return { admitted: true };
  });
}

/** Bind the durable cost account and turn launch leases into active leases. */
export function activateFleetPaidSession(
  db: Database.Database,
  input: {
    runId: string;
    ownerType: PaidSessionOwner;
    ownerId: string;
    taskId?: string | null;
    session: Session;
    provider: string;
    model: string | null;
    now: Date;
  }
): boolean {
  try {
    return transaction(db, () => {
      const account = db
        .prepare(
          `SELECT session_id, provider, model, reservation_released_at, terminal_at
           FROM fleet_cost_accounts
           WHERE fleet_run_id = ? AND owner_type = ? AND owner_id = ?`
        )
        .get(input.runId, input.ownerType, input.ownerId) as
        | {
            session_id: string | null;
            provider: string;
            model: string | null;
            reservation_released_at: string | null;
            terminal_at: string | null;
          }
        | undefined;
      if (
        !account ||
        account.reservation_released_at != null ||
        account.terminal_at != null ||
        account.provider !== input.provider.trim().toLowerCase() ||
        account.model !== input.model
      ) {
        return rejectActivation();
      }

      const leases = db
        .prepare(
          `SELECT id, resource_type, resource_key, status, lease_expires_at
           FROM fleet_runtime_leases
           WHERE fleet_run_id = ? AND owner_type = ? AND owner_id = ?
           ORDER BY resource_type, resource_key, id`
        )
        .all(
          input.runId,
          input.ownerType,
          input.ownerId
        ) as PaidSessionLeaseRow[];
      const expectedLeaseTypes =
        input.ownerType === "supervisor"
          ? PAID_SESSION_ADVISORY_LEASE_TYPES
          : input.ownerType === "fixer"
            ? PAID_SESSION_CORE_LEASE_TYPES
            : PAID_SESSION_NEW_WORKTREE_LEASE_TYPES;
      // Accept the old six-row fixer shape during a rolling upgrade so a
      // crash-recovered pre-upgrade fixer can still activate and settle. New
      // fixer reservations always use the four-row reuse profile above.
      const legacyFixerLeaseShape =
        input.ownerType === "fixer" &&
        exactLeaseTypes(leases, PAID_SESSION_NEW_WORKTREE_LEASE_TYPES);
      if (
        !exactLeaseTypes(leases, expectedLeaseTypes) &&
        !legacyFixerLeaseShape
      ) {
        return rejectActivation();
      }
      const providerLease = leases.find(
        (lease) => lease.resource_type === "provider"
      );
      if (
        !providerLease ||
        providerLease.resource_key !== input.provider.trim().toLowerCase()
      ) {
        return rejectActivation();
      }

      const initialActivation = account.session_id == null;
      const nowMs = input.now.getTime();
      for (const lease of leases) {
        const releasedGitLease =
          !initialActivation &&
          lease.resource_type === "git_operation" &&
          lease.status === "released";
        if (lease.status !== "reserved" && !releasedGitLease) {
          return rejectActivation();
        }
        if (lease.status !== "reserved") continue;
        if (initialActivation && lease.lease_expires_at == null) {
          return rejectActivation();
        }
        if (lease.lease_expires_at != null) {
          const expiresAt = timestampMillis(lease.lease_expires_at);
          if (expiresAt == null || expiresAt <= nowMs) {
            return rejectActivation();
          }
        }
      }

      // Promote each expiring row with an exact compare-and-swap. A concurrent
      // expiry/release or a partial lease set rejects the whole activation and
      // rolls back the cost binding, allowing the launch caller's normal error
      // path to stop the session and settle/refund the admission exactly once.
      const promote = db.prepare(
        `UPDATE fleet_runtime_leases SET lease_expires_at = NULL
         WHERE id = ? AND fleet_run_id = ? AND owner_type = ? AND owner_id = ?
           AND status = 'reserved' AND lease_expires_at = ?`
      );
      for (const lease of leases) {
        if (lease.status !== "reserved" || lease.lease_expires_at == null)
          continue;
        const changed = promote.run(
          lease.id,
          input.runId,
          input.ownerType,
          input.ownerId,
          lease.lease_expires_at
        );
        if (changed.changes !== 1) return rejectActivation();
      }

      const bound = registerFleetCostAccount(db, {
        runId: input.runId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        taskId: input.taskId,
        session: input.session,
        provider: input.provider,
        model: input.model,
      });
      if (!bound) return rejectActivation();
      const gitLeaseWasReserved = leases.some(
        (lease) =>
          lease.resource_type === "git_operation" && lease.status === "reserved"
      );
      const released = releaseFleetRuntimeResources(db, {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        now: input.now,
        resourceTypes: ["git_operation"],
      });
      if (released !== (gitLeaseWasReserved ? 1 : 0)) {
        return rejectActivation();
      }
      return true;
    });
  } catch (error) {
    if (error instanceof FleetPaidSessionActivationRejected) return false;
    throw error;
  }
}

/** Release all slots and either settle a created session or refund pre-spawn hold. */
export function finishFleetPaidSession(
  db: Database.Database,
  input: {
    runId: string;
    ownerType: PaidSessionOwner;
    ownerId: string;
    sessionCreated: boolean;
    now: Date;
  }
): void {
  transaction(db, () => {
    if (input.sessionCreated) {
      settleFleetCostOwner(db, input);
    } else {
      releaseFleetCostOwnerReservation(db, input);
    }
    releaseFleetRuntimeResources(db, {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      now: input.now,
    });
  });
}
