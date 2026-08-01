import { createHash, randomBytes } from "crypto";
import { lstat, mkdir } from "fs/promises";
import { join } from "path";
import { runGit } from "@/lib/git";
import { expandHome, homeDir } from "@/lib/platform";
import {
  readBoundedRegularFile,
  type FleetArtifactReadResult,
} from "./artifacts";
import {
  collectFleetGitState,
  compareFleetPathClaims,
  type FleetClaimDriftResult,
  type FleetGitState,
} from "./git-state";
import {
  FLEET_REPORT_MAX_BYTES,
  hashFleetReportNonce,
  parseFleetTaskCompletionReport,
  type ExpectedFleetReportIdentity,
  type FleetTaskCompletionReport,
} from "./report";

const FLEET_REPORT_NONCE_BYTES = 32;
const FLEET_REPORT_POLL_MIN_MS = 1_000;
const FLEET_REPORT_POLL_MAX_MS = 30_000;
const FLEET_REPORT_GIT_MAX_BYTES = 2 * 1024 * 1024;
const FLEET_REPORT_GIT_MAX_PATHS = 500;
export const FLEET_RUNTIME_ARTIFACT_MAX_BYTES = 1024 * 1024;

const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_PATH_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

export interface FleetWorkerAttemptContract {
  attemptDirectory: string;
  reportPath: string;
  /** Ephemeral: deliver to the worker, but never persist it. */
  nonce: string;
  nonceHash: string;
  baseSha: string;
}

export interface PrepareFleetWorkerAttemptInput {
  runId: string;
  taskId: string;
  attempt: number;
  workingDirectory: string;
  baseRef: string;
}

export interface FleetWorkerReportCollectionInput {
  reportPath: string;
  worktreePath: string;
  expected: ExpectedFleetReportIdentity;
  plannedClaims: string[];
  allowSensitivePaths: boolean;
  nowMs?: number;
}

export type FleetWorkerReportCollectionResult =
  | {
      kind: "missing";
    }
  | {
      kind: "invalid";
      error: string;
      gitState: FleetGitState | null;
      reportBytes: number;
    }
  | {
      kind: "collected";
      report: FleetTaskCompletionReport;
      gitState: FleetGitState;
      claimDrift: FleetClaimDriftResult;
      taskStatus:
        | "completed"
        | "verifying"
        | "blocked"
        | "failed"
        | "needs_followup"
        | "needs_inspection";
      failureCode: string | null;
      reportBytes: number;
    };

export interface FleetWorkerReportRuntimeDeps {
  readArtifact: (
    filePath: string,
    maxBytes: number,
    label?: string
  ) => Promise<FleetArtifactReadResult>;
  collectGitState: typeof collectFleetGitState;
}

function safePathComponent(value: string, label: string): string {
  if (!SAFE_PATH_COMPONENT.test(value) || value === "." || value === "..") {
    throw new Error(`${label} is not safe for a Fleet-owned artifact path`);
  }
  return value;
}

function safeBaseRef(value: string): string {
  const ref = value.trim();
  if (
    (!FULL_GIT_SHA.test(ref.toLowerCase()) && !SAFE_GIT_REF.test(ref)) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    ref.endsWith("/") ||
    ref.endsWith(".lock")
  ) {
    throw new Error("Fleet base branch is not a safe Git ref");
  }
  return ref;
}

async function resolveBaseSha(
  workingDirectory: string,
  baseRef: string
): Promise<string> {
  const cwd = expandHome(workingDirectory);
  const ref = safeBaseRef(baseRef);
  const { stdout } = await runGit(
    cwd,
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    15_000,
    4 * 1024
  );
  const sha = stdout.trim().toLowerCase();
  if (!FULL_GIT_SHA.test(sha)) {
    throw new Error("Fleet base branch did not resolve to a full commit ID");
  }
  return sha;
}

/**
 * Prepare a unique, Fleet-owned report destination before the worker starts.
 * Only nonceHash belongs in durable storage; nonce is deliberately ephemeral.
 */
export async function prepareFleetWorkerAttempt(
  input: PrepareFleetWorkerAttemptInput
): Promise<FleetWorkerAttemptContract> {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("Fleet attempt must be a positive integer");
  }
  const runId = safePathComponent(input.runId, "runId");
  const taskId = safePathComponent(input.taskId, "taskId");
  const baseSha = await resolveBaseSha(input.workingDirectory, input.baseRef);
  const attemptDirectory = join(
    homeDir(),
    ".stoa",
    "fleet",
    runId,
    taskId,
    String(input.attempt)
  );
  const reportPath = join(attemptDirectory, "report.json");
  await mkdir(attemptDirectory, { recursive: true });
  try {
    await lstat(reportPath);
    throw new Error("Fleet report destination already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const nonce = randomBytes(FLEET_REPORT_NONCE_BYTES).toString("base64url");
  return {
    attemptDirectory,
    reportPath,
    nonce,
    nonceHash: hashFleetReportNonce(nonce),
    baseSha,
  };
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function evaluateCollectedReport(input: {
  report: FleetTaskCompletionReport;
  gitState: FleetGitState;
  plannedClaims: string[];
  allowSensitivePaths: boolean;
}): Omit<
  Extract<FleetWorkerReportCollectionResult, { kind: "collected" }>,
  "kind" | "report" | "gitState" | "reportBytes"
> {
  const claimDrift = compareFleetPathClaims(
    input.plannedClaims,
    input.gitState.allTouchedPaths
  );
  const dirty =
    input.gitState.stagedChanges.length > 0 ||
    input.gitState.unstagedChanges.length > 0 ||
    input.gitState.untrackedPaths.length > 0;
  if (dirty) {
    return {
      claimDrift,
      taskStatus: "needs_inspection",
      failureCode: "dirty_worktree",
    };
  }
  if (!samePaths(input.report.filesChanged, input.gitState.committedPaths)) {
    return {
      claimDrift,
      taskStatus: "needs_inspection",
      failureCode: "report_git_mismatch",
    };
  }
  if (claimDrift.hasDrift) {
    return {
      claimDrift,
      taskStatus: "needs_inspection",
      failureCode: "claim_drift",
    };
  }
  if (claimDrift.sensitivePaths.length > 0 && !input.allowSensitivePaths) {
    return {
      claimDrift,
      taskStatus: "needs_inspection",
      failureCode: "sensitive_path_requires_review",
    };
  }
  if (input.report.status === "blocked") {
    return {
      claimDrift,
      taskStatus: "blocked",
      failureCode: "worker_report_blocked",
    };
  }
  if (input.report.status === "failed") {
    return {
      claimDrift,
      taskStatus: "failed",
      failureCode: "worker_report_failed",
    };
  }
  if (input.report.mergeReadiness !== "ready") {
    return {
      claimDrift,
      taskStatus: "needs_followup",
      failureCode: "worker_report_not_ready",
    };
  }

  const readOnly = input.plannedClaims.length === 0;
  if (readOnly) {
    return {
      claimDrift,
      taskStatus: "completed",
      failureCode: null,
    };
  }
  if (
    input.gitState.headSha === input.gitState.baseSha ||
    input.gitState.committedChanges.length === 0
  ) {
    return {
      claimDrift,
      taskStatus: "needs_inspection",
      failureCode: "no_committed_changes",
    };
  }
  return { claimDrift, taskStatus: "verifying", failureCode: null };
}

/** Read, authenticate, and independently corroborate a worker report. */
export async function collectFleetWorkerReport(
  input: FleetWorkerReportCollectionInput,
  overrides: Partial<FleetWorkerReportRuntimeDeps> = {}
): Promise<FleetWorkerReportCollectionResult> {
  const readArtifact = overrides.readArtifact ?? readBoundedRegularFile;
  const collectGitState = overrides.collectGitState ?? collectFleetGitState;
  const read = await readArtifact(
    input.reportPath,
    FLEET_REPORT_MAX_BYTES,
    "fleet completion report"
  );
  if (!read.ok && read.missing) return { kind: "missing" };

  const collectActual = async (expectedHeadSha?: string) =>
    collectGitState({
      cwd: input.worktreePath,
      baseSha: input.expected.baseSha,
      ...(expectedHeadSha ? { expectedHeadSha } : {}),
      limits: {
        maxGitOutputBytes: FLEET_REPORT_GIT_MAX_BYTES,
        maxPaths: FLEET_REPORT_GIT_MAX_PATHS,
        summaryPaths: 100,
      },
    });

  if (!read.ok) {
    let gitState: FleetGitState | null = null;
    try {
      gitState = await collectActual();
    } catch {
      gitState = null;
    }
    return { kind: "invalid", error: read.error, gitState, reportBytes: 0 };
  }

  const parsed = parseFleetTaskCompletionReport(
    read.text,
    input.expected,
    input.nowMs ?? Date.now()
  );
  if (!parsed.ok) {
    let gitState: FleetGitState | null = null;
    try {
      gitState = await collectActual();
    } catch {
      gitState = null;
    }
    return {
      kind: "invalid",
      error: parsed.error,
      gitState,
      reportBytes: read.bytes,
    };
  }

  let gitState: FleetGitState;
  try {
    gitState = await collectActual(parsed.report.headSha);
  } catch (error) {
    return {
      kind: "invalid",
      error:
        error instanceof Error
          ? `authoritative Git collection failed: ${error.message}`
          : "authoritative Git collection failed",
      gitState: null,
      reportBytes: read.bytes,
    };
  }
  return {
    kind: "collected",
    report: parsed.report,
    gitState,
    reportBytes: read.bytes,
    ...evaluateCollectedReport({
      report: parsed.report,
      gitState,
      plannedClaims: input.plannedClaims,
      allowSensitivePaths: input.allowSensitivePaths,
    }),
  };
}

export function nextFleetReportPollAt(
  pollCount: number,
  nowMs: number
): string {
  const count =
    Number.isSafeInteger(pollCount) && pollCount >= 0 ? pollCount : 0;
  const delay = Math.min(
    FLEET_REPORT_POLL_MAX_MS,
    FLEET_REPORT_POLL_MIN_MS * 2 ** Math.min(count, 10)
  );
  return new Date(nowMs + delay).toISOString();
}

export function fleetArtifactContentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function boundedFleetArtifactJson(value: unknown): {
  body: string;
  bytes: number;
  contentHash: string;
} {
  const body = JSON.stringify(value);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > FLEET_RUNTIME_ARTIFACT_MAX_BYTES) {
    throw new Error("Fleet runtime artifact exceeds its safety limit");
  }
  return { body, bytes, contentHash: fleetArtifactContentHash(body) };
}
