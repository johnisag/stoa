import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { Session } from "@/lib/db";
import { backendKeyForSession } from "@/lib/providers/registry";
import {
  advanceFleetCostWatermark,
  estimateFleetTaskReservation,
  evaluateFleetBudget,
  type FleetCostConfidence,
  type FleetBudgetDecision,
  type FleetCostWatermark,
  type FleetReservationHistorySample,
  type FleetSessionCostSample,
  type FleetTaskReservation,
} from "./budgets";
import type { FleetRunRow, FleetWorkerRow } from "./types";

export type FleetCostOwnerType =
  "planner" | "plan_review" | "worker" | "task_review" | "fixer";

interface FleetCostAccountRow {
  id: string;
  fleet_run_id: string;
  session_id: string | null;
  session_key: string;
  owner_type: string;
  owner_id: string;
  task_id: string | null;
  provider: string;
  model: string | null;
  reservation_usd: number;
  reservation_tokens: number;
  reservation_confidence: FleetCostConfidence;
  reservation_basis: string | null;
  reservation_released_at: string | null;
  peak_input_tokens: number;
  peak_output_tokens: number;
  peak_cache_read_tokens: number;
  peak_cache_write_tokens: number;
  observed_cost_usd: number | null;
  fallback_cost_usd: number;
  charged_cost_usd: number;
  fallback_tokens: number;
  charged_tokens: number;
  confidence: FleetCostConfidence;
  last_sample_day: string | null;
  last_sample_at: string | null;
  terminal_at: string | null;
  updated_at: string;
}

function transaction<T>(db: Database.Database, fn: () => T): T {
  if (db.inTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function watermark(row: FleetCostAccountRow): FleetCostWatermark {
  return {
    peakInputTokens: row.peak_input_tokens,
    peakOutputTokens: row.peak_output_tokens,
    peakCacheReadTokens: row.peak_cache_read_tokens,
    peakCacheWriteTokens: row.peak_cache_write_tokens,
    observedCostUsd: row.observed_cost_usd,
    fallbackCostUsd: row.fallback_cost_usd,
    chargedCostUsd: row.charged_cost_usd,
    fallbackTokens: row.fallback_tokens,
    chargedTokens: row.charged_tokens,
    confidence: row.confidence,
  };
}

export function registerFleetCostAccount(
  db: Database.Database,
  input: {
    runId: string;
    ownerType: FleetCostOwnerType;
    ownerId: string;
    taskId?: string | null;
    session: Session;
    provider: string;
    model: string | null;
    confidence?: FleetCostConfidence;
    reservation?: FleetTaskReservation;
  }
): boolean {
  return transaction(db, () => {
    const sessionKey = backendKeyForSession(input.session);
    const existingOwner = db
      .prepare(
        `SELECT session_id, session_key, reservation_released_at, terminal_at
         FROM fleet_cost_accounts
         WHERE fleet_run_id = ? AND owner_type = ? AND owner_id = ?`
      )
      .get(input.runId, input.ownerType, input.ownerId) as
      | {
          session_id: string | null;
          session_key: string;
          reservation_released_at: string | null;
          terminal_at: string | null;
        }
      | undefined;
    if (existingOwner?.reservation_released_at || existingOwner?.terminal_at) {
      return false;
    }
    if (
      existingOwner?.session_id &&
      (existingOwner.session_id !== input.session.id ||
        existingOwner.session_key !== sessionKey)
    ) {
      return false;
    }
    if (
      existingOwner &&
      !existingOwner.session_id &&
      !existingOwner.session_key.startsWith("pending:") &&
      existingOwner.session_key !== sessionKey
    ) {
      return false;
    }

    // A session id is never reusable. A backend key may be reused only after its
    // previous owner is terminal; while live, either identity would make two
    // runs charge the same telemetry and believe they own the same process.
    // BEGIN IMMEDIATE makes this check-and-bind atomic across database
    // connections even on schemas created before this guard.
    const collision = db
      .prepare(
        `SELECT fleet_run_id, owner_type, owner_id
         FROM fleet_cost_accounts
         WHERE (
           session_id = ? OR (
             session_key = ? AND reservation_released_at IS NULL
               AND terminal_at IS NULL
           )
         )
           AND NOT (
             fleet_run_id = ? AND owner_type = ? AND owner_id = ?
           )
         LIMIT 1`
      )
      .get(
        input.session.id,
        sessionKey,
        input.runId,
        input.ownerType,
        input.ownerId
      );
    if (collision) return false;
    db.prepare(
      `INSERT INTO fleet_cost_accounts
       (id, fleet_run_id, session_id, session_key, owner_type, owner_id, task_id,
        provider, model, confidence, reservation_usd, reservation_tokens,
        reservation_confidence, reservation_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fleet_run_id, owner_type, owner_id) DO UPDATE SET
         session_id = excluded.session_id, session_key = excluded.session_key,
         task_id = COALESCE(excluded.task_id, fleet_cost_accounts.task_id),
         provider = excluded.provider, model = excluded.model,
         updated_at = datetime('now')`
    ).run(
      randomUUID(),
      input.runId,
      input.session.id,
      sessionKey,
      input.ownerType,
      input.ownerId,
      input.taskId ?? null,
      input.provider.trim().toLowerCase(),
      input.model,
      input.confidence ?? input.reservation?.confidence ?? "unknown",
      input.reservation?.usd ?? 0,
      input.reservation?.tokens ?? 0,
      input.reservation?.confidence ?? "unknown",
      input.reservation?.basis ?? null
    );
    return true;
  });
}

export type FleetCostReservationResult =
  | { reserved: true; reservation: FleetTaskReservation }
  | {
      reserved: false;
      reservation: FleetTaskReservation;
      decision: FleetBudgetDecision;
    };

/** Atomically hold budget before any paid Fleet-owned session is spawned. */
export function reserveFleetCostOwner(
  db: Database.Database,
  input: {
    runId: string;
    ownerType: FleetCostOwnerType;
    ownerId: string;
    taskId?: string | null;
    taskType: string;
    provider: string;
    model: string | null;
    now: Date;
  }
): FleetCostReservationResult {
  return transaction(db, () => {
    const existing = db
      .prepare(
        `SELECT reservation_usd, reservation_tokens, reservation_confidence,
                reservation_basis, reservation_released_at, terminal_at
         FROM fleet_cost_accounts
         WHERE fleet_run_id = ? AND owner_type = ? AND owner_id = ?`
      )
      .get(input.runId, input.ownerType, input.ownerId) as
      | {
          reservation_usd: number;
          reservation_tokens: number;
          reservation_confidence: FleetCostConfidence;
          reservation_basis: FleetTaskReservation["basis"];
          reservation_released_at: string | null;
          terminal_at: string | null;
        }
      | undefined;
    if (existing) {
      if (existing.reservation_released_at || existing.terminal_at) {
        throw new Error("Fleet cost owner identity is already terminal");
      }
      return {
        reserved: true,
        reservation: {
          usd: existing.reservation_usd,
          tokens: existing.reservation_tokens,
          confidence: existing.reservation_confidence,
          basis: existing.reservation_basis,
          sampleCount: 0,
        },
      };
    }
    const run = db
      .prepare(`SELECT * FROM fleet_runs WHERE id = ?`)
      .get(input.runId) as FleetRunRow | undefined;
    if (!run) throw new Error("Fleet run was not found for cost reservation");
    const reservation = estimateFleetTaskReservation({
      provider: input.provider,
      model: input.model,
      taskType: input.taskType,
      history: fleetReservationHistory(db),
    });
    const decision = evaluateFleetBudget({
      config: {
        budgetUsd: run.budget_usd,
        budgetTokens: run.budget_tokens ?? null,
        warningThreshold: run.budget_warning_threshold ?? 0.8,
        stopMode: run.budget_stop_mode ?? "pause-new",
      },
      ledger: {
        spentUsd: run.spent_budget_usd ?? 0,
        reservedUsd: run.reserved_budget_usd ?? 0,
        spentTokens: run.spent_budget_tokens ?? 0,
        reservedTokens: run.reserved_budget_tokens ?? 0,
      },
      reservation,
    });
    if (!decision.allowed) return { reserved: false, reservation, decision };
    const nowIso = input.now.toISOString();
    db.prepare(
      `INSERT INTO fleet_cost_accounts
       (id, fleet_run_id, session_id, session_key, owner_type, owner_id, task_id,
        provider, model, reservation_usd, reservation_tokens,
        reservation_confidence, reservation_basis, confidence, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      input.runId,
      `pending:${input.ownerType}:${input.ownerId}`,
      input.ownerType,
      input.ownerId,
      input.taskId ?? null,
      input.provider.trim().toLowerCase(),
      input.model,
      reservation.usd,
      reservation.tokens,
      reservation.confidence,
      reservation.basis,
      reservation.confidence,
      nowIso,
      nowIso
    );
    db.prepare(
      `UPDATE fleet_runs SET reserved_budget_usd = reserved_budget_usd + ?,
       reserved_budget_tokens = reserved_budget_tokens + ?, updated_at = ?
       WHERE id = ?`
    ).run(reservation.usd, reservation.tokens, nowIso, input.runId);
    return { reserved: true, reservation };
  });
}

function accountSamples(
  db: Database.Database,
  account: FleetCostAccountRow
): FleetSessionCostSample[] {
  // Once a cost owner is bound, session_id is the immutable attribution key.
  // Backend keys are mutable and can be reused after a process exits, so an OR
  // query would import another session's history. A pending pre-spawn account
  // has no session id and may only use its synthetic pending key.
  const predicate = account.session_id ? "session_id = ?" : "session_key = ?";
  const identity = account.session_id ?? account.session_key;
  return db
    .prepare(
      `SELECT session_key, session_id, day, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, cost_usd, updated_at
       FROM session_costs
       WHERE ${predicate}
       ORDER BY day ASC, updated_at ASC
       LIMIT 512`
    )
    .all(identity) as FleetSessionCostSample[];
}

function timestampMillis(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? millis : null;
}

function sampleProvesTerminalCompletion(
  sampleAt: string | null,
  completedAt: string | null | undefined
): boolean {
  const sampleMillis = timestampMillis(sampleAt);
  const completedMillis = timestampMillis(completedAt);
  return (
    sampleMillis != null &&
    completedMillis != null &&
    sampleMillis >= completedMillis
  );
}

function updateRunConfidence(db: Database.Database, runId: string): void {
  const rows = db
    .prepare(
      `SELECT confidence, COUNT(*) AS n FROM fleet_cost_accounts
       WHERE fleet_run_id = ? GROUP BY confidence`
    )
    .all(runId) as Array<{ confidence: FleetCostConfidence; n: number }>;
  const present = new Set(
    rows.filter((row) => row.n > 0).map((row) => row.confidence)
  );
  const confidence: FleetCostConfidence = present.has("unknown")
    ? "unknown"
    : present.has("low")
      ? "low"
      : present.has("medium")
        ? "medium"
        : present.has("high")
          ? "high"
          : "unknown";
  db.prepare(
    `UPDATE fleet_runs SET cost_confidence = ?
     WHERE id = ? AND cost_confidence IS NOT ?`
  ).run(confidence, runId, confidence);
}

export function reconcileFleetCostAccount(
  db: Database.Database,
  input: {
    runId: string;
    ownerType: string;
    ownerId: string;
    now: Date;
    terminalFallbackUsd?: number | null;
    terminalFallbackTokens?: number | null;
    /** Earliest timestamp at which a sample is known to be post-termination. */
    terminalCompletedAt?: string | null;
  }
): FleetCostAccountRow | null {
  return transaction(db, () => {
    const account = db
      .prepare(
        `SELECT * FROM fleet_cost_accounts
         WHERE fleet_run_id = ? AND owner_type = ? AND owner_id = ?`
      )
      .get(input.runId, input.ownerType, input.ownerId) as
      FleetCostAccountRow | undefined;
    if (!account) return null;
    let current = watermark(account);
    let chargedUsdDelta = 0;
    let chargedTokensDelta = 0;
    let lastSampleDay: string | null = null;
    let lastSampleAt: string | null = null;
    for (const sample of accountSamples(db, account)) {
      const advanced = advanceFleetCostWatermark({
        previous: current,
        sample,
      });
      current = advanced.watermark;
      chargedUsdDelta += advanced.chargedUsdDelta;
      chargedTokensDelta += advanced.chargedTokensDelta;
      lastSampleDay = sample.day;
      lastSampleAt = sample.updated_at ?? input.now.toISOString();
    }
    const terminal =
      input.terminalFallbackUsd != null || input.terminalFallbackTokens != null;
    const terminalCompletedAt =
      input.terminalCompletedAt ?? account.terminal_at;
    const exactFinalSample = sampleProvesTerminalCompletion(
      lastSampleAt,
      terminalCompletedAt
    );
    if (terminal) {
      const observedTokens =
        current.peakInputTokens +
        current.peakOutputTokens +
        current.peakCacheReadTokens +
        current.peakCacheWriteTokens;
      const fallbackUsd =
        exactFinalSample && current.observedCostUsd != null
          ? null
          : input.terminalFallbackUsd;
      const fallbackTokens =
        exactFinalSample && observedTokens > 0
          ? null
          : input.terminalFallbackTokens;
      const advanced = advanceFleetCostWatermark({
        previous: current,
        terminalFallbackUsd: fallbackUsd,
        terminalFallbackTokens: fallbackTokens,
      });
      current = advanced.watermark;
      if (
        !exactFinalSample &&
        (fallbackUsd != null || fallbackTokens != null)
      ) {
        current.confidence =
          current.observedCostUsd != null || observedTokens > 0
            ? "medium"
            : "low";
      }
      chargedUsdDelta += advanced.chargedUsdDelta;
      chargedTokensDelta += advanced.chargedTokensDelta;
    } else if (
      account.terminal_at != null &&
      !exactFinalSample &&
      (current.fallbackCostUsd > 0 || current.fallbackTokens > 0)
    ) {
      const observedTokens =
        current.peakInputTokens +
        current.peakOutputTokens +
        current.peakCacheReadTokens +
        current.peakCacheWriteTokens;
      current.confidence =
        current.observedCostUsd != null || observedTokens > 0
          ? "medium"
          : "low";
    }
    const nowIso = input.now.toISOString();
    const changed =
      current.peakInputTokens !== account.peak_input_tokens ||
      current.peakOutputTokens !== account.peak_output_tokens ||
      current.peakCacheReadTokens !== account.peak_cache_read_tokens ||
      current.peakCacheWriteTokens !== account.peak_cache_write_tokens ||
      current.observedCostUsd !== account.observed_cost_usd ||
      current.fallbackCostUsd !== account.fallback_cost_usd ||
      current.chargedCostUsd !== account.charged_cost_usd ||
      current.fallbackTokens !== account.fallback_tokens ||
      current.chargedTokens !== account.charged_tokens ||
      current.confidence !== account.confidence ||
      (lastSampleDay != null && lastSampleDay !== account.last_sample_day) ||
      (lastSampleAt != null && lastSampleAt !== account.last_sample_at) ||
      (terminal && account.terminal_at == null);
    if (!changed) return account;
    db.prepare(
      `UPDATE fleet_cost_accounts SET
       peak_input_tokens = ?, peak_output_tokens = ?,
       peak_cache_read_tokens = ?, peak_cache_write_tokens = ?,
       observed_cost_usd = ?, fallback_cost_usd = ?, charged_cost_usd = ?,
       fallback_tokens = ?, charged_tokens = ?, confidence = ?,
       last_sample_day = COALESCE(?, last_sample_day),
       last_sample_at = COALESCE(?, last_sample_at),
       terminal_at = CASE WHEN ? THEN COALESCE(terminal_at, ?) ELSE terminal_at END,
       updated_at = ? WHERE id = ?`
    ).run(
      current.peakInputTokens,
      current.peakOutputTokens,
      current.peakCacheReadTokens,
      current.peakCacheWriteTokens,
      current.observedCostUsd,
      current.fallbackCostUsd,
      current.chargedCostUsd,
      current.fallbackTokens,
      current.chargedTokens,
      current.confidence,
      lastSampleDay,
      lastSampleAt,
      terminal ? 1 : 0,
      nowIso,
      nowIso,
      account.id
    );
    if (chargedUsdDelta > 0 || chargedTokensDelta > 0) {
      db.prepare(
        `UPDATE fleet_runs SET spent_budget_usd = spent_budget_usd + ?,
         spent_budget_tokens = spent_budget_tokens + ?, updated_at = ?
         WHERE id = ?`
      ).run(chargedUsdDelta, chargedTokensDelta, nowIso, input.runId);
    }
    updateRunConfidence(db, input.runId);
    return db
      .prepare(`SELECT * FROM fleet_cost_accounts WHERE id = ?`)
      .get(account.id) as FleetCostAccountRow;
  });
}

/** Release a pre-spawn hold without charging it (no paid session was created). */
export function releaseFleetCostOwnerReservation(
  db: Database.Database,
  input: {
    runId: string;
    ownerType: FleetCostOwnerType;
    ownerId: string;
    now: Date;
  }
): boolean {
  return transaction(db, () => {
    const account = db
      .prepare(
        `SELECT * FROM fleet_cost_accounts
         WHERE fleet_run_id = ? AND owner_type = ? AND owner_id = ?`
      )
      .get(input.runId, input.ownerType, input.ownerId) as
      FleetCostAccountRow | undefined;
    if (!account || account.reservation_released_at) return false;
    const nowIso = input.now.toISOString();
    const changed = db
      .prepare(
        `UPDATE fleet_cost_accounts SET reservation_released_at = ?,
         terminal_at = COALESCE(terminal_at, ?), updated_at = ?
         WHERE id = ? AND reservation_released_at IS NULL`
      )
      .run(nowIso, nowIso, nowIso, account.id);
    if (changed.changes !== 1) return false;
    db.prepare(
      `UPDATE fleet_runs SET
       reserved_budget_usd = MAX(0, ROUND(reserved_budget_usd - ?, 12)),
       reserved_budget_tokens = MAX(0, reserved_budget_tokens - ?),
       updated_at = ? WHERE id = ?`
    ).run(
      account.reservation_usd,
      account.reservation_tokens,
      nowIso,
      account.fleet_run_id
    );
    return true;
  });
}

/** Settle a non-worker Fleet session and release its hold exactly once. */
export function settleFleetCostOwner(
  db: Database.Database,
  input: {
    runId: string;
    ownerType: Exclude<FleetCostOwnerType, "worker">;
    ownerId: string;
    now: Date;
  }
): boolean {
  return transaction(db, () => {
    const before = db
      .prepare(
        `SELECT * FROM fleet_cost_accounts
         WHERE fleet_run_id = ? AND owner_type = ? AND owner_id = ?`
      )
      .get(input.runId, input.ownerType, input.ownerId) as
      FleetCostAccountRow | undefined;
    if (!before || before.reservation_released_at) return false;
    const nowIso = input.now.toISOString();
    reconcileFleetCostAccount(db, {
      ...input,
      terminalFallbackUsd: before.reservation_usd,
      terminalFallbackTokens: before.reservation_tokens,
      terminalCompletedAt: nowIso,
    });
    const changed = db
      .prepare(
        `UPDATE fleet_cost_accounts SET reservation_released_at = ?,
         terminal_at = COALESCE(terminal_at, ?), updated_at = ?
         WHERE id = ? AND reservation_released_at IS NULL`
      )
      .run(nowIso, nowIso, nowIso, before.id);
    if (changed.changes !== 1) return false;
    db.prepare(
      `UPDATE fleet_runs SET
       reserved_budget_usd = MAX(0, ROUND(reserved_budget_usd - ?, 12)),
       reserved_budget_tokens = MAX(0, reserved_budget_tokens - ?),
       updated_at = ? WHERE id = ?`
    ).run(
      before.reservation_usd,
      before.reservation_tokens,
      nowIso,
      before.fleet_run_id
    );
    return true;
  });
}

/** Terminal settlement releases a worker hold exactly once, while account deltas remain replay-safe. */
export function settleFleetWorkerCost(
  db: Database.Database,
  worker: FleetWorkerRow,
  now: Date
): FleetCostAccountRow | null {
  return transaction(db, () => {
    const nowIso = now.toISOString();
    const account = reconcileFleetCostAccount(db, {
      runId: worker.fleet_run_id,
      ownerType: "worker",
      ownerId: worker.id,
      now,
      terminalFallbackUsd: worker.reservation_usd ?? 0,
      terminalFallbackTokens: worker.reservation_tokens ?? 0,
      terminalCompletedAt: worker.ended_at ?? nowIso,
    });
    if (!account) return null;
    const changed = db
      .prepare(
        `UPDATE fleet_workers SET actual_cost_usd = ?, actual_tokens = ?,
         cost_confidence = ?, cost_reconciled_at = ?
         WHERE id = ? AND cost_reconciled_at IS NULL`
      )
      .run(
        account.observed_cost_usd,
        account.peak_input_tokens +
          account.peak_output_tokens +
          account.peak_cache_read_tokens +
          account.peak_cache_write_tokens,
        account.confidence,
        nowIso,
        worker.id
      );
    if (changed.changes === 1) {
      db.prepare(
        `UPDATE fleet_runs SET
         reserved_budget_usd = MAX(0, ROUND(reserved_budget_usd - ?, 12)),
         reserved_budget_tokens = MAX(0, reserved_budget_tokens - ?),
         updated_at = ? WHERE id = ?`
      ).run(
        worker.reservation_usd ?? 0,
        worker.reservation_tokens ?? 0,
        nowIso,
        worker.fleet_run_id
      );
    }
    return account;
  });
}

/** Settle/refund a worker hold even when no session account was ever bound. */
export function finalizeFleetWorkerCost(
  db: Database.Database,
  worker: FleetWorkerRow,
  now: Date,
  chargeFallback: boolean
): void {
  transaction(db, () => {
    if (worker.cost_reconciled_at) return;
    if (chargeFallback && settleFleetWorkerCost(db, worker, now)) return;
    const nowIso = now.toISOString();
    const chargedUsd = chargeFallback ? (worker.reservation_usd ?? 0) : 0;
    const chargedTokens = chargeFallback ? (worker.reservation_tokens ?? 0) : 0;
    const changed = db
      .prepare(
        `UPDATE fleet_workers SET actual_cost_usd = ?, actual_tokens = ?,
         cost_confidence = ?, cost_reconciled_at = ?
         WHERE id = ? AND cost_reconciled_at IS NULL`
      )
      .run(
        chargedUsd,
        chargedTokens,
        chargeFallback ? "low" : "unknown",
        nowIso,
        worker.id
      );
    if (changed.changes !== 1) return;
    const runChanged = db
      .prepare(
        `UPDATE fleet_runs SET
         reserved_budget_usd = MAX(0, ROUND(reserved_budget_usd - ?, 12)),
         reserved_budget_tokens = MAX(0, reserved_budget_tokens - ?),
         spent_budget_usd = spent_budget_usd + ?,
         spent_budget_tokens = spent_budget_tokens + ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        worker.reservation_usd ?? 0,
        worker.reservation_tokens ?? 0,
        chargedUsd,
        chargedTokens,
        nowIso,
        worker.fleet_run_id
      );
    if (runChanged.changes !== 1) {
      throw new Error("Fleet run disappeared during worker cost finalization");
    }
  });
}

export function fleetReservationHistory(
  db: Database.Database,
  limit = 128
): FleetReservationHistorySample[] {
  const boundedLimit = Number.isSafeInteger(limit)
    ? Math.min(256, Math.max(1, limit))
    : 128;
  return db
    .prepare(
      `SELECT a.provider, a.model, COALESCE(t.task_type, 'task') AS taskType,
              a.observed_cost_usd AS actualUsd,
              CASE WHEN a.charged_tokens > 0 THEN a.charged_tokens ELSE NULL END AS actualTokens
       FROM fleet_cost_accounts a
       LEFT JOIN fleet_tasks t ON t.id = a.task_id
       WHERE a.terminal_at IS NOT NULL
       ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`
    )
    .all(boundedLimit) as FleetReservationHistorySample[];
}
