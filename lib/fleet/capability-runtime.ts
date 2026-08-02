import { createHash, randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import {
  FLEET_CAPABILITY_VERSION,
  decideFleetCapabilityUse,
  hashFleetCapabilityToken,
  isFleetCapabilityToken,
  issueFleetCapability,
  type FleetCapabilityAction,
  type FleetCapabilityHashScope,
  type FleetCapabilityRecord,
  type FleetCapabilityScope,
  type FleetCapabilityUseMode,
} from "./capability";
import { hashParsedFleetPlanTasks } from "./hash";
import { parseFleetPlanText } from "./plan";
import {
  approveFleetRunPlan,
  attachFleetPlanCriticArtifact,
  cancelFleetRun,
  createDraftFleetRun,
  getFleetRunDetail,
  ingestFleetRunPlan,
  listFleetRuns,
  pauseFleetRun,
  resumeFleetRun,
} from "./service";
import {
  authorizeFleetManualLanding,
  getFleetMergeStatus,
  requestFleetMerge,
} from "./merge-runtime";
import { getFleetSupervisorSnapshot } from "./supervisor";
import type { FleetMergeTarget, FleetRunRow } from "./types";
import { fleetLaunchBlockedResult } from "./recovery-gate";

const CAPABILITY_LEASE_MS = 5 * 60 * 1000;
const ACTOR_MAX = 80;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Only these operations are reachable through the capability action endpoint. */
export const DIRECT_FLEET_CAPABILITY_ACTIONS = [
  "fleet:read",
  "fleet:create",
  "fleet:plan",
  "fleet:approve",
  "fleet:start",
  "fleet:pause",
  "fleet:resume",
  "fleet:cancel",
  "fleet:submit-artifact",
  "fleet:merge",
  "fleet:land",
] as const satisfies readonly FleetCapabilityAction[];

type DirectFleetCapabilityAction =
  (typeof DIRECT_FLEET_CAPABILITY_ACTIONS)[number];

interface FleetCapabilityRow {
  id: string;
  token_hash: string;
  version: number;
  action: FleetCapabilityAction;
  run_id: string;
  task_id: string | null;
  worker_id: string | null;
  attempt: number | null;
  bound_hash_kind: FleetCapabilityHashScope["kind"] | null;
  bound_hash_value: string | null;
  use_mode: FleetCapabilityUseMode;
  issued_at_ms: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
  consumed_at_ms: number | null;
  lease_owner: string | null;
  lease_expires_at_ms: number | null;
  use_count: number;
  issued_by: string;
}

export interface FleetCapabilityPublicRecord {
  id: string;
  scope: FleetCapabilityScope;
  useMode: FleetCapabilityUseMode;
  issuedAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
  consumedAtMs: number | null;
  useCount: number;
  issuedBy: string;
}

export interface StoredFleetCapabilityIssue {
  /** Returned exactly once. It is never written to SQLite or audit metadata. */
  token: string;
  capability: FleetCapabilityPublicRecord;
}

export type FleetCapabilityRuntimeError = {
  error: string;
  status: number;
};

export interface FleetCapabilityRuntimeOptions {
  db?: Database.Database;
  nowMs?: number;
}

export interface FleetCapabilityActionRequest {
  token: unknown;
  scope: unknown;
  payload?: unknown;
}

interface ClaimedCapability {
  row: FleetCapabilityRow;
  record: FleetCapabilityRecord;
  leaseOwner: string;
}

interface ExactFleetMergeIntent {
  target: FleetMergeTarget;
  planHash: string;
  baseSha: string;
  executionHash: string;
  integrationHeadSha: string | null;
}

interface ExactFleetLandingIntent extends ExactFleetMergeIntent {
  integrationHeadSha: string;
}

function authorizeStoredFleetCapabilityReadOnly(
  request: FleetCapabilityActionRequest,
  options: FleetCapabilityRuntimeOptions = {}
): FleetCapabilityRecord | FleetCapabilityRuntimeError {
  const token = typeof request.token === "string" ? request.token : "";
  const scope = objectValue(request.scope) as unknown as FleetCapabilityScope;
  if (!isFleetCapabilityToken(token)) {
    return { error: "capability denied", status: 403 };
  }
  const db = options.db ?? getDb();
  const nowMs = options.nowMs ?? Date.now();
  const row = getRowByToken(db, token);
  if (!row) return { error: "capability denied", status: 403 };
  const record = rowRecord(row);
  const decision = decideFleetCapabilityUse(record, token, scope, nowMs);
  return decision.ok ? record : { error: "capability denied", status: 403 };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  const object = objectValue(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => [key, stableValue(object[key])])
  );
}

function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function scopeHash(scope: FleetCapabilityScope): string {
  return stableHash(scope);
}

function actorValue(value: string, fallback: string): string {
  return value.trim().slice(0, ACTOR_MAX) || fallback;
}

function rowScope(row: FleetCapabilityRow): FleetCapabilityScope {
  return {
    version: row.version as typeof FLEET_CAPABILITY_VERSION,
    action: row.action,
    runId: row.run_id,
    taskId: row.task_id,
    workerId: row.worker_id,
    attempt: row.attempt,
    boundHash:
      row.bound_hash_kind && row.bound_hash_value
        ? { kind: row.bound_hash_kind, value: row.bound_hash_value }
        : null,
  };
}

function rowRecord(row: FleetCapabilityRow): FleetCapabilityRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    scope: rowScope(row),
    useMode: row.use_mode,
    issuedAtMs: row.issued_at_ms,
    expiresAtMs: row.expires_at_ms,
    revokedAtMs: row.revoked_at_ms,
    consumedAtMs: row.consumed_at_ms,
  };
}

function publicRecord(row: FleetCapabilityRow): FleetCapabilityPublicRecord {
  return {
    id: row.id,
    scope: rowScope(row),
    useMode: row.use_mode,
    issuedAtMs: row.issued_at_ms,
    expiresAtMs: row.expires_at_ms,
    revokedAtMs: row.revoked_at_ms,
    consumedAtMs: row.consumed_at_ms,
    useCount: row.use_count,
    issuedBy: row.issued_by,
  };
}

function immediateTransaction<T>(db: Database.Database, callback: () => T): T {
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

function audit(
  db: Database.Database,
  record: FleetCapabilityRecord,
  eventType: "issued" | "revoked" | "claimed" | "succeeded" | "failed",
  nowMs: number,
  metadata: Record<string, unknown> = {}
): void {
  // Metadata is generated internally and intentionally contains no request body,
  // presented token, or token digest.
  const metadataJson = JSON.stringify(stableValue(metadata)).slice(0, 2048);
  db.prepare(
    `INSERT INTO fleet_capability_audit
     (capability_id, run_id, action, event_type, scope_hash, metadata_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.scope.runId,
    record.scope.action,
    eventType,
    scopeHash(record.scope),
    metadataJson,
    nowMs
  );
}

function getRowByToken(
  db: Database.Database,
  token: string
): FleetCapabilityRow | undefined {
  return db
    .prepare(`SELECT * FROM fleet_capabilities WHERE token_hash = ?`)
    .get(hashFleetCapabilityToken(token)) as FleetCapabilityRow | undefined;
}

function getRun(db: Database.Database, runId: string): FleetRunRow | undefined {
  return db.prepare(`SELECT * FROM fleet_runs WHERE id = ?`).get(runId) as
    FleetRunRow | undefined;
}

function approvedExecutionHash(run: FleetRunRow): string | null {
  try {
    const settings = objectValue(JSON.parse(run.settings_json));
    const hash = settings?.approvedExecutionHash;
    return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
      ? hash
      : null;
  } catch {
    return null;
  }
}

function mergeTarget(payload: unknown): FleetMergeTarget | null {
  const target = objectValue(payload)?.target;
  return target === "local" || target === "github_pr" ? target : null;
}

function exactFleetMergeIntent(
  db: Database.Database,
  runId: string,
  payload: unknown
): ExactFleetMergeIntent | FleetCapabilityRuntimeError {
  const target = mergeTarget(payload);
  if (!target) return { error: "merge target is required", status: 400 };
  const run = getRun(db, runId);
  if (!run) return { error: "Fleet run not found", status: 404 };
  const snapshot = getFleetSupervisorSnapshot(runId, db);
  const bindings = snapshot?.bindings;
  if (
    !bindings?.contractComplete ||
    !bindings.exactPlanApproval ||
    !bindings.exactExecutionApproval ||
    !bindings.planHash ||
    !bindings.executionHash
  ) {
    return {
      error: "run has no exact approved execution contract",
      status: 409,
    };
  }
  const baseSha = run.automation_base_sha;
  if (!baseSha || !SHA.test(baseSha)) {
    return {
      error: "run has no exact automation base head for merge authorization",
      status: 409,
    };
  }
  const integrationHeadSha = run.integration_head_sha ?? null;
  if (integrationHeadSha !== null && !SHA.test(integrationHeadSha)) {
    return {
      error: "run has no exact integration head for merge authorization",
      status: 409,
    };
  }
  return {
    target,
    planHash: bindings.planHash,
    baseSha,
    executionHash: bindings.executionHash,
    integrationHeadSha,
  };
}

function fleetMergeIntentHash(
  intent: ExactFleetMergeIntent
): FleetCapabilityHashScope {
  return { kind: "head", value: stableHash(intent) };
}

function exactFleetLandingIntent(
  db: Database.Database,
  runId: string,
  payload: unknown
): ExactFleetLandingIntent | FleetCapabilityRuntimeError {
  const intent = exactFleetMergeIntent(db, runId, payload);
  if ("error" in intent) return intent;
  const status = getFleetMergeStatus(runId, db);
  if (
    !intent.integrationHeadSha ||
    status?.integration.state !== "ready_to_finalize" ||
    status.integration.requestKind !== "manual" ||
    status.integration.requestedAt !== null ||
    status.integration.target !== intent.target ||
    status.integration.baseSha !== intent.baseSha ||
    status.integration.headSha !== intent.integrationHeadSha ||
    !status.readiness.canFinalize ||
    !status.readiness.allTasksIntegrated
  ) {
    return {
      error: "manual merge is not staged and final-verified for landing",
      status: 409,
    };
  }
  return { ...intent, integrationHeadSha: intent.integrationHeadSha };
}

function withoutUntrustedActor(
  payload: unknown,
  stripTask = false
): Record<string, unknown> | null {
  const object = objectValue(payload);
  if (!object) return null;
  const { actor: _actor, taskId: _taskId, ...rest } = object;
  return stripTask ? rest : { ...rest, taskId: _taskId };
}

function deriveBoundHash(
  db: Database.Database,
  action: DirectFleetCapabilityAction,
  runId: string,
  payload: unknown
): FleetCapabilityHashScope | null | FleetCapabilityRuntimeError {
  if (action === "fleet:read") return null;
  if (action === "fleet:create") {
    const intent = withoutUntrustedActor(payload);
    return intent
      ? { kind: "artifact", value: stableHash(intent) }
      : { error: "payload is required for fleet:create", status: 400 };
  }
  if (action === "fleet:plan") {
    const parsed = parseFleetPlanText(objectValue(payload)?.planText);
    if ("error" in parsed) return { error: parsed.error, status: 400 };
    return {
      kind: "plan",
      value: hashParsedFleetPlanTasks(parsed.tasks),
    };
  }

  const run = getRun(db, runId);
  if (!run) return { error: "Fleet run not found", status: 404 };

  if (action === "fleet:approve") {
    return run.plan_hash && /^[0-9a-f]{64}$/.test(run.plan_hash)
      ? { kind: "plan", value: run.plan_hash }
      : { error: "run has no exact plan hash", status: 409 };
  }
  if (
    action === "fleet:start" ||
    action === "fleet:pause" ||
    action === "fleet:resume" ||
    action === "fleet:cancel"
  ) {
    const executionHash = approvedExecutionHash(run);
    return executionHash
      ? { kind: "execution", value: executionHash }
      : { error: "run has no approved execution hash", status: 409 };
  }
  if (action === "fleet:submit-artifact") {
    const artifact = withoutUntrustedActor(payload, true);
    return artifact
      ? { kind: "artifact", value: stableHash(artifact) }
      : { error: "payload is required for fleet:submit-artifact", status: 400 };
  }
  const intent =
    action === "fleet:land"
      ? exactFleetLandingIntent(db, runId, payload)
      : exactFleetMergeIntent(db, runId, payload);
  return "error" in intent ? intent : fleetMergeIntentHash(intent);
}

function validateScopeRelations(
  db: Database.Database,
  action: DirectFleetCapabilityAction,
  scope: FleetCapabilityScope
): FleetCapabilityRuntimeError | null {
  const run = getRun(db, scope.runId);
  if (action === "fleet:read") {
    if (scope.taskId || scope.workerId || scope.attempt !== null) {
      return { error: "fleet:read must use a run-only scope", status: 400 };
    }
    if (scope.runId === "*") return null;
    return run ? null : { error: "Fleet run not found", status: 404 };
  }
  if (action === "fleet:create") {
    if (run) return { error: "runId is already in use", status: 409 };
    if (scope.taskId || scope.workerId || scope.attempt !== null) {
      return { error: "fleet:create must use a run-only scope", status: 400 };
    }
    return null;
  }
  if (!run) return { error: "Fleet run not found", status: 404 };

  if (action !== "fleet:submit-artifact") {
    if (scope.taskId || scope.workerId || scope.attempt !== null) {
      return { error: `${action} must use a run-only scope`, status: 400 };
    }
    return null;
  }
  if (scope.workerId || scope.attempt !== null) {
    return {
      error: "fleet:submit-artifact does not accept a worker or attempt scope",
      status: 400,
    };
  }
  if (scope.taskId) {
    const task = db
      .prepare(`SELECT id FROM fleet_tasks WHERE id = ? AND fleet_run_id = ?`)
      .get(scope.taskId, scope.runId);
    if (!task) return { error: "taskId is outside the run", status: 400 };
  }
  return null;
}

function directAction(value: unknown): DirectFleetCapabilityAction | null {
  return (DIRECT_FLEET_CAPABILITY_ACTIONS as readonly unknown[]).includes(value)
    ? (value as DirectFleetCapabilityAction)
    : null;
}

/** Persist a human/admin-issued capability, returning its secret only once. */
export function issueStoredFleetCapability(
  input: unknown,
  issuedBy = "operator",
  options: FleetCapabilityRuntimeOptions = {}
): StoredFleetCapabilityIssue | FleetCapabilityRuntimeError {
  const payload = objectValue(input);
  if (!payload) return { error: "Invalid capability request", status: 400 };
  const requiredDimensions = ["taskId", "workerId", "attempt"];
  if (!requiredDimensions.every((key) => Object.hasOwn(payload, key))) {
    return {
      error: "taskId, workerId, and attempt must be explicit (use null)",
      status: 400,
    };
  }
  const action = directAction(payload.action);
  if (!action)
    return { error: "unsupported Fleet capability action", status: 400 };
  const scope: FleetCapabilityScope = {
    version: FLEET_CAPABILITY_VERSION,
    action,
    runId: typeof payload.runId === "string" ? payload.runId : "",
    taskId: payload.taskId as string | null,
    workerId: payload.workerId as string | null,
    attempt: payload.attempt as number | null,
    boundHash: null,
  };
  const db = options.db ?? getDb();
  if (action === "fleet:read" && payload.useMode !== "reusable") {
    return {
      error: "fleet:read capabilities must explicitly be reusable",
      status: 400,
    };
  }
  if (
    action !== "fleet:read" &&
    payload.useMode !== undefined &&
    payload.useMode !== "one_use"
  ) {
    return {
      error: "Fleet mutation capabilities must be one-use",
      status: 400,
    };
  }
  const relationError = validateScopeRelations(db, action, scope);
  if (relationError) return relationError;
  const derived = deriveBoundHash(db, action, scope.runId, payload.payload);
  if (derived && "error" in derived) return derived;
  const requestedHash = objectValue(payload.boundHash);
  if (
    requestedHash &&
    (!derived ||
      requestedHash.kind !== derived.kind ||
      requestedHash.value !== derived.value)
  ) {
    return {
      error: "boundHash does not match the exact action intent",
      status: 409,
    };
  }
  scope.boundHash = derived;

  let issued;
  try {
    issued = issueFleetCapability(scope, {
      issuedAtMs: options.nowMs,
      ttlMs: payload.ttlMs as number | undefined,
      useMode: payload.useMode as FleetCapabilityUseMode | undefined,
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "invalid capability",
      status: 400,
    };
  }
  const record = issued.record;
  const safeIssuer = actorValue(issuedBy, "operator");
  immediateTransaction(db, () => {
    db.prepare(
      `INSERT INTO fleet_capabilities
       (id, token_hash, version, action, run_id, task_id, worker_id, attempt,
        bound_hash_kind, bound_hash_value, use_mode, issued_at_ms, expires_at_ms,
        revoked_at_ms, consumed_at_ms, issued_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
    ).run(
      record.id,
      record.tokenHash,
      record.scope.version,
      record.scope.action,
      record.scope.runId,
      record.scope.taskId,
      record.scope.workerId,
      record.scope.attempt,
      record.scope.boundHash?.kind ?? null,
      record.scope.boundHash?.value ?? null,
      record.useMode,
      record.issuedAtMs,
      record.expiresAtMs,
      safeIssuer
    );
    audit(db, record, "issued", record.issuedAtMs, {
      issuedBy: safeIssuer,
      useMode: record.useMode,
    });
  });
  const row = db
    .prepare(`SELECT * FROM fleet_capabilities WHERE id = ?`)
    .get(record.id) as FleetCapabilityRow;
  return { token: issued.token, capability: publicRecord(row) };
}

/** Idempotently revoke a capability. There is intentionally no delete API. */
export function revokeStoredFleetCapability(
  capabilityId: string,
  revokedBy = "operator",
  options: FleetCapabilityRuntimeOptions = {}
): FleetCapabilityPublicRecord | FleetCapabilityRuntimeError {
  const db = options.db ?? getDb();
  const nowMs = options.nowMs ?? Date.now();
  return immediateTransaction(db, () => {
    const before = db
      .prepare(`SELECT * FROM fleet_capabilities WHERE id = ?`)
      .get(capabilityId) as FleetCapabilityRow | undefined;
    if (!before) return { error: "Fleet capability not found", status: 404 };
    if (before.revoked_at_ms === null) {
      const changed = db
        .prepare(
          `UPDATE fleet_capabilities
           SET revoked_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
               updated_at = datetime('now')
           WHERE id = ? AND revoked_at_ms IS NULL`
        )
        .run(nowMs, capabilityId);
      if (changed.changes === 1) {
        audit(db, rowRecord(before), "revoked", nowMs, {
          revokedBy: actorValue(revokedBy, "operator"),
        });
      }
    }
    const after = db
      .prepare(`SELECT * FROM fleet_capabilities WHERE id = ?`)
      .get(capabilityId) as FleetCapabilityRow;
    return publicRecord(after);
  });
}

/**
 * Authenticate the exact scope, then atomically claim it before any privileged
 * action. Exported for race/replay tests; callers must always finalize the lease.
 */
export function claimStoredFleetCapability(
  request: FleetCapabilityActionRequest,
  options: FleetCapabilityRuntimeOptions = {}
): ClaimedCapability | FleetCapabilityRuntimeError {
  const token = typeof request.token === "string" ? request.token : "";
  const scope = objectValue(request.scope) as unknown as FleetCapabilityScope;
  // Reject malformed/oversized material before initializing SQLite, hashing, or
  // preparing a query. A well-formed unknown token costs one indexed lookup and
  // is additionally bounded by the action route's per-client rate limit.
  if (!isFleetCapabilityToken(token)) {
    return { error: "capability denied", status: 403 };
  }
  const db = options.db ?? getDb();
  const nowMs = options.nowMs ?? Date.now();
  const row = getRowByToken(db, token);
  if (!row) return { error: "capability denied", status: 403 };
  const record = rowRecord(row);
  const decision = decideFleetCapabilityUse(record, token, scope, nowMs);
  if (!decision.ok) return { error: "capability denied", status: 403 };

  const leaseOwner = randomUUID();
  const claimed = immediateTransaction(db, () => {
    const update = db
      .prepare(
        `UPDATE fleet_capabilities
         SET consumed_at_ms = CASE WHEN use_mode = 'one_use' THEN ? ELSE consumed_at_ms END,
             lease_owner = ?, lease_expires_at_ms = ?, use_count = use_count + 1,
             updated_at = datetime('now')
         WHERE id = ? AND token_hash = ? AND revoked_at_ms IS NULL
           AND issued_at_ms <= ? AND expires_at_ms > ?
           AND (lease_owner IS NULL OR lease_expires_at_ms <= ?)
           AND (use_mode = 'reusable' OR consumed_at_ms IS NULL)`
      )
      .run(
        nowMs,
        leaseOwner,
        nowMs + CAPABILITY_LEASE_MS,
        row.id,
        row.token_hash,
        nowMs,
        nowMs,
        nowMs
      );
    if (update.changes !== 1) return false;
    audit(db, decision.nextRecord, "claimed", nowMs, {
      useMode: row.use_mode,
    });
    return true;
  });
  if (!claimed)
    return { error: "capability already used or busy", status: 409 };
  const current = db
    .prepare(`SELECT * FROM fleet_capabilities WHERE id = ?`)
    .get(row.id) as FleetCapabilityRow;
  return { row: current, record: rowRecord(current), leaseOwner };
}

export function finalizeStoredFleetCapability(
  claim: ClaimedCapability,
  succeeded: boolean,
  options: FleetCapabilityRuntimeOptions = {}
): void {
  const db = options.db ?? getDb();
  const nowMs = options.nowMs ?? Date.now();
  immediateTransaction(db, () => {
    const cleared = db
      .prepare(
        `UPDATE fleet_capabilities
         SET lease_owner = NULL, lease_expires_at_ms = NULL,
             updated_at = datetime('now')
         WHERE id = ? AND lease_owner = ?`
      )
      .run(claim.row.id, claim.leaseOwner);
    if (cleared.changes === 1) {
      audit(db, claim.record, succeeded ? "succeeded" : "failed", nowMs);
    }
  });
}

function verifyCurrentIntent(
  db: Database.Database,
  record: FleetCapabilityRecord,
  payload: unknown
): FleetCapabilityRuntimeError | null {
  const action = directAction(record.scope.action);
  if (!action)
    return { error: "unsupported Fleet capability action", status: 403 };
  const current = deriveBoundHash(db, action, record.scope.runId, payload);
  if (current && "error" in current) return current;
  const expected = record.scope.boundHash;
  if (current === null || expected === null) {
    return current === expected
      ? null
      : { error: "capability action intent changed", status: 409 };
  }
  if (expected.kind !== current.kind || expected.value !== current.value) {
    return { error: "capability action intent changed", status: 409 };
  }
  return null;
}

/** Claim, re-check the state/payload hash, execute, and immutably audit. */
export async function executeStoredFleetCapability(
  request: FleetCapabilityActionRequest,
  options: FleetCapabilityRuntimeOptions = {}
): Promise<{ result: unknown } | FleetCapabilityRuntimeError> {
  const authorized = authorizeStoredFleetCapabilityReadOnly(request, options);
  if ("error" in authorized) return authorized;
  const db = options.db ?? getDb();
  if (
    ["fleet:start", "fleet:resume", "fleet:merge", "fleet:land"].includes(
      authorized.scope.action
    )
  ) {
    const recoveryBlocked = fleetLaunchBlockedResult(
      db,
      authorized.scope.runId
    );
    if (recoveryBlocked) return recoveryBlocked;
  }
  let mergeIntent: ExactFleetMergeIntent | null = null;
  if (authorized.scope.action === "fleet:merge") {
    const current = exactFleetMergeIntent(
      db,
      authorized.scope.runId,
      request.payload
    );
    if ("error" in current) return current;
    const expected = authorized.scope.boundHash;
    const currentHash = fleetMergeIntentHash(current);
    if (
      !expected ||
      expected.kind !== currentHash.kind ||
      expected.value !== currentHash.value
    ) {
      return { error: "capability action intent changed", status: 409 };
    }
    mergeIntent = current;
  }
  let landingIntent: ExactFleetLandingIntent | null = null;
  if (authorized.scope.action === "fleet:land") {
    const current = exactFleetLandingIntent(
      db,
      authorized.scope.runId,
      request.payload
    );
    if ("error" in current) return current;
    const expected = authorized.scope.boundHash;
    const currentHash = fleetMergeIntentHash(current);
    if (
      !expected ||
      expected.kind !== currentHash.kind ||
      expected.value !== currentHash.value
    ) {
      return { error: "capability action intent changed", status: 409 };
    }
    landingIntent = current;
  }
  const claim = claimStoredFleetCapability(request, options);
  if ("error" in claim) return claim;
  let succeeded = false;
  try {
    const intentError = verifyCurrentIntent(db, claim.record, request.payload);
    if (intentError) return intentError;
    const { action, runId, taskId, boundHash } = claim.record.scope;
    const payload = withoutUntrustedActor(request.payload) ?? {};
    const actor = `fleet-capability:${claim.record.id}`;
    let result: unknown;

    if (action === "fleet:read") {
      const resource = objectValue(request.payload)?.resource;
      if (resource === "runs" && runId === "*") {
        result = { runs: listFleetRuns() };
      } else if (resource === "run" && runId !== "*") {
        const run = getFleetRunDetail(runId);
        result = run ? { run } : { error: "Fleet run not found", status: 404 };
      } else if (resource === "tasks" && runId !== "*") {
        const run = getFleetRunDetail(runId);
        result = run
          ? { runId, tasks: run.tasks }
          : { error: "Fleet run not found", status: 404 };
      } else if (resource === "supervisor" && runId !== "*") {
        const snapshot = getFleetSupervisorSnapshot(runId, db);
        result = snapshot
          ? { runId, snapshot }
          : { error: "Fleet run not found", status: 404 };
      } else {
        result = {
          error: "fleet:read scope does not match resource",
          status: 403,
        };
      }
    } else if (action === "fleet:create") {
      result = createDraftFleetRun(payload, actor, runId);
    } else if (action === "fleet:plan") {
      result = ingestFleetRunPlan(runId, { ...payload, actor });
    } else if (action === "fleet:approve") {
      result = approveFleetRunPlan(
        runId,
        { expectedPlanHash: boundHash?.value },
        actor
      );
    } else if (action === "fleet:start" || action === "fleet:resume") {
      result = await resumeFleetRun(
        runId,
        {
          actor,
          conductorSessionId: null,
        },
        { db }
      );
    } else if (action === "fleet:pause") {
      result = await pauseFleetRun(runId, { actor, mode: "pause-new" });
    } else if (action === "fleet:cancel") {
      result = await cancelFleetRun(runId, {
        actor,
        mode: "cancel-preserve-worktrees",
      });
    } else if (action === "fleet:submit-artifact") {
      result = attachFleetPlanCriticArtifact(runId, {
        ...payload,
        taskId,
        actor,
      });
    } else if (action === "fleet:merge") {
      result = mergeIntent
        ? await requestFleetMerge(
            runId,
            mergeIntent.target,
            actor,
            { db },
            {
              planHash: mergeIntent.planHash,
              baseSha: mergeIntent.baseSha,
              executionHash: mergeIntent.executionHash,
              integrationHeadSha: mergeIntent.integrationHeadSha,
            }
          )
        : { error: "merge target is required" };
    } else if (action === "fleet:land") {
      result = landingIntent
        ? await authorizeFleetManualLanding(
            runId,
            landingIntent.target,
            actor,
            {
              planHash: landingIntent.planHash,
              baseSha: landingIntent.baseSha,
              executionHash: landingIntent.executionHash,
              integrationHeadSha: landingIntent.integrationHeadSha,
            },
            { db }
          )
        : { error: "manual merge is not ready for landing" };
    } else {
      return { error: "unsupported Fleet capability action", status: 403 };
    }

    if (objectValue(result)?.error) {
      const status = objectValue(result)?.status;
      return {
        error: String(objectValue(result)?.error),
        status: typeof status === "number" ? status : 409,
      };
    }
    succeeded = true;
    return { result };
  } finally {
    finalizeStoredFleetCapability(claim, succeeded, options);
  }
}
