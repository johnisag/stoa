import type {
  FleetCancelMode,
  FleetPauseMode,
  FleetWorkerStatus,
} from "./types";

export const FLEET_INTERRUPT_DEFAULT_GRACE_MS = 30_000;
export const FLEET_INTERRUPT_MIN_GRACE_MS = 5_000;
export const FLEET_INTERRUPT_MAX_GRACE_MS = 5 * 60_000;
export const FLEET_INTERRUPT_MAX_WORKERS = 1_000;

export type FleetInterruptNoticeState =
  "unattempted" | "requested" | "delivered" | "failed";
export type FleetInterruptStopState = "unattempted" | "requested" | "confirmed";

export interface ParsedFleetPauseRequest {
  mode: FleetPauseMode;
  graceMs: number | null;
}

export interface ParsedFleetCancelRequest {
  mode: FleetCancelMode;
  destructiveCleanupConfirmed: boolean;
  previewDigest: string | null;
}

export type FleetPolicyParseResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

/**
 * Durable input used to make restart-safe interrupt decisions. Integrations
 * derive notice/stop states from immutable events or dedicated columns.
 */
export interface FleetInterruptWorkerSnapshot {
  runId: string;
  workerId: string;
  sessionId: string | null;
  workerStatus: unknown;
  interruptRequestedAt: string | null;
  interruptDeadlineAt: string | null;
  noticeState?: unknown;
  stopState?: unknown;
}

export interface FleetInterruptRequest {
  requestedAt: string;
  deadlineAt: string;
  created: boolean;
}

export type FleetInterruptStartDecision =
  | {
      ok: true;
      request: FleetInterruptRequest | null;
      resolved: boolean;
    }
  | { ok: false; error: string };

export type FleetInterruptActionDecision =
  | {
      kind: "none";
      reason: "not_requested" | "worker_terminal" | "stop_confirmed";
      resolved: boolean;
    }
  | {
      kind: "deliver_notice" | "wait_for_deadline" | "stop_session";
      operationKey: string;
      requestedAt: string;
      deadlineAt: string;
      replay: boolean;
    }
  | { kind: "operator_attention"; reason: string; resolved: false };

export interface FleetResumeDecision {
  allowed: boolean;
  blockingWorkerIds: string[];
  reasons: string[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const ACTIVE_WORKER_STATUSES = new Set<FleetWorkerStatus>([
  "running",
  "waiting_for_operator",
]);
const TERMINAL_WORKER_STATUSES = new Set<FleetWorkerStatus>([
  "completed",
  "failed",
  "canceled",
  "dead",
  "cleanup_complete",
]);
const WORKER_STATUSES = new Set<FleetWorkerStatus>([
  "leasing",
  "spawning",
  "running",
  "waiting_for_operator",
  "completed",
  "failed",
  "canceled",
  "dead",
  "cleanup_pending",
  "cleanup_complete",
]);
const NOTICE_STATES = new Set<FleetInterruptNoticeState>([
  "unattempted",
  "requested",
  "delivered",
  "failed",
]);
const STOP_STATES = new Set<FleetInterruptStopState>([
  "unattempted",
  "requested",
  "confirmed",
]);

function payloadObject(input: unknown): Record<string, unknown> | null {
  if (input == null) return {};
  return typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function validGraceMs(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= FLEET_INTERRUPT_MIN_GRACE_MS &&
    Number(value) <= FLEET_INTERRUPT_MAX_GRACE_MS
  );
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function canonicalTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  try {
    return new Date(parsed).toISOString() === value ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedNoticeState(
  value: unknown
): FleetInterruptNoticeState | null {
  const normalized = value ?? "unattempted";
  return typeof normalized === "string" &&
    NOTICE_STATES.has(normalized as FleetInterruptNoticeState)
    ? (normalized as FleetInterruptNoticeState)
    : null;
}

function normalizedStopState(value: unknown): FleetInterruptStopState | null {
  const normalized = value ?? "unattempted";
  return typeof normalized === "string" &&
    STOP_STATES.has(normalized as FleetInterruptStopState)
    ? (normalized as FleetInterruptStopState)
    : null;
}

function normalizedWorkerStatus(value: unknown): FleetWorkerStatus | null {
  return typeof value === "string" &&
    WORKER_STATUSES.has(value as FleetWorkerStatus)
    ? (value as FleetWorkerStatus)
    : null;
}

function operationKey(
  snapshot: FleetInterruptWorkerSnapshot,
  requestedAt: string,
  action: "notice" | "stop"
): string {
  return `fleet-interrupt:${snapshot.runId}:${snapshot.workerId}:${requestedAt}:${action}`;
}

interface ValidatedInterruptSnapshot {
  status: FleetWorkerStatus;
  requestedAt: string | null;
  requestedAtMs: number | null;
  deadlineAt: string | null;
  deadlineAtMs: number | null;
  noticeState: FleetInterruptNoticeState;
  stopState: FleetInterruptStopState;
}

function validateInterruptSnapshot(
  snapshot: FleetInterruptWorkerSnapshot
):
  | { ok: true; value: ValidatedInterruptSnapshot }
  | { ok: false; error: string } {
  if (!SAFE_ID.test(snapshot.runId) || !SAFE_ID.test(snapshot.workerId)) {
    return { ok: false, error: "interrupt run or worker identity is invalid" };
  }
  if (snapshot.sessionId !== null && !SAFE_ID.test(snapshot.sessionId)) {
    return { ok: false, error: "interrupt session identity is invalid" };
  }
  const status = normalizedWorkerStatus(snapshot.workerStatus);
  const noticeState = normalizedNoticeState(snapshot.noticeState);
  const stopState = normalizedStopState(snapshot.stopState);
  if (!status || !noticeState || !stopState) {
    return { ok: false, error: "interrupt worker state is invalid" };
  }
  const hasRequestedAt = snapshot.interruptRequestedAt !== null;
  const hasDeadlineAt = snapshot.interruptDeadlineAt !== null;
  if (hasRequestedAt !== hasDeadlineAt) {
    return { ok: false, error: "interrupt timestamps are incomplete" };
  }
  if (!hasRequestedAt) {
    if (noticeState !== "unattempted" || stopState !== "unattempted") {
      return {
        ok: false,
        error: "interrupt actions exist without an interrupt request",
      };
    }
    return {
      ok: true,
      value: {
        status,
        requestedAt: null,
        requestedAtMs: null,
        deadlineAt: null,
        deadlineAtMs: null,
        noticeState,
        stopState,
      },
    };
  }
  const requestedAtMs = canonicalTimestamp(snapshot.interruptRequestedAt);
  const deadlineAtMs = canonicalTimestamp(snapshot.interruptDeadlineAt);
  if (requestedAtMs === null || deadlineAtMs === null) {
    return { ok: false, error: "interrupt timestamps are invalid" };
  }
  const graceMs = deadlineAtMs - requestedAtMs;
  if (!validGraceMs(graceMs)) {
    return { ok: false, error: "interrupt grace deadline is outside bounds" };
  }
  return {
    ok: true,
    value: {
      status,
      requestedAt: snapshot.interruptRequestedAt,
      requestedAtMs,
      deadlineAt: snapshot.interruptDeadlineAt,
      deadlineAtMs,
      noticeState,
      stopState,
    },
  };
}

export function parseFleetPauseRequest(
  input: unknown
): FleetPolicyParseResult<ParsedFleetPauseRequest> {
  const payload = payloadObject(input);
  if (!payload) return { ok: false, error: "pause request must be an object" };
  try {
    const rawMode = payload.mode;
    const mode: FleetPauseMode =
      rawMode === undefined || rawMode === null
        ? "pause-new"
        : rawMode === "pause-new" || rawMode === "pause-and-interrupt"
          ? rawMode
          : ("" as FleetPauseMode);
    if (!mode) return { ok: false, error: "pause mode is invalid" };
    const rawGraceMs = payload.graceMs;
    if (mode === "pause-new") {
      if (rawGraceMs !== undefined && rawGraceMs !== null) {
        return {
          ok: false,
          error: "graceMs is only valid for pause-and-interrupt",
        };
      }
      return { ok: true, value: { mode, graceMs: null } };
    }
    if (rawGraceMs === undefined || rawGraceMs === null) {
      return {
        ok: true,
        value: { mode, graceMs: FLEET_INTERRUPT_DEFAULT_GRACE_MS },
      };
    }
    if (!validGraceMs(rawGraceMs)) {
      return {
        ok: false,
        error: `graceMs must be an integer from ${FLEET_INTERRUPT_MIN_GRACE_MS} to ${FLEET_INTERRUPT_MAX_GRACE_MS}`,
      };
    }
    return { ok: true, value: { mode, graceMs: rawGraceMs } };
  } catch {
    return { ok: false, error: "pause request could not be read safely" };
  }
}

export function parseFleetCancelRequest(
  runId: string,
  input: unknown
): FleetPolicyParseResult<ParsedFleetCancelRequest> {
  if (!SAFE_ID.test(runId)) {
    return { ok: false, error: "Fleet run identity is invalid" };
  }
  const payload = payloadObject(input);
  if (!payload) return { ok: false, error: "cancel request must be an object" };
  try {
    const rawMode = payload.mode;
    const mode: FleetCancelMode =
      rawMode === undefined || rawMode === null
        ? "cancel-preserve-worktrees"
        : rawMode === "cancel-preserve-worktrees" ||
            rawMode === "cancel-and-clean-owned-worktrees"
          ? rawMode
          : ("" as FleetCancelMode);
    if (!mode) return { ok: false, error: "cancel mode is invalid" };
    if (mode === "cancel-preserve-worktrees") {
      return {
        ok: true,
        value: {
          mode,
          destructiveCleanupConfirmed: false,
          previewDigest: null,
        },
      };
    }
    if (payload.confirm !== true || payload.confirmation !== runId) {
      return {
        ok: false,
        error:
          "destructive cancel requires confirm=true and confirmation exactly equal to the run id",
      };
    }
    if (
      typeof payload.previewDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(payload.previewDigest)
    ) {
      return {
        ok: false,
        error: "destructive cancel requires a valid previewDigest",
      };
    }
    return {
      ok: true,
      value: {
        mode,
        destructiveCleanupConfirmed: true,
        previewDigest: payload.previewDigest,
      },
    };
  } catch {
    return { ok: false, error: "cancel request could not be read safely" };
  }
}

/**
 * Start an interrupt once. Replaying this after restart returns the exact
 * durable request and never extends its original grace deadline.
 */
export function startFleetWorkerInterrupt(
  snapshot: FleetInterruptWorkerSnapshot,
  now: Date,
  graceMs: number = FLEET_INTERRUPT_DEFAULT_GRACE_MS
): FleetInterruptStartDecision {
  if (!validDate(now) || !validGraceMs(graceMs)) {
    return { ok: false, error: "interrupt time or grace period is invalid" };
  }
  const validated = validateInterruptSnapshot(snapshot);
  if (!validated.ok) return validated;
  const state = validated.value;
  if (state.requestedAt && state.deadlineAt) {
    return {
      ok: true,
      request: {
        requestedAt: state.requestedAt,
        deadlineAt: state.deadlineAt,
        created: false,
      },
      resolved: TERMINAL_WORKER_STATUSES.has(state.status),
    };
  }
  if (!ACTIVE_WORKER_STATUSES.has(state.status)) {
    return {
      ok: true,
      request: null,
      resolved: TERMINAL_WORKER_STATUSES.has(state.status),
    };
  }
  if (!snapshot.sessionId) {
    return {
      ok: false,
      error: "active worker has no exact session to interrupt",
    };
  }
  const requestedAt = now.toISOString();
  const deadlineAtMs = now.getTime() + graceMs;
  if (!Number.isSafeInteger(deadlineAtMs)) {
    return { ok: false, error: "interrupt deadline is outside the safe range" };
  }
  return {
    ok: true,
    request: {
      requestedAt,
      deadlineAt: new Date(deadlineAtMs).toISOString(),
      created: true,
    },
    resolved: false,
  };
}

/**
 * Choose exactly one side effect for the durable interrupt state. A stop that
 * was requested but not confirmed is replayed after restart; backend stop must
 * therefore be idempotent and guarded by an exact worker/session CAS.
 */
export function decideFleetInterruptAction(
  snapshot: FleetInterruptWorkerSnapshot,
  now: Date
): FleetInterruptActionDecision {
  if (!validDate(now)) {
    return {
      kind: "operator_attention",
      reason: "interrupt clock is invalid",
      resolved: false,
    };
  }
  const validated = validateInterruptSnapshot(snapshot);
  if (!validated.ok) {
    return {
      kind: "operator_attention",
      reason: validated.error,
      resolved: false,
    };
  }
  const state = validated.value;
  if (!state.requestedAt || !state.deadlineAt || state.deadlineAtMs === null) {
    return { kind: "none", reason: "not_requested", resolved: true };
  }
  if (TERMINAL_WORKER_STATUSES.has(state.status)) {
    return { kind: "none", reason: "worker_terminal", resolved: true };
  }
  if (!ACTIVE_WORKER_STATUSES.has(state.status) || !snapshot.sessionId) {
    return {
      kind: "operator_attention",
      reason: "interrupted worker is not bound to an active exact session",
      resolved: false,
    };
  }
  if (state.stopState === "confirmed") {
    return { kind: "none", reason: "stop_confirmed", resolved: false };
  }

  const atOrAfterDeadline = now.getTime() >= state.deadlineAtMs;
  if (atOrAfterDeadline) {
    return {
      kind: "stop_session",
      operationKey: operationKey(snapshot, state.requestedAt, "stop"),
      requestedAt: state.requestedAt,
      deadlineAt: state.deadlineAt,
      replay: state.stopState === "requested",
    };
  }
  if (state.stopState === "requested") {
    return {
      kind: "operator_attention",
      reason: "interrupt stop was requested before its durable deadline",
      resolved: false,
    };
  }
  if (
    state.noticeState === "unattempted" ||
    state.noticeState === "requested"
  ) {
    return {
      kind: "deliver_notice",
      operationKey: operationKey(snapshot, state.requestedAt, "notice"),
      requestedAt: state.requestedAt,
      deadlineAt: state.deadlineAt,
      replay: state.noticeState === "requested",
    };
  }
  return {
    kind: "wait_for_deadline",
    operationKey: operationKey(snapshot, state.requestedAt, "stop"),
    requestedAt: state.requestedAt,
    deadlineAt: state.deadlineAt,
    replay: false,
  };
}

/** Resume is fail-closed until every durable interrupt is terminal/resolved. */
export function decideFleetResume(
  workers: readonly FleetInterruptWorkerSnapshot[]
): FleetResumeDecision {
  if (!Array.isArray(workers) || workers.length > FLEET_INTERRUPT_MAX_WORKERS) {
    return {
      allowed: false,
      blockingWorkerIds: [],
      reasons: ["interrupt worker set is invalid or exceeds the hard bound"],
    };
  }
  const counts = new Map<string, number>();
  for (const worker of workers) {
    const key = `${worker.runId}\u0000${worker.workerId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const blockers = new Set<string>();
  const reasons = new Set<string>();
  for (const worker of workers) {
    const key = `${worker.runId}\u0000${worker.workerId}`;
    if ((counts.get(key) ?? 0) !== 1) {
      blockers.add(worker.workerId);
      reasons.add("duplicate worker interrupt identity");
      continue;
    }
    const validated = validateInterruptSnapshot(worker);
    if (!validated.ok) {
      blockers.add(worker.workerId);
      reasons.add(validated.error);
      continue;
    }
    const state = validated.value;
    if (
      state.requestedAt !== null &&
      !TERMINAL_WORKER_STATUSES.has(state.status)
    ) {
      blockers.add(worker.workerId);
      reasons.add("an interrupt remains active");
    }
  }
  const blockingWorkerIds = [...blockers].sort();
  return {
    allowed: blockingWorkerIds.length === 0,
    blockingWorkerIds,
    reasons: [...reasons].sort(),
  };
}
