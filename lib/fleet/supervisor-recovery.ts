import type Database from "better-sqlite3";
import type { Session } from "@/lib/db";
import { queries } from "@/lib/db/queries";
import { finishFleetPaidSession } from "./session-admission";
import {
  validateManagedSupervisorSessionIdentity,
  type ManagedSupervisorCostIdentity,
} from "./supervisor-session-identity";
import { prepareFleetFairnessCursor } from "./fairness-cursor";

interface SupervisorCostAccountRow extends ManagedSupervisorCostIdentity {
  id: string;
  reservation_released_at: string | null;
  terminal_at: string | null;
}

type ExactIdentity = {
  kind: "exact";
  account: SupervisorCostAccountRow;
  session: Session;
};

type IdentityResolution =
  ExactIdentity | { kind: "settled" } | { kind: "ambiguous"; reason: string };

export interface ManagedSupervisorFallbackRecoveryDeps {
  db: Database.Database;
  now: () => Date;
  sessionExists: (db: Database.Database, sessionId: string) => Promise<boolean>;
  stopSession: (
    sessionId: string,
    finalStatus?: "completed" | "failed"
  ) => Promise<boolean>;
}

export interface ManagedSupervisorFallbackRecoveryResult {
  inspected: number;
  recovered: number;
  recoveryRequired: number;
}

function accountById(
  db: Database.Database,
  accountId: string
): SupervisorCostAccountRow | null {
  return (
    (db
      .prepare(
        `SELECT id, fleet_run_id, session_id, session_key, owner_type, owner_id,
                provider, model, reservation_released_at, terminal_at
         FROM fleet_cost_accounts WHERE id = ?`
      )
      .get(accountId) as SupervisorCostAccountRow | undefined) ?? null
  );
}

function resolveExactIdentity(
  db: Database.Database,
  accountId: string
): IdentityResolution {
  const account = accountById(db, accountId);
  if (!account) {
    return { kind: "ambiguous", reason: "cost_account_missing" };
  }
  if (account.reservation_released_at && account.terminal_at) {
    return { kind: "settled" };
  }
  if (account.reservation_released_at || account.terminal_at) {
    return { kind: "ambiguous", reason: "partial_cost_settlement" };
  }
  if (account.owner_type !== "supervisor") {
    return { kind: "ambiguous", reason: "cost_owner_type_mismatch" };
  }
  if (!account.session_id) {
    return { kind: "ambiguous", reason: "cost_session_binding_missing" };
  }

  const sessions = db
    .prepare(`SELECT * FROM sessions WHERE id = ?`)
    .all(account.session_id) as Session[];
  if (sessions.length !== 1) {
    return { kind: "ambiguous", reason: "session_identity_not_unique" };
  }
  const session = sessions[0];
  const validated = validateManagedSupervisorSessionIdentity({
    session,
    runId: account.fleet_run_id,
    requestId: account.owner_id,
    sessionId: session.id,
    account,
    expectedModel: account.model,
  });
  if (!validated.ok) {
    return { kind: "ambiguous", reason: "session_profile_mismatch" };
  }

  const foreignAccount = db
    .prepare(
      `SELECT 1 FROM fleet_cost_accounts
       WHERE id <> ? AND (session_id = ? OR session_key = ?)
       LIMIT 1`
    )
    .get(account.id, session.id, validated.backendKey);
  const foreignSession = db
    .prepare(
      `SELECT 1 FROM sessions
       WHERE id <> ? AND tmux_name = ?
       LIMIT 1`
    )
    .get(session.id, validated.backendKey);
  if (foreignAccount || foreignSession) {
    return { kind: "ambiguous", reason: "session_identity_has_foreign_owner" };
  }
  return { kind: "exact", account, session };
}

function emitRecoveryEvent(
  db: Database.Database,
  runId: string,
  eventType: string,
  reason: string,
  createdAt: string
): void {
  try {
    queries
      .createFleetEvent(db)
      .run(runId, eventType, "fleet-supervisor", JSON.stringify({ reason }), {
        createdAt,
      });
  } catch {
    // The recovery gate/settlement is authoritative. Event quota or a damaged
    // event table must not roll that safety action back.
  }
}

function markRecoveryRequired(
  deps: ManagedSupervisorFallbackRecoveryDeps,
  runId: string,
  reason: string
): boolean {
  const nowIso = deps.now().toISOString();
  const changed = deps.db
    .prepare(
      `UPDATE fleet_runs SET recovery_required = 1, updated_at = ?
       WHERE id = ? AND recovery_required = 0`
    )
    .run(nowIso, runId);
  if (changed.changes === 1) {
    emitRecoveryEvent(
      deps.db,
      runId,
      "managed_supervisor_recovery_required",
      reason,
      nowIso
    );
    return true;
  }
  return false;
}

function claimUntrackedAccounts(
  db: Database.Database,
  limit: number
): Array<{ id: string; fleet_run_id: string }> {
  const claim = () => {
    let nextCursor = prepareFleetFairnessCursor(db, "supervisorRecovery");
    const selected = db
      .prepare(
        `SELECT account.id, account.fleet_run_id
         FROM fleet_cost_accounts account
         JOIN fleet_runs run ON run.id = account.fleet_run_id
         WHERE account.owner_type = 'supervisor'
           AND (
             account.reservation_released_at IS NULL
             OR account.terminal_at IS NULL
           )
           AND CASE
             WHEN NOT json_valid(run.settings_json) THEN 1
             WHEN json_type(run.settings_json, '$.managedSupervisor')
                    IS NOT 'object' THEN 1
             WHEN json_extract(
                    run.settings_json, '$.managedSupervisor.requestId'
                  ) IS NOT account.owner_id THEN 1
             WHEN account.session_id IS NOT NULL
                  AND json_extract(
                    run.settings_json, '$.managedSupervisor.sessionId'
                  ) IS NOT account.session_id THEN 1
             WHEN json_extract(
                    run.settings_json, '$.managedSupervisor.state'
                  ) IN ('starting', 'running', 'cleanup_pending') THEN 0
             WHEN json_extract(
                    run.settings_json, '$.managedSupervisor.state'
                  ) IN ('completed', 'failed', 'canceled')
                  AND COALESCE(json_extract(
                    run.settings_json,
                    '$.managedSupervisor.orphanSweepComplete'
                  ), 0) = 0 THEN 0
             ELSE 1
           END = 1
         ORDER BY account.fallback_recovery_cursor, account.id
         LIMIT ?`
      )
      .all(limit) as Array<{ id: string; fleet_run_id: string }>;
    const advance = db.prepare(
      `UPDATE fleet_cost_accounts
       SET fallback_recovery_cursor = ?
       WHERE id = ? AND owner_type = 'supervisor'
         AND (reservation_released_at IS NULL OR terminal_at IS NULL)`
    );
    return selected.filter(
      (candidate) => advance.run(++nextCursor, candidate.id).changes === 1
    );
  };
  return db.inTransaction ? claim() : db.transaction(claim).immediate();
}

/** Recover supervisor cost/session identities that the settings-driven runtime
 * cannot discover. Exact identities are stopped and charged conservatively;
 * every ambiguous or uncertain identity is left untouched behind the run's
 * recovery gate. */
export async function reconcileUntrackedManagedFleetSupervisors(
  deps: ManagedSupervisorFallbackRecoveryDeps,
  limit = 40
): Promise<ManagedSupervisorFallbackRecoveryResult> {
  const boundedLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(200, limit))
    : 40;
  const candidates = claimUntrackedAccounts(deps.db, boundedLimit);
  let recovered = 0;
  let recoveryRequired = 0;

  for (const candidate of candidates) {
    let resolved = resolveExactIdentity(deps.db, candidate.id);
    if (resolved.kind === "settled") continue;
    if (resolved.kind === "ambiguous") {
      if (markRecoveryRequired(deps, candidate.fleet_run_id, resolved.reason)) {
        recoveryRequired += 1;
      }
      continue;
    }

    let live: boolean;
    try {
      live = await deps.sessionExists(deps.db, resolved.session.id);
    } catch {
      if (
        markRecoveryRequired(
          deps,
          candidate.fleet_run_id,
          "session_presence_unknown"
        )
      ) {
        recoveryRequired += 1;
      }
      continue;
    }
    if (live) {
      let stopped = false;
      try {
        stopped = await deps.stopSession(resolved.session.id, "failed");
      } catch {
        stopped = false;
      }
      if (!stopped) {
        if (
          markRecoveryRequired(
            deps,
            candidate.fleet_run_id,
            "session_stop_unconfirmed"
          )
        ) {
          recoveryRequired += 1;
        }
        continue;
      }
    }

    try {
      if (await deps.sessionExists(deps.db, resolved.session.id)) {
        if (
          markRecoveryRequired(
            deps,
            candidate.fleet_run_id,
            "session_stop_unconfirmed"
          )
        ) {
          recoveryRequired += 1;
        }
        continue;
      }
    } catch {
      if (
        markRecoveryRequired(
          deps,
          candidate.fleet_run_id,
          "session_presence_unknown"
        )
      ) {
        recoveryRequired += 1;
      }
      continue;
    }

    // External I/O yielded. Re-prove the complete identity and ownership before
    // making any durable terminal mutation.
    resolved = resolveExactIdentity(deps.db, candidate.id);
    if (resolved.kind === "settled") continue;
    if (resolved.kind === "ambiguous") {
      if (markRecoveryRequired(deps, candidate.fleet_run_id, resolved.reason)) {
        recoveryRequired += 1;
      }
      continue;
    }

    try {
      const now = deps.now();
      finishFleetPaidSession(deps.db, {
        runId: resolved.account.fleet_run_id,
        ownerType: "supervisor",
        ownerId: resolved.account.owner_id,
        sessionCreated: true,
        now,
      });
      deps.db
        .prepare(
          `UPDATE sessions SET worker_status = 'failed', updated_at = ?
           WHERE id = ? AND session_role = 'fleet_supervisor'`
        )
        .run(now.toISOString(), resolved.session.id);
      const settled = accountById(deps.db, resolved.account.id);
      if (!settled?.terminal_at || !settled.reservation_released_at) {
        throw new Error("supervisor fallback settlement was incomplete");
      }
      emitRecoveryEvent(
        deps.db,
        resolved.account.fleet_run_id,
        "managed_supervisor_corrupt_state_recovered",
        "settings_state_untracked",
        now.toISOString()
      );
      recovered += 1;
    } catch {
      if (
        markRecoveryRequired(
          deps,
          candidate.fleet_run_id,
          "cost_settlement_failed"
        )
      ) {
        recoveryRequired += 1;
      }
    }
  }

  return {
    inspected: candidates.length,
    recovered,
    recoveryRequired,
  };
}
