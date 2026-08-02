/**
 * Fleet capability primitives (server-only).
 *
 * This module deliberately has no database, HTTP, MCP, or scheduler dependency.
 * It mints opaque secrets, defines the hash-only record that a persistence layer
 * may store later, and makes authorization decisions over an injected record.
 *
 * One-use authorization is a two-part contract: a successful decision returns
 * both `nextRecord` and `atomicConsumption`. A persistence adapter MUST claim the
 * capability with the supplied compare-and-set condition before performing the
 * privileged action. This keeps the pure policy testable without pretending an
 * in-memory check can make two database callers atomic.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";

export const FLEET_CAPABILITY_VERSION = 1 as const;
export const FLEET_CAPABILITY_DEFAULT_TTL_MS = 5 * 60 * 1000;
export const FLEET_CAPABILITY_MAX_TTL_MS = 24 * 60 * 60 * 1000;

const FLEET_CAPABILITY_TOKEN_PREFIX = "stoa_fleet_v1_";
const FLEET_CAPABILITY_SECRET_BYTES = 32;
const FLEET_CAPABILITY_TOKEN_LENGTH = FLEET_CAPABILITY_TOKEN_PREFIX.length + 43;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BOUND_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OPAQUE_TOKEN = /^stoa_fleet_v1_[A-Za-z0-9_-]{43}$/;
const HASH_KINDS: readonly FleetCapabilityHashKind[] = [
  "plan",
  "execution",
  "head",
  "artifact",
];
const DUMMY_TOKEN = `${FLEET_CAPABILITY_TOKEN_PREFIX}${"A".repeat(43)}`;
const ZERO_DIGEST = Buffer.alloc(32);
const ID_MAX = 128;

export const FLEET_CAPABILITY_ACTIONS = [
  "fleet:read",
  "fleet:submit-report",
  "fleet:submit-artifact",
  "fleet:request-input",
  "fleet:create",
  "fleet:plan",
  "fleet:approve",
  "fleet:start",
  "fleet:pause",
  "fleet:resume",
  "fleet:cancel",
  "fleet:retry",
  "fleet:merge",
  "fleet:land",
  "fleet:cleanup",
] as const;

export type FleetCapabilityAction = (typeof FLEET_CAPABILITY_ACTIONS)[number];
export type FleetCapabilityUseMode = "one_use" | "reusable";
export type FleetCapabilityHashKind =
  "plan" | "execution" | "head" | "artifact";

export interface FleetCapabilityHashScope {
  kind: FleetCapabilityHashKind;
  /** Exact lowercase Git SHA-1 or SHA-256/application hash. */
  value: string;
}

/** Every scope dimension is explicit. Use null rather than omitting a dimension. */
export interface FleetCapabilityScope {
  version: typeof FLEET_CAPABILITY_VERSION;
  action: FleetCapabilityAction;
  runId: string;
  taskId: string | null;
  workerId: string | null;
  attempt: number | null;
  boundHash: FleetCapabilityHashScope | null;
}

/** Hash-only durable shape. It must never contain the plaintext token. */
export interface FleetCapabilityRecord {
  id: string;
  tokenHash: string;
  scope: FleetCapabilityScope;
  useMode: FleetCapabilityUseMode;
  issuedAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
  consumedAtMs: number | null;
}

export interface IssuedFleetCapability {
  /** Returned once at issuance; never put this value into a durable record. */
  token: string;
  record: FleetCapabilityRecord;
}

export interface IssueFleetCapabilityOptions {
  issuedAtMs?: number;
  ttlMs?: number;
  useMode?: FleetCapabilityUseMode;
}

export type FleetCapabilityUseRequest = FleetCapabilityScope;

export type FleetCapabilityDenialReason =
  | "invalid_record"
  | "malformed_token"
  | "token_mismatch"
  | "unsupported_version"
  | "not_yet_valid"
  | "expired"
  | "revoked"
  | "consumed"
  | "invalid_request"
  | "wrong_action"
  | "wrong_run"
  | "wrong_task"
  | "wrong_worker"
  | "wrong_attempt"
  | "wrong_hash";

export interface FleetCapabilityAtomicConsumption {
  capabilityId: string;
  tokenHash: string;
  expectedConsumedAtMs: null;
  consumedAtMs: number;
}

export type FleetCapabilityDecision =
  | {
      ok: true;
      nextRecord: FleetCapabilityRecord;
      /**
       * Non-null for one-use capabilities. Persist this as an atomic
       * `consumed_at IS NULL` compare-and-set before carrying out the action.
       */
      atomicConsumption: FleetCapabilityAtomicConsumption | null;
    }
  | { ok: false; reason: FleetCapabilityDenialReason };

export class FleetCapabilityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetCapabilityValidationError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= ID_MAX &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
}

function isAttempt(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0);
}

function isAction(value: unknown): value is FleetCapabilityAction {
  return (FLEET_CAPABILITY_ACTIONS as readonly unknown[]).includes(value);
}

function isHashKind(value: unknown): value is FleetCapabilityHashKind {
  return (HASH_KINDS as readonly unknown[]).includes(value);
}

function isHashScope(value: unknown): value is FleetCapabilityHashScope | null {
  if (value === null) return true;
  if (!isObject(value)) return false;
  return (
    isHashKind(value.kind) &&
    typeof value.value === "string" &&
    BOUND_HASH.test(value.value)
  );
}

function hasScopeShape(value: unknown): value is FleetCapabilityScope {
  if (!isObject(value)) return false;
  return (
    isAction(value.action) &&
    isIdentifier(value.runId) &&
    isNullableIdentifier(value.taskId) &&
    isNullableIdentifier(value.workerId) &&
    isAttempt(value.attempt) &&
    isHashScope(value.boundHash)
  );
}

function validateIssuedScope(scope: FleetCapabilityScope): void {
  if (scope.version !== FLEET_CAPABILITY_VERSION) {
    throw new FleetCapabilityValidationError("unsupported capability version");
  }
  if (!hasScopeShape(scope)) {
    throw new FleetCapabilityValidationError("invalid capability scope");
  }
}

function isRecordShape(record: unknown): record is FleetCapabilityRecord {
  if (!isObject(record) || !isObject(record.scope)) return false;
  return (
    isIdentifier(record.id) &&
    typeof record.tokenHash === "string" &&
    SHA256_HEX.test(record.tokenHash) &&
    hasScopeShape(record.scope) &&
    (record.useMode === "one_use" || record.useMode === "reusable") &&
    isTimestamp(record.issuedAtMs) &&
    isTimestamp(record.expiresAtMs) &&
    Number(record.expiresAtMs) > Number(record.issuedAtMs) &&
    (record.revokedAtMs === null ||
      (isTimestamp(record.revokedAtMs) &&
        Number(record.revokedAtMs) >= Number(record.issuedAtMs))) &&
    (record.consumedAtMs === null ||
      (isTimestamp(record.consumedAtMs) &&
        Number(record.consumedAtMs) >= Number(record.issuedAtMs) &&
        Number(record.consumedAtMs) < Number(record.expiresAtMs))) &&
    !(record.useMode === "reusable" && record.consumedAtMs !== null)
  );
}

function cloneHashScope(
  value: FleetCapabilityHashScope | null
): FleetCapabilityHashScope | null {
  return value ? { kind: value.kind, value: value.value } : null;
}

function cloneRecord(record: FleetCapabilityRecord): FleetCapabilityRecord {
  return {
    ...record,
    scope: {
      ...record.scope,
      boundHash: cloneHashScope(record.scope.boundHash),
    },
  };
}

/** SHA-256 hex digest used as the only durable representation of a token. */
export function hashFleetCapabilityToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Cheap, allocation-bounded syntax check to run before hashing or DB lookup. */
export function isFleetCapabilityToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === FLEET_CAPABILITY_TOKEN_LENGTH &&
    OPAQUE_TOKEN.test(value)
  );
}

/**
 * Compare a presented opaque token with a stored digest. The digest comparison
 * always uses equal-length buffers and `timingSafeEqual`; malformed input is
 * compared using fixed dummy material and then rejected.
 */
export function matchesFleetCapabilityToken(
  presentedToken: unknown,
  storedTokenHash: unknown
): boolean {
  const tokenValid = isFleetCapabilityToken(presentedToken);
  const storedHashValid =
    typeof storedTokenHash === "string" && SHA256_HEX.test(storedTokenHash);

  const candidateDigest = Buffer.from(
    hashFleetCapabilityToken(
      tokenValid ? (presentedToken as string) : DUMMY_TOKEN
    ),
    "hex"
  );
  const storedDigest = storedHashValid
    ? Buffer.from(storedTokenHash as string, "hex")
    : ZERO_DIGEST;
  const matches = timingSafeEqual(candidateDigest, storedDigest);
  return tokenValid && storedHashValid && matches;
}

/** Mint a random opaque capability and its hash-only durable record. */
export function issueFleetCapability(
  scope: FleetCapabilityScope,
  options: IssueFleetCapabilityOptions = {}
): IssuedFleetCapability {
  validateIssuedScope(scope);
  const issuedAtMs = options.issuedAtMs ?? Date.now();
  const ttlMs = options.ttlMs ?? FLEET_CAPABILITY_DEFAULT_TTL_MS;
  const useMode = options.useMode ?? "one_use";
  if (!isTimestamp(issuedAtMs)) {
    throw new FleetCapabilityValidationError("issuedAtMs must be a timestamp");
  }
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > FLEET_CAPABILITY_MAX_TTL_MS
  ) {
    throw new FleetCapabilityValidationError("ttlMs is outside allowed bounds");
  }
  if (useMode !== "one_use" && useMode !== "reusable") {
    throw new FleetCapabilityValidationError("invalid capability use mode");
  }
  const expiresAtMs = issuedAtMs + ttlMs;
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new FleetCapabilityValidationError("capability expiry is invalid");
  }

  const token = `${FLEET_CAPABILITY_TOKEN_PREFIX}${randomBytes(
    FLEET_CAPABILITY_SECRET_BYTES
  ).toString("base64url")}`;
  return {
    token,
    record: {
      id: randomBytes(12).toString("base64url"),
      tokenHash: hashFleetCapabilityToken(token),
      scope: {
        ...scope,
        boundHash: cloneHashScope(scope.boundHash),
      },
      useMode,
      issuedAtMs,
      expiresAtMs,
      revokedAtMs: null,
      consumedAtMs: null,
    },
  };
}

function sameHashScope(
  expected: FleetCapabilityHashScope | null,
  presented: FleetCapabilityHashScope | null
): boolean {
  if (expected === null || presented === null) return expected === presented;
  return expected.kind === presented.kind && expected.value === presented.value;
}

/**
 * Authorize one exact capability use. This function is pure for a given record,
 * token, request, and timestamp. See the module header for the required atomic
 * persistence step before a one-use action is performed.
 */
export function decideFleetCapabilityUse(
  record: FleetCapabilityRecord,
  presentedToken: unknown,
  request: FleetCapabilityUseRequest,
  nowMs = Date.now()
): FleetCapabilityDecision {
  if (!isRecordShape(record)) return { ok: false, reason: "invalid_record" };
  if (!isFleetCapabilityToken(presentedToken)) {
    // Still perform the fixed-size comparison before returning. This avoids a
    // separate digest-comparison path for malformed input.
    matchesFleetCapabilityToken(presentedToken, record.tokenHash);
    return { ok: false, reason: "malformed_token" };
  }
  if (!matchesFleetCapabilityToken(presentedToken, record.tokenHash)) {
    return { ok: false, reason: "token_mismatch" };
  }
  if (
    record.scope.version !== FLEET_CAPABILITY_VERSION ||
    !isObject(request) ||
    request.version !== FLEET_CAPABILITY_VERSION
  ) {
    return { ok: false, reason: "unsupported_version" };
  }
  if (!isTimestamp(nowMs)) return { ok: false, reason: "invalid_request" };
  if (nowMs < record.issuedAtMs) {
    return { ok: false, reason: "not_yet_valid" };
  }
  if (nowMs >= record.expiresAtMs) {
    return { ok: false, reason: "expired" };
  }
  if (record.revokedAtMs !== null) {
    return { ok: false, reason: "revoked" };
  }
  if (record.useMode === "one_use" && record.consumedAtMs !== null) {
    return { ok: false, reason: "consumed" };
  }
  if (!hasScopeShape(request)) {
    return { ok: false, reason: "invalid_request" };
  }
  if (record.scope.action !== request.action) {
    return { ok: false, reason: "wrong_action" };
  }
  if (record.scope.runId !== request.runId) {
    return { ok: false, reason: "wrong_run" };
  }
  if (record.scope.taskId !== request.taskId) {
    return { ok: false, reason: "wrong_task" };
  }
  if (record.scope.workerId !== request.workerId) {
    return { ok: false, reason: "wrong_worker" };
  }
  if (record.scope.attempt !== request.attempt) {
    return { ok: false, reason: "wrong_attempt" };
  }
  if (!sameHashScope(record.scope.boundHash, request.boundHash)) {
    return { ok: false, reason: "wrong_hash" };
  }

  const nextRecord = cloneRecord(record);
  if (record.useMode === "reusable") {
    return { ok: true, nextRecord, atomicConsumption: null };
  }
  nextRecord.consumedAtMs = nowMs;
  return {
    ok: true,
    nextRecord,
    atomicConsumption: {
      capabilityId: record.id,
      tokenHash: record.tokenHash,
      expectedConsumedAtMs: null,
      consumedAtMs: nowMs,
    },
  };
}

/** Return an idempotently revoked copy; persistence remains the caller's job. */
export function revokeFleetCapability(
  record: FleetCapabilityRecord,
  revokedAtMs = Date.now()
): FleetCapabilityRecord {
  if (!isRecordShape(record)) {
    throw new FleetCapabilityValidationError("invalid capability record");
  }
  if (!isTimestamp(revokedAtMs)) {
    throw new FleetCapabilityValidationError("revokedAtMs must be a timestamp");
  }
  if (revokedAtMs < record.issuedAtMs) {
    throw new FleetCapabilityValidationError(
      "revokedAtMs cannot precede issuance"
    );
  }
  if (record.revokedAtMs !== null) return cloneRecord(record);
  return { ...cloneRecord(record), revokedAtMs };
}
