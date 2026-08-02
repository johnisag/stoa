import { createHash, timingSafeEqual } from "crypto";
import { isAbsolute, posix, win32 } from "path";
import { readBoundedRegularFile } from "./artifacts";

export const FLEET_REPORT_SCHEMA_VERSION = 1 as const;
export const FLEET_REPORT_MAX_BYTES = 128 * 1024;
export const FLEET_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const FLEET_REPORT_FUTURE_SKEW_MS = 5 * 60 * 1000;

const ID_MAX = 128;
const SUMMARY_MAX = 8_000;
const BODY_MAX = 32_000;
const LIST_MAX = 200;
const LIST_ENTRY_MAX = 2_000;
const PATH_MAX = 1_024;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{32,256}$/;

export type FleetReportStatus = "succeeded" | "blocked" | "failed";
export type FleetMergeReadiness = "ready" | "not_ready";

export interface FleetVerificationTestimony {
  command: string;
  result: "pass" | "fail" | "not_run";
  evidence: string;
}

export interface FleetTaskCompletionReport {
  schemaVersion: typeof FLEET_REPORT_SCHEMA_VERSION;
  runId: string;
  taskId: string;
  workerId: string;
  attempt: number;
  spawnRequestId: string;
  baseSha: string;
  headSha: string;
  submittedAt: string;
  status: FleetReportStatus;
  summary: string;
  filesChanged: string[];
  verification: FleetVerificationTestimony[];
  risks: string[];
  followUps: string[];
  mergeReadiness: FleetMergeReadiness;
  markdown: string;
}

export interface ExpectedFleetReportIdentity {
  runId: string;
  taskId: string;
  workerId: string;
  attempt: number;
  spawnRequestId: string;
  /** SHA-256 of the nonce delivered once to the assigned worker. */
  nonceHash: string;
  baseSha: string;
  /** Earliest accepted submission time for this attempt. */
  spawnedAt: string;
}

export type FleetReportValidationResult =
  | { ok: true; report: FleetTaskCompletionReport }
  | { ok: false; error: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(
  value: unknown,
  field: string,
  max: number,
  allowEmpty = false
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: `${field} must be a string` };
  }
  const trimmed = value.trim();
  if ((!trimmed && !allowEmpty) || value.length > max) {
    return { ok: false, error: `${field} is empty or exceeds its limit` };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    return { ok: false, error: `${field} contains control characters` };
  }
  return { ok: true, value: trimmed };
}

function identifier(value: unknown, field: string) {
  return boundedString(value, field, ID_MAX);
}

function stringList(
  value: unknown,
  field: string
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > LIST_MAX) {
    return { ok: false, error: `${field} must be a bounded array` };
  }
  const result: string[] = [];
  for (const item of value) {
    const parsed = boundedString(item, `${field} entry`, LIST_ENTRY_MAX, true);
    if (!parsed.ok) return parsed;
    result.push(parsed.value);
  }
  return { ok: true, value: result };
}

/** A normalized repository-relative path, using forward slashes on every OS. */
export function normalizeFleetReportPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > PATH_MAX ||
    /[\u0000-\u001f\u007f]/.test(trimmed) ||
    trimmed.includes(":") ||
    isAbsolute(trimmed) ||
    win32.isAbsolute(trimmed) ||
    /^[A-Za-z]:/.test(trimmed)
  ) {
    return null;
  }
  const withForwardSlashes = trimmed.replace(/\\/g, "/");
  const segments = withForwardSlashes.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  const normalized = posix.normalize(withForwardSlashes);
  return normalized === "." || normalized.startsWith("../") ? null : normalized;
}

function changedPaths(
  value: unknown
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > LIST_MAX) {
    return { ok: false, error: "filesChanged must be a bounded array" };
  }
  const paths: string[] = [];
  for (const item of value) {
    const normalized = normalizeFleetReportPath(item);
    if (!normalized) {
      return { ok: false, error: "filesChanged contains an unsafe path" };
    }
    paths.push(normalized);
  }
  if (new Set(paths).size !== paths.length) {
    return { ok: false, error: "filesChanged contains duplicate paths" };
  }
  return { ok: true, value: paths.sort() };
}

function verificationRows(
  value: unknown
):
  | { ok: true; value: FleetVerificationTestimony[] }
  | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > 40) {
    return { ok: false, error: "verification must be a bounded array" };
  }
  const rows: FleetVerificationTestimony[] = [];
  for (const item of value) {
    const input = record(item);
    if (!input) return { ok: false, error: "verification row is malformed" };
    const command = boundedString(input.command, "verification command", 500);
    const evidence = boundedString(
      input.evidence,
      "verification evidence",
      LIST_ENTRY_MAX,
      true
    );
    if (!command.ok) return command;
    if (!evidence.ok) return evidence;
    if (!["pass", "fail", "not_run"].includes(String(input.result))) {
      return { ok: false, error: "verification result is invalid" };
    }
    rows.push({
      command: command.value,
      result: input.result as FleetVerificationTestimony["result"],
      evidence: evidence.value,
    });
  }
  return { ok: true, value: rows };
}

function exact(
  actual: unknown,
  expected: string | number,
  field: string
): { ok: true } | { ok: false; error: string } {
  return actual === expected
    ? { ok: true }
    : { ok: false, error: `${field} does not match this Fleet attempt` };
}

export function hashFleetReportNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

function nonceMatches(value: unknown, expectedHash: string): boolean {
  const validNonce = typeof value === "string" && NONCE.test(value);
  const validHash = SHA256.test(expectedHash);
  const actual = Buffer.from(
    hashFleetReportNonce(validNonce ? value : "invalid-fleet-report-nonce"),
    "hex"
  );
  const expected = validHash
    ? Buffer.from(expectedHash, "hex")
    : Buffer.alloc(32);
  const matches = timingSafeEqual(actual, expected);
  return validNonce && validHash && matches;
}

export function parseFleetTaskCompletionReport(
  jsonText: string,
  expected: ExpectedFleetReportIdentity,
  nowMs = Date.now()
): FleetReportValidationResult {
  if (Buffer.byteLength(jsonText, "utf8") > FLEET_REPORT_MAX_BYTES) {
    return { ok: false, error: "fleet report exceeds its safety limit" };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: "fleet report is not valid JSON" };
  }
  const input = record(decoded);
  if (!input) return { ok: false, error: "fleet report must be an object" };
  if (input.schemaVersion !== FLEET_REPORT_SCHEMA_VERSION) {
    return { ok: false, error: "fleet report schema version is unsupported" };
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    return { ok: false, error: "fleet report validation time is invalid" };
  }

  for (const [field, value] of [
    ["runId", expected.runId],
    ["taskId", expected.taskId],
    ["workerId", expected.workerId],
    ["attempt", expected.attempt],
    ["spawnRequestId", expected.spawnRequestId],
    ["baseSha", expected.baseSha],
  ] as const) {
    const match = exact(input[field], value, field);
    if (!match.ok) return match;
  }
  if (!nonceMatches(input.nonce, expected.nonceHash)) {
    return {
      ok: false,
      error: "nonce does not match this Fleet attempt",
    };
  }
  if (!SHA.test(expected.baseSha) || !SHA.test(String(input.headSha ?? ""))) {
    return { ok: false, error: "fleet report contains an invalid Git SHA" };
  }

  const spawnedAtMs = Date.parse(expected.spawnedAt);
  const submittedAtMs = Date.parse(String(input.submittedAt ?? ""));
  if (!Number.isFinite(spawnedAtMs) || !Number.isFinite(submittedAtMs)) {
    return { ok: false, error: "fleet report timestamp is invalid" };
  }
  if (
    submittedAtMs < spawnedAtMs ||
    submittedAtMs > nowMs + FLEET_REPORT_FUTURE_SKEW_MS
  ) {
    return {
      ok: false,
      error: "fleet report timestamp is outside this attempt",
    };
  }
  if (nowMs - submittedAtMs > FLEET_REPORT_MAX_AGE_MS) {
    return { ok: false, error: "fleet report is stale" };
  }

  if (!["succeeded", "blocked", "failed"].includes(String(input.status))) {
    return { ok: false, error: "fleet report status is invalid" };
  }
  if (!["ready", "not_ready"].includes(String(input.mergeReadiness))) {
    return { ok: false, error: "fleet report mergeReadiness is invalid" };
  }
  if (input.status !== "succeeded" && input.mergeReadiness === "ready") {
    return {
      ok: false,
      error: "only a succeeded report may claim merge readiness",
    };
  }

  const summary = boundedString(input.summary, "summary", SUMMARY_MAX);
  const markdown = boundedString(input.markdown, "markdown", BODY_MAX, true);
  const files = changedPaths(input.filesChanged);
  const verification = verificationRows(input.verification);
  const risks = stringList(input.risks, "risks");
  const followUps = stringList(input.followUps, "followUps");
  if (!summary.ok) return summary;
  if (!markdown.ok) return markdown;
  if (!files.ok) return files;
  if (!verification.ok) return verification;
  if (!risks.ok) return risks;
  if (!followUps.ok) return followUps;

  return {
    ok: true,
    report: {
      schemaVersion: FLEET_REPORT_SCHEMA_VERSION,
      runId: expected.runId,
      taskId: expected.taskId,
      workerId: expected.workerId,
      attempt: expected.attempt,
      spawnRequestId: expected.spawnRequestId,
      baseSha: expected.baseSha,
      headSha: String(input.headSha),
      submittedAt: new Date(submittedAtMs).toISOString(),
      status: input.status as FleetReportStatus,
      summary: summary.value,
      filesChanged: files.value,
      verification: verification.value,
      risks: risks.value,
      followUps: followUps.value,
      mergeReadiness: input.mergeReadiness as FleetMergeReadiness,
      markdown: markdown.value,
    },
  };
}

export async function readFleetTaskCompletionReport(
  filePath: string,
  expected: ExpectedFleetReportIdentity,
  nowMs = Date.now()
): Promise<FleetReportValidationResult> {
  const read = await readBoundedRegularFile(
    filePath,
    FLEET_REPORT_MAX_BYTES,
    "fleet completion report"
  );
  return read.ok
    ? parseFleetTaskCompletionReport(read.text, expected, nowMs)
    : { ok: false, error: read.error };
}
