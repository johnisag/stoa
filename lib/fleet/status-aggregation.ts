import { redactFleetText } from "./redaction";

/**
 * Fleet status capture policy is intentionally global. Running it once for
 * each Fleet run would multiply terminal IPC by the number of active runs and
 * defeat the hard per-tick bound.
 */
export const FLEET_STATUS_CAPTURE_HARD_MAX_PER_TICK = 12;
export const FLEET_STATUS_MIN_CAPTURE_INTERVAL_MS = 2_000;
export const FLEET_STATUS_MAX_CAPTURE_INTERVAL_MS = 60_000;
export const FLEET_STATUS_MAX_STABILITY_COUNT = 16;
export const FLEET_STATUS_MAX_CANDIDATES = 4_096;
export const FLEET_STATUS_SUMMARY_MAX_CHARS = 240;
export const FLEET_STATUS_RENDERED_INPUT_MAX_CHARS = 32 * 1024;

export type FleetRenderedSessionStatus =
  "running" | "waiting" | "idle" | "error" | "dead";

export type FleetRenderedStatusClass =
  "active" | "waiting_for_operator" | "error" | "dead";

export interface FleetStatusWorkerCandidate {
  runId: string;
  workerId: string;
  sessionId: string;
  attempt: number;
  workerStatus: unknown;
  lastCapturedAt: string | null;
  nextCaptureAt: string | null;
}

export interface FleetStatusSelectionOptions {
  now: Date;
  /** Callers may lower, but can never raise, the global hard cap. */
  maxCaptures?: number;
}

export interface FleetRenderedSummary {
  summary: string;
  redacted: boolean;
  replacementCount: number;
  truncated: boolean;
}

export interface FleetStatusTransition {
  eventType: "worker_rendered_status_changed";
  from: FleetRenderedStatusClass;
  to: FleetRenderedStatusClass;
  summary: string;
}

export interface FleetStatusObservationInput {
  previousStatus?: unknown;
  previousStableCount?: unknown;
  observedStatus: unknown;
  rendered: unknown;
  observedAt: Date;
}

export type FleetStatusObservationDecision =
  | {
      accepted: true;
      status: FleetRenderedSessionStatus;
      statusClass: FleetRenderedStatusClass;
      stableCount: number;
      summary: FleetRenderedSummary;
      nextDelayMs: number;
      nextCaptureAt: string;
      transition: FleetStatusTransition | null;
      coalesced: boolean;
    }
  | {
      accepted: false;
      reason: string;
      /** A corrupt observation must back off rather than create a hot loop. */
      nextDelayMs: typeof FLEET_STATUS_MAX_CAPTURE_INTERVAL_MS;
      transition: null;
    };

const ACTIVE_WORKER_STATUSES = new Set(["running", "waiting_for_operator"]);
const RENDERED_STATUSES = new Set<FleetRenderedSessionStatus>([
  "running",
  "waiting",
  "idle",
  "error",
  "dead",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function parseCanonicalTimestamp(value: string | null): number | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 40) return Number.NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  try {
    return new Date(parsed).toISOString() === value ? parsed : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function validCandidateIdentity(
  candidate: FleetStatusWorkerCandidate
): boolean {
  return (
    SAFE_ID.test(candidate.runId) &&
    SAFE_ID.test(candidate.workerId) &&
    SAFE_ID.test(candidate.sessionId) &&
    Number.isSafeInteger(candidate.attempt) &&
    candidate.attempt > 0
  );
}

function validWorkerIdentity(candidate: FleetStatusWorkerCandidate): boolean {
  return (
    !!candidate &&
    typeof candidate === "object" &&
    SAFE_ID.test(candidate.runId) &&
    SAFE_ID.test(candidate.workerId)
  );
}

/**
 * Select a single global batch in oldest-due order. Invalid or duplicate rows
 * are skipped in full: choosing one side of a duplicate could capture a stale
 * attempt under the identity of a newer worker.
 */
export function selectDueFleetStatusWorkers(
  candidates: readonly FleetStatusWorkerCandidate[],
  options: FleetStatusSelectionOptions
): FleetStatusWorkerCandidate[] {
  if (
    !Array.isArray(candidates) ||
    candidates.length > FLEET_STATUS_MAX_CANDIDATES ||
    !validDate(options.now)
  ) {
    return [];
  }
  const requested =
    options.maxCaptures === undefined
      ? FLEET_STATUS_CAPTURE_HARD_MAX_PER_TICK
      : options.maxCaptures;
  if (!Number.isSafeInteger(requested) || requested <= 0) return [];
  const limit = Math.min(requested, FLEET_STATUS_CAPTURE_HARD_MAX_PER_TICK);
  const nowMs = options.now.getTime();

  const identityCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (!validWorkerIdentity(candidate)) continue;
    const identity = `${candidate.runId}\u0000${candidate.workerId}`;
    identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
  }

  const due: Array<{
    candidate: FleetStatusWorkerCandidate;
    dueAt: number;
    lastCapturedAt: number;
  }> = [];
  for (const candidate of candidates) {
    if (
      !validCandidateIdentity(candidate) ||
      !ACTIVE_WORKER_STATUSES.has(String(candidate.workerStatus)) ||
      identityCounts.get(`${candidate.runId}\u0000${candidate.workerId}`) !== 1
    ) {
      continue;
    }
    const lastCapturedAt = parseCanonicalTimestamp(candidate.lastCapturedAt);
    const nextCaptureAt = parseCanonicalTimestamp(candidate.nextCaptureAt);
    if (Number.isNaN(lastCapturedAt) || Number.isNaN(nextCaptureAt)) {
      continue;
    }
    const minimumDueAt =
      lastCapturedAt === null
        ? Number.NEGATIVE_INFINITY
        : lastCapturedAt + FLEET_STATUS_MIN_CAPTURE_INTERVAL_MS;
    const scheduledDueAt =
      nextCaptureAt === null ? minimumDueAt : nextCaptureAt;
    const dueAt = Math.max(minimumDueAt, scheduledDueAt);
    if (dueAt > nowMs) continue;
    due.push({
      candidate,
      dueAt,
      lastCapturedAt: lastCapturedAt ?? Number.NEGATIVE_INFINITY,
    });
  }

  due.sort(
    (left, right) =>
      left.dueAt - right.dueAt ||
      left.lastCapturedAt - right.lastCapturedAt ||
      left.candidate.runId.localeCompare(right.candidate.runId) ||
      left.candidate.workerId.localeCompare(right.candidate.workerId) ||
      left.candidate.attempt - right.candidate.attempt
  );
  return due.slice(0, limit).map(({ candidate }) => candidate);
}

export function fleetRenderedStatusClass(
  status: FleetRenderedSessionStatus
): FleetRenderedStatusClass {
  if (status === "running" || status === "idle") return "active";
  if (status === "waiting") return "waiting_for_operator";
  return status;
}

function parsedRenderedStatus(
  status: unknown
): FleetRenderedSessionStatus | null {
  return typeof status === "string" &&
    RENDERED_STATUSES.has(status as FleetRenderedSessionStatus)
    ? (status as FleetRenderedSessionStatus)
    : null;
}

/**
 * Stable observations back off exponentially, with attention states starting
 * slightly slower than active work. Invalid persisted counters/statuses take
 * the maximum delay so corruption cannot turn into an unbounded capture loop.
 */
export function fleetStatusCaptureDelayMs(
  status: unknown,
  stableCount: unknown
): number {
  const parsedStatus = parsedRenderedStatus(status);
  if (
    !parsedStatus ||
    !Number.isSafeInteger(stableCount) ||
    Number(stableCount) < 0 ||
    Number(stableCount) > FLEET_STATUS_MAX_STABILITY_COUNT
  ) {
    return FLEET_STATUS_MAX_CAPTURE_INTERVAL_MS;
  }
  const base =
    parsedStatus === "running"
      ? FLEET_STATUS_MIN_CAPTURE_INTERVAL_MS
      : parsedStatus === "idle" || parsedStatus === "waiting"
        ? 5_000
        : parsedStatus === "error"
          ? 10_000
          : 30_000;
  return Math.min(
    base * 2 ** Math.min(Number(stableCount), 8),
    FLEET_STATUS_MAX_CAPTURE_INTERVAL_MS
  );
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gi, "");
}

/** Build one bounded last-line summary from an already-rendered terminal. */
export function summarizeFleetRenderedStatus(
  rendered: unknown
): FleetRenderedSummary {
  if (typeof rendered !== "string") {
    return {
      summary: "",
      redacted: false,
      replacementCount: 0,
      truncated: false,
    };
  }
  const inputTruncated =
    rendered.length > FLEET_STATUS_RENDERED_INPUT_MAX_CHARS;
  if (inputTruncated) {
    return {
      summary: "[rendered summary omitted: input exceeded limit]",
      redacted: true,
      replacementCount: 0,
      truncated: true,
    };
  }
  const bounded = rendered;
  const clean = stripTerminalControls(bounded);
  const redaction = redactFleetText(clean);
  const lines = redaction.text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const lastLine = lines.at(-1) ?? "";
  const summaryTruncated = lastLine.length > FLEET_STATUS_SUMMARY_MAX_CHARS;
  const summary = summaryTruncated
    ? `${lastLine.slice(0, FLEET_STATUS_SUMMARY_MAX_CHARS - 3)}...`
    : lastLine;
  return {
    summary,
    redacted: redaction.redacted,
    replacementCount: redaction.replacementCount,
    truncated: inputTruncated || summaryTruncated,
  };
}

/**
 * Convert one rendered observation into bounded persistence/event decisions.
 * running <-> idle is deliberately coalesced: both mean an active worker and
 * do not warrant an immutable transition event.
 */
export function decideFleetStatusObservation(
  input: FleetStatusObservationInput
): FleetStatusObservationDecision {
  if (!validDate(input.observedAt) || typeof input.rendered !== "string") {
    return {
      accepted: false,
      reason: "observation timestamp or rendered output is invalid",
      nextDelayMs: FLEET_STATUS_MAX_CAPTURE_INTERVAL_MS,
      transition: null,
    };
  }
  const observedStatus = parsedRenderedStatus(input.observedStatus);
  const hasPreviousStatus =
    input.previousStatus !== undefined && input.previousStatus !== null;
  const previousStatus = hasPreviousStatus
    ? parsedRenderedStatus(input.previousStatus)
    : null;
  const previousStableCount = input.previousStableCount ?? 0;
  if (
    !observedStatus ||
    (hasPreviousStatus && !previousStatus) ||
    !Number.isSafeInteger(previousStableCount) ||
    Number(previousStableCount) < 0 ||
    Number(previousStableCount) > FLEET_STATUS_MAX_STABILITY_COUNT
  ) {
    return {
      accepted: false,
      reason: "rendered status or stability counter is invalid",
      nextDelayMs: FLEET_STATUS_MAX_CAPTURE_INTERVAL_MS,
      transition: null,
    };
  }

  const stableCount =
    previousStatus === observedStatus
      ? Math.min(
          Number(previousStableCount) + 1,
          FLEET_STATUS_MAX_STABILITY_COUNT
        )
      : 0;
  const nextDelayMs = fleetStatusCaptureDelayMs(observedStatus, stableCount);
  const nextTimestamp = input.observedAt.getTime() + nextDelayMs;
  if (!Number.isSafeInteger(nextTimestamp)) {
    return {
      accepted: false,
      reason: "next capture timestamp is outside the safe range",
      nextDelayMs: FLEET_STATUS_MAX_CAPTURE_INTERVAL_MS,
      transition: null,
    };
  }
  const summary = summarizeFleetRenderedStatus(input.rendered);
  const statusClass = fleetRenderedStatusClass(observedStatus);
  const previousClass = previousStatus
    ? fleetRenderedStatusClass(previousStatus)
    : null;
  const meaningfulChange =
    previousClass !== null && previousClass !== statusClass;
  return {
    accepted: true,
    status: observedStatus,
    statusClass,
    stableCount,
    summary,
    nextDelayMs,
    nextCaptureAt: new Date(nextTimestamp).toISOString(),
    transition: meaningfulChange
      ? {
          eventType: "worker_rendered_status_changed",
          from: previousClass,
          to: statusClass,
          summary: summary.summary,
        }
      : null,
    coalesced: previousClass !== null && !meaningfulChange,
  };
}
