import { createHash, randomBytes, randomUUID } from "crypto";
import { constants } from "fs";
import { lstat, mkdir, open, rmdir, unlink } from "fs/promises";
import { dirname, join, posix, resolve, win32 } from "path";
import type Database from "better-sqlite3";
import { getDb, queries, type Session } from "@/lib/db";
import type { Project } from "@/lib/db/types";
import type { DispatchRepo } from "@/lib/dispatch/types";
import {
  getDefaultBranch,
  isGitRepo,
  resolveGitCommit,
} from "@/lib/git-status";
import { generateBranchName, runGit } from "@/lib/git";
import { spawnWorker, WorkerSpawnError } from "@/lib/orchestration";
import { isWindows, stoaHomeDir } from "@/lib/platform";
import {
  backendKeyForSession,
  type ProviderId,
} from "@/lib/providers/registry";
import { detectAgentBinaries } from "@/lib/readiness-server";
import { getSessionBackend } from "@/lib/session-backend";
import type { ApprovalMode } from "@/lib/sandbox/types";
import { deleteWorktree } from "@/lib/worktrees";
import {
  FLEET_DEFAULT_PARALLEL_WORKERS,
  FLEET_MAX_TOTAL_WORKERS,
  providerConcurrencyCap,
} from "./admission";
import { allocateFleetAgents } from "./allocation";
import { getFleetRunDetail, ingestGeneratedFleetRunPlan } from "./service";
import { stopFleetSession } from "./stop";
import { parseFleetAutomationPolicy } from "./automation-policy";
import {
  activateFleetPaidSession,
  finishFleetPaidSession,
  reserveFleetPaidSession,
} from "./session-admission";
import { hashFleetAutomationPolicy } from "./hash";
import { fleetAgentApprovalMode } from "./confinement";
import type { FleetRunDetailDto, FleetRunRow } from "./types";
import {
  buildFleetPlannerPrompt,
  fleetPlannerPlanText,
  normalizeFleetPlannerTaskCap,
  parseFleetPlannerResult,
} from "./planner-plan";
import { redactAndCapFleetText } from "./redaction";
import { fleetProviderRetryIsDue } from "./backoff";
import { decideFleetAuxiliaryLaunchRetry } from "./auxiliary-retry";
import { clearFleetProviderCooldown } from "./resource-runtime";
import { fleetLaunchBlockedResult } from "./recovery-gate";
import {
  filterFleetUnattendedProviders,
  isFleetUnattendedProvider,
  type FleetUnattendedProviderId,
} from "./provider-eligibility";

const FLEET_PLAN_FILE_MAX_BYTES = 128 * 1024;
const FLEET_PLANNER_TIMEOUT_MS = 15 * 60 * 1000;
const FLEET_PLANNER_NONCE_BYTES = 32;
const FLEET_MAX_CONCURRENT_PLANNERS = 4;
const FLEET_MAX_CONCURRENT_PLANNERS_PER_PROVIDER = 2;
const ACTIVE_PLANNER_STATES = ["starting", "running", "finalizing"] as const;
const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_PATH_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isActivePlannerState(value: string | undefined): boolean {
  return ACTIVE_PLANNER_STATES.some((state) => state === value);
}

function consumesPlannerCapacity(value: string | undefined): boolean {
  return isActivePlannerState(value) || value === "cleanup_pending";
}

interface PlannerSettings {
  state?: string;
  requestId?: string;
  attempt?: number;
  baseSha?: string;
  resultPath?: string;
  nonceHash?: string;
  sessionId?: string;
  worktreePath?: string;
  projectPath?: string;
  branchName?: string;
  taskCap?: number;
  provider?: string;
  error?: string;
  startedAt?: string;
  finalState?: "ready" | "failed" | "idle";
  /** Consecutive transient launch failures; cleared once a launch succeeds. */
  failureCount?: number;
  /** Durable restart-safe launch deadline. */
  retryNotBefore?: string;
  /** The spawn promise rejected, so absence of external identity is definite. */
  launchSettled?: boolean;
  /** External identity exists but Fleet could not prove that it owns it. */
  ambiguousOwnership?: boolean;
}

interface PlannerAuditEvent {
  type: string;
  actor: string;
  payload: unknown;
}

function plannerTransaction<T>(db: Database.Database, callback: () => T): T {
  if (db.inTransaction) {
    const savepoint = "fleet_planner_nested";
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = callback();
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
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

function plannerError(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return redactAndCapFleetText(value, 1_000).text;
}

function sanitizedPlannerSettings(planner: PlannerSettings): PlannerSettings {
  return { ...planner, error: plannerError(planner.error) };
}

interface PlannerResultContract {
  attemptDirectory: string;
  resultPath: string;
  nonce: string;
  nonceHash: string;
}

function safePlannerPathComponent(value: string, label: string): string {
  if (!SAFE_PATH_COMPONENT.test(value) || value === "." || value === "..") {
    throw new Error(`${label} is not safe for a Fleet planner result path`);
  }
  return value;
}

/** The sole external result path Fleet owns for one exact planner request. */
export function fleetPlannerResultPath(
  input: {
    runId: string;
    requestId: string;
  },
  stoaHome = stoaHomeDir()
): string {
  const runId = safePlannerPathComponent(input.runId, "runId");
  const requestId = safePlannerPathComponent(input.requestId, "requestId");
  const pathApi = win32.isAbsolute(stoaHome)
    ? win32
    : posix.isAbsolute(stoaHome)
      ? posix
      : { join };
  return pathApi.join(
    stoaHome,
    "fleet",
    runId,
    "planner",
    requestId,
    "result.json"
  );
}

function isFleetOwnedPlannerResultPath(input: {
  runId: string;
  requestId: string;
  resultPath: string;
}): boolean {
  let expected: string;
  try {
    expected = fleetPlannerResultPath(input);
  } catch {
    return false;
  }
  const actualPath = resolve(input.resultPath);
  const expectedPath = resolve(expected);
  return isWindows
    ? actualPath.toLowerCase() === expectedPath.toLowerCase()
    : actualPath === expectedPath;
}

async function preparePlannerResultContract(input: {
  runId: string;
  requestId: string;
}): Promise<PlannerResultContract> {
  const resultPath = fleetPlannerResultPath(input);
  const attemptDirectory = dirname(resultPath);
  await mkdir(attemptDirectory, { recursive: true });
  try {
    await lstat(resultPath);
    throw new Error("Fleet planner result destination already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const nonce = randomBytes(FLEET_PLANNER_NONCE_BYTES).toString("base64url");
  return {
    attemptDirectory,
    resultPath,
    nonce,
    nonceHash: createHash("sha256").update(nonce, "utf8").digest("hex"),
  };
}

async function discardUnclaimedPlannerResultDirectory(
  contract: PlannerResultContract
): Promise<void> {
  await rmdir(contract.attemptDirectory).catch(() => undefined);
}

async function deletePlannerResult(
  runId: string,
  planner: PlannerSettings
): Promise<boolean> {
  // Pre-provenance planners never had an external artifact. Their worktree is
  // still safe to stop and reclaim; active recovery rejects the missing
  // contract before it can ingest any result.
  if (!planner.resultPath) return true;
  if (
    !planner.requestId ||
    !isFleetOwnedPlannerResultPath({
      runId,
      requestId: planner.requestId,
      resultPath: planner.resultPath,
    })
  ) {
    return false;
  }
  try {
    await unlink(planner.resultPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  await rmdir(dirname(planner.resultPath)).catch(() => undefined);
  return true;
}

function exactGitSha(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return FULL_GIT_SHA.test(normalized) ? normalized : null;
}

function durablePlannerContractError(
  run: FleetRunRow,
  planner: PlannerSettings
): string | null {
  const runBaseSha = exactGitSha(run.automation_base_sha);
  const plannerBaseSha = exactGitSha(planner.baseSha);
  if (!runBaseSha || !plannerBaseSha || runBaseSha !== plannerBaseSha) {
    return "planner exact base contract does not match the Fleet run";
  }
  if (
    !planner.requestId ||
    !Number.isSafeInteger(planner.attempt) ||
    (planner.attempt ?? 0) < 1 ||
    !planner.resultPath ||
    !isFleetOwnedPlannerResultPath({
      runId: run.id,
      requestId: planner.requestId,
      resultPath: planner.resultPath,
    }) ||
    !SHA256_HEX.test(planner.nonceHash ?? "")
  ) {
    return "planner durable result contract is invalid";
  }
  return null;
}

async function plannerWorkspaceContractError(
  db: Database.Database,
  run: FleetRunRow,
  planner: PlannerSettings,
  spawnedSession?: Session
): Promise<string | null> {
  const durableError = durablePlannerContractError(run, planner);
  if (durableError) return durableError;
  const expectedBaseSha = exactGitSha(planner.baseSha) as string;
  const session =
    spawnedSession ??
    (planner.sessionId
      ? (queries.getSession(db).get(planner.sessionId) as Session | undefined)
      : undefined);
  if (session && exactGitSha(session.base_branch) !== expectedBaseSha) {
    return "planner session base contract does not match the Fleet run";
  }
  if (!planner.worktreePath) return null;
  try {
    const { stdout } = await runGit(
      planner.worktreePath,
      ["rev-parse", "--verify", "HEAD"],
      10_000,
      4 * 1024
    );
    if (exactGitSha(stdout) !== expectedBaseSha) {
      return "planner worktree HEAD does not match the Fleet run base";
    }
  } catch {
    return "planner worktree base could not be verified";
  }
  return null;
}

export async function readBoundedFleetPlannerFile(
  path: string
): Promise<{ text: string } | { error: string; missing?: boolean }> {
  const noFollow =
    typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonBlock =
    typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  let handle;
  try {
    const pathInfo = await lstat(path);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
      return { error: "planner result is not a regular file" };
    }
    handle = await open(path, constants.O_RDONLY | noFollow | nonBlock);
    const info = await handle.stat();
    if (
      !info.isFile() ||
      (pathInfo.ino !== 0 &&
        info.ino !== 0 &&
        (pathInfo.dev !== info.dev || pathInfo.ino !== info.ino))
    ) {
      return { error: "planner result changed before it could be read" };
    }
    const buffer = Buffer.alloc(FLEET_PLAN_FILE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > FLEET_PLAN_FILE_MAX_BYTES) {
      return { error: "planner result exceeds the 128 KiB safety limit" };
    }
    return { text: buffer.subarray(0, bytesRead).toString("utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { error: "planner has not written its result", missing: true };
    }
    return { error: "planner result could not be read safely" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseSettings(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function plannerSettings(run: FleetRunRow): PlannerSettings {
  const planner = parseSettings(run.settings_json).planner;
  return planner && typeof planner === "object"
    ? (planner as PlannerSettings)
    : {};
}

function plannerProviderBinding(
  db: Database.Database,
  run: FleetRunRow,
  planner: PlannerSettings
):
  | {
      provider: FleetUnattendedProviderId;
      session: Session | undefined;
      error?: undefined;
    }
  | { error: string; provider?: undefined; session?: undefined } {
  const session = planner.sessionId
    ? (queries.getSession(db).get(planner.sessionId) as Session | undefined)
    : undefined;
  const recoveredProvider = session?.agent_type?.trim() ?? "";
  const persistedProvider = planner.provider?.trim();
  const selectedProvider =
    persistedProvider || recoveredProvider || run.provider;
  if (
    !isFleetUnattendedProvider(selectedProvider) ||
    (session &&
      (!isFleetUnattendedProvider(recoveredProvider) ||
        recoveredProvider !== selectedProvider))
  ) {
    return { error: "persisted Fleet planner provider cannot run unattended" };
  }
  return { provider: selectedProvider, session };
}

function plannerSessionWasActivated(
  db: Database.Database,
  runId: string,
  requestId: string
): boolean {
  const account = db
    .prepare(
      `SELECT session_id FROM fleet_cost_accounts
       WHERE fleet_run_id = ? AND owner_type = 'planner' AND owner_id = ?`
    )
    .get(runId, requestId) as { session_id: string | null } | undefined;
  return Boolean(account?.session_id);
}

function availableProviders(): ProviderId[] {
  const found = detectAgentBinaries();
  return filterFleetUnattendedProviders(
    (Object.keys(found) as Array<keyof typeof found>).filter(
      (provider) => found[provider]
    )
  );
}

function targetForRun(run: FleetRunRow): {
  workingDirectory: string;
  baseBranch: string;
} | null {
  const db = getDb();
  if (run.repo_id) {
    const repo = queries.getDispatchRepo(db).get(run.repo_id) as
      DispatchRepo | undefined;
    if (repo?.repo_path) {
      return {
        workingDirectory: repo.repo_path,
        baseBranch: repo.base_branch ?? "main",
      };
    }
  }
  if (run.project_id) {
    const project = queries.getProject(db).get(run.project_id) as
      Project | undefined;
    if (project?.working_directory) {
      return {
        workingDirectory: project.working_directory,
        baseBranch: getDefaultBranch(project.working_directory),
      };
    }
  }
  return null;
}

function writePlannerState(
  runId: string,
  requestId: string,
  planner: PlannerSettings,
  eventType?: string,
  expectedStates?: readonly string[],
  additionalEvents: readonly PlannerAuditEvent[] = []
): boolean {
  const db = getDb();
  const safePlanner = sanitizedPlannerSettings(planner);
  return plannerTransaction(db, () => {
    const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
    const currentPlanner = run ? plannerSettings(run) : {};
    if (
      !run ||
      currentPlanner.requestId !== requestId ||
      (expectedStates && !expectedStates.includes(currentPlanner.state ?? ""))
    )
      return false;
    const settings = parseSettings(run.settings_json);
    settings.planner = safePlanner;
    settings.phase = ["failed", "idle"].includes(safePlanner.state ?? "")
      ? "draft"
      : safePlanner.state === "ready"
        ? "plan_review"
        : "planning";
    settings.canSpawnWorkers = false;
    const changed = db
      .prepare(
        `UPDATE fleet_runs SET settings_json = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'draft' AND approval_state IN ('draft', 'needs_approval')
         AND settings_json = ?`
      )
      .run(JSON.stringify(settings), runId, run.settings_json);
    if (changed.changes !== 1) return false;
    if (eventType) {
      queries
        .createFleetEvent(db)
        .run(runId, eventType, "planner", JSON.stringify(safePlanner));
    }
    for (const auditEvent of additionalEvents) {
      queries
        .createFleetEvent(db)
        .run(
          runId,
          auditEvent.type,
          redactAndCapFleetText(auditEvent.actor, 80).text,
          JSON.stringify(auditEvent.payload)
        );
    }
    return true;
  });
}

function queuePlannerTerminal(
  runId: string,
  planner: PlannerSettings,
  finalState: "failed" | "idle",
  error?: string,
  additionalEvents: readonly PlannerAuditEvent[] = []
): boolean {
  if (!planner.requestId) return false;
  return writePlannerState(
    runId,
    planner.requestId,
    {
      ...planner,
      state: "cleanup_pending",
      finalState,
      error: plannerError(error),
    },
    finalState === "failed"
      ? "planner_failed"
      : planner.retryNotBefore
        ? "planner_retry_scheduled"
        : "planner_canceled",
    [...ACTIVE_PLANNER_STATES],
    additionalEvents
  );
}

function plannerAdmissionAvailable(provider: string, db = getDb()): boolean {
  const rows = db
    .prepare(
      `SELECT settings_json FROM fleet_runs
       WHERE status = 'draft' AND json_valid(settings_json)`
    )
    .all() as Array<{ settings_json: string }>;
  const active = rows
    .map((row) =>
      plannerSettings({ settings_json: row.settings_json } as FleetRunRow)
    )
    .filter((planner) => consumesPlannerCapacity(planner.state));
  const activeWorkerStatuses = [
    "leasing",
    "spawning",
    "running",
    "waiting_for_operator",
    "cleanup_pending",
  ];
  const placeholders = activeWorkerStatuses.map(() => "?").join(",");
  const workers = db
    .prepare(
      `SELECT COUNT(*) AS total,
       SUM(CASE WHEN provider = ? THEN 1 ELSE 0 END) AS provider_total
       FROM fleet_workers WHERE status IN (${placeholders})`
    )
    .get(provider, ...activeWorkerStatuses) as {
    total: number;
    provider_total: number | null;
  };
  const sharedActive = active.length + workers.total;
  const providerActive =
    active.filter((planner) => planner.provider === provider).length +
    (workers.provider_total ?? 0);
  return (
    active.length < FLEET_MAX_CONCURRENT_PLANNERS &&
    sharedActive < FLEET_DEFAULT_PARALLEL_WORKERS &&
    sharedActive < FLEET_MAX_TOTAL_WORKERS &&
    active.filter((planner) => planner.provider === provider).length <
      FLEET_MAX_CONCURRENT_PLANNERS_PER_PROVIDER &&
    providerActive < providerConcurrencyCap(provider)
  );
}

export async function startFleetPlanner(
  runId: string,
  input: { taskCap?: unknown; provider?: unknown } = {},
  actor: "operator" | "fleet-automation" = "operator"
): Promise<{ run: FleetRunDetailDto } | { error: string; status?: number }> {
  const db = getDb();
  const recoveryBlocked = fleetLaunchBlockedResult(db, runId);
  if (recoveryBlocked) return recoveryBlocked;
  const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
  if (!run) return { error: "Fleet run not found", status: 404 };
  let approvalMode: ApprovalMode = "prompt";
  if (actor === "fleet-automation") {
    const parsed = parseFleetAutomationPolicy(run.automation_policy_json);
    if (
      !parsed.valid ||
      !run.automation_policy_hash ||
      hashFleetAutomationPolicy(parsed.policy) !== run.automation_policy_hash ||
      !parsed.policy.automaticPlanning
    ) {
      return { error: "automatic planning authorization changed", status: 409 };
    }
    const authorization = db
      .prepare(
        `SELECT status FROM fleet_action_authorizations
         WHERE fleet_run_id = ? AND action = 'planning' AND policy_hash = ?`
      )
      .get(run.id, run.automation_policy_hash) as
      { status: string } | undefined;
    if (authorization?.status !== "authorized") {
      return { error: "automatic planning is not authorized", status: 409 };
    }
    approvalMode = fleetAgentApprovalMode(parsed.policy);
    if (approvalMode === "prompt") {
      return {
        error:
          "automatic planning requires explicit unconfined-agent authorization until strong Fleet isolation is available",
        status: 409,
      };
    }
  }
  if (
    run.status !== "draft" ||
    !["draft", "needs_approval"].includes(run.approval_state)
  ) {
    return { error: "run is not available for planning", status: 409 };
  }
  const currentPlanner = plannerSettings(run);
  if (
    ["starting", "running", "finalizing", "cleanup_pending"].includes(
      currentPlanner.state ?? ""
    )
  ) {
    return { error: "a planner is already active or cleaning up", status: 409 };
  }
  const now = new Date();
  if (!fleetProviderRetryIsDue(currentPlanner.retryNotBefore, now)) {
    return {
      error: `planner launch is deferred until ${currentPlanner.retryNotBefore}`,
      status: 429,
    };
  }
  const target = targetForRun(run);
  if (!target || !isGitRepo(target.workingDirectory)) {
    return {
      error: "automatic planning requires an accessible Git repository",
      status: 409,
    };
  }
  const resolvedBaseSha = exactGitSha(
    resolveGitCommit(target.workingDirectory, target.baseBranch)
  );
  if (!resolvedBaseSha) {
    return { error: "failed to resolve the planner base commit", status: 409 };
  }
  const boundBaseSha = exactGitSha(run.automation_base_sha);
  if (run.automation_base_sha != null && boundBaseSha !== resolvedBaseSha) {
    return { error: "Fleet run base commit changed", status: 409 };
  }
  const installed = availableProviders();
  if (installed.length === 0) {
    return { error: "no installed agent provider is available", status: 409 };
  }
  const requestedProvider =
    typeof input.provider === "string" ? input.provider.trim() : "";
  const provider = installed.includes(requestedProvider as ProviderId)
    ? (requestedProvider as ProviderId)
    : installed.includes(run.provider as ProviderId)
      ? (run.provider as ProviderId)
      : installed[0];
  const taskCap = normalizeFleetPlannerTaskCap(input.taskCap);
  const requestId = randomUUID();
  const attempt = Math.max(0, Math.trunc(currentPlanner.attempt ?? 0)) + 1;
  const startedAt = now.toISOString();
  const branchName = generateBranchName(
    `fleet-plan-${run.id.slice(0, 8)}-${requestId.slice(0, 8)}`
  );
  let resultContract: PlannerResultContract;
  try {
    resultContract = await preparePlannerResultContract({
      runId: run.id,
      requestId,
    });
  } catch (error) {
    return {
      error:
        plannerError(
          error instanceof Error
            ? error.message
            : "Fleet planner result destination is unavailable"
        ) ?? "Fleet planner result destination is unavailable",
      status: 409,
    };
  }

  const settings = parseSettings(run.settings_json);
  settings.phase = "planning";
  settings.canSpawnWorkers = false;
  settings.planner = {
    state: "starting",
    requestId,
    attempt,
    baseSha: resolvedBaseSha,
    resultPath: resultContract.resultPath,
    nonceHash: resultContract.nonceHash,
    taskCap,
    provider,
    startedAt,
    projectPath: target.workingDirectory,
    branchName,
    failureCount: Math.max(0, currentPlanner.failureCount ?? 0),
    launchSettled: false,
  };
  let capacityAvailable = false;
  let claimed = false;
  let admissionFailure: "budget" | "resource" | null = null;
  let admissionRetryAt: string | null = null;
  db.exec("BEGIN IMMEDIATE");
  try {
    capacityAvailable = plannerAdmissionAvailable(provider, db);
    if (capacityAvailable) {
      const admission = reserveFleetPaidSession(db, {
        run,
        ownerType: "planner",
        ownerId: requestId,
        taskType: "planning",
        provider,
        model: provider === run.provider ? run.model : null,
        repositoryKey: run.repo_id ?? run.project_id ?? target.workingDirectory,
        now: new Date(startedAt),
        leaseExpiresAt: new Date(
          Date.parse(startedAt) + 2 * 60_000
        ).toISOString(),
      });
      if (!admission.admitted) {
        admissionFailure = admission.reason;
        admissionRetryAt = admission.retryAt;
        capacityAvailable = false;
      }
    }
    if (capacityAvailable) {
      claimed =
        db
          .prepare(
            `UPDATE fleet_runs SET settings_json = ?,
               automation_base_sha = COALESCE(automation_base_sha, ?),
               updated_at = datetime('now')
             WHERE id = ? AND status = 'draft'
               AND approval_state IN ('draft', 'needs_approval')
               AND settings_json = ?
               AND (automation_base_sha IS NULL OR LOWER(automation_base_sha) = ?)`
          )
          .run(
            JSON.stringify(settings),
            resolvedBaseSha,
            runId,
            run.settings_json,
            resolvedBaseSha
          ).changes === 1;
      if (claimed) {
        queries.createFleetEvent(db).run(
          runId,
          "planner_requested",
          actor,
          JSON.stringify({
            requestId,
            attempt,
            baseSha: resolvedBaseSha,
            provider,
            taskCap,
          })
        );
      }
    } else if (admissionRetryAt) {
      const deferredSettings = parseSettings(run.settings_json);
      deferredSettings.phase = "draft";
      deferredSettings.canSpawnWorkers = false;
      deferredSettings.planner = sanitizedPlannerSettings({
        ...currentPlanner,
        state: "idle",
        retryNotBefore: admissionRetryAt,
        error: "planner provider is cooling down",
      });
      const deferred = db
        .prepare(
          `UPDATE fleet_runs SET settings_json = ?, updated_at = ?
           WHERE id = ? AND status = 'draft'
             AND approval_state IN ('draft', 'needs_approval')
             AND settings_json = ?`
        )
        .run(
          JSON.stringify(deferredSettings),
          startedAt,
          runId,
          run.settings_json
        );
      if (deferred.changes === 1) {
        queries
          .createFleetEvent(db)
          .run(
            runId,
            "planner_retry_deferred",
            actor,
            JSON.stringify({ provider, retryNotBefore: admissionRetryAt })
          );
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    await discardUnclaimedPlannerResultDirectory(resultContract);
    throw error;
  }
  if (!capacityAvailable) {
    await discardUnclaimedPlannerResultDirectory(resultContract);
    return admissionFailure === "budget"
      ? { error: "planner budget admission was blocked", status: 409 }
      : { error: "planner capacity is currently full", status: 429 };
  }
  if (!claimed) {
    await discardUnclaimedPlannerResultDirectory(resultContract);
    finishFleetPaidSession(db, {
      runId,
      ownerType: "planner",
      ownerId: requestId,
      sessionCreated: false,
      now: new Date(),
    });
    return { error: "run state changed before planner launch", status: 409 };
  }
  let launchedSession: Session | undefined;
  let spawnReturned = false;
  let costActivated = false;
  let launchContractRejected = false;
  try {
    const promptInput = {
      goal: run.goal,
      baseBranch: target.baseBranch,
      taskCap,
      availableProviders: installed,
      resultPath: resultContract.resultPath,
      runId: run.id,
      requestId,
      attempt,
      baseSha: resolvedBaseSha,
    };
    const prompt = redactAndCapFleetText(
      buildFleetPlannerPrompt({
        ...promptInput,
        nonce: "[redacted ephemeral nonce]",
      }),
      FLEET_PLAN_FILE_MAX_BYTES
    ).text;
    const deliveryPrompt = redactAndCapFleetText(
      buildFleetPlannerPrompt({
        ...promptInput,
        nonce: resultContract.nonce,
      }),
      FLEET_PLAN_FILE_MAX_BYTES
    ).text;
    const session = await spawnWorker({
      conductorSessionId: run.conductor_session_id ?? null,
      task: prompt,
      deliveryTask: deliveryPrompt,
      workingDirectory: target.workingDirectory,
      branchName,
      baseBranch: resolvedBaseSha,
      useWorktree: true,
      requireWorktree: true,
      requireTaskDelivery: true,
      skipSetup: true,
      fleetWritableRoots: [resultContract.attemptDirectory],
      fleetArtifactPaths: [resultContract.resultPath],
      requireStrongIsolation: true,
      approvalMode,
      agentType: provider,
      model: provider === run.provider ? (run.model ?? undefined) : undefined,
    });
    spawnReturned = true;
    launchedSession = session;
    if (!session.worktree_path) {
      throw new Error("planner started without an isolated worktree");
    }
    const claimedRun = queries.getFleetRun(db).get(runId) as
      FleetRunRow | undefined;
    const claimedPlanner = claimedRun ? plannerSettings(claimedRun) : {};
    const contractError = claimedRun
      ? await plannerWorkspaceContractError(
          db,
          claimedRun,
          {
            ...claimedPlanner,
            sessionId: session.id,
            worktreePath: session.worktree_path,
          },
          session
        )
      : "planner Fleet run disappeared before activation";
    if (contractError) {
      launchContractRejected = true;
      throw new Error(contractError);
    }
    costActivated = activateFleetPaidSession(db, {
      runId,
      ownerType: "planner",
      ownerId: requestId,
      session,
      provider,
      model: provider === run.provider ? run.model : null,
      now: new Date(),
    });
    if (!costActivated) {
      throw new Error(
        "planner session is already owned by another Fleet cost account"
      );
    }
    const persisted = writePlannerState(
      runId,
      requestId,
      {
        state: "running",
        requestId,
        attempt,
        baseSha: resolvedBaseSha,
        resultPath: resultContract.resultPath,
        nonceHash: resultContract.nonceHash,
        sessionId: session.id,
        worktreePath: session.worktree_path,
        projectPath: target.workingDirectory,
        branchName: session.branch_name ?? branchName,
        taskCap,
        provider,
        startedAt,
      },
      "planner_started",
      ["starting"]
    );
    if (!persisted) {
      const latest = queries.getFleetRun(db).get(runId) as
        FleetRunRow | undefined;
      const latestPlanner = latest ? plannerSettings(latest) : {};
      if (
        latestPlanner.requestId === requestId &&
        latestPlanner.state === "running" &&
        latestPlanner.sessionId === session.id &&
        latestPlanner.worktreePath === session.worktree_path &&
        exactGitSha(latestPlanner.baseSha) === resolvedBaseSha &&
        latestPlanner.resultPath === resultContract.resultPath
      ) {
        // The reconciler recovered this exact launch while spawnWorker was
        // still finishing backend initialization and task delivery.
      } else if (
        latestPlanner.requestId === requestId &&
        latestPlanner.state === "cleanup_pending"
      ) {
        const hydrated = {
          ...latestPlanner,
          sessionId: session.id,
          worktreePath: session.worktree_path,
          projectPath: target.workingDirectory,
          branchName: session.branch_name ?? branchName,
          attempt,
          baseSha: resolvedBaseSha,
          resultPath: resultContract.resultPath,
          nonceHash: resultContract.nonceHash,
        };
        if (
          writePlannerState(runId, requestId, hydrated, undefined, [
            "cleanup_pending",
          ])
        ) {
          await finalizePlannerCleanup(runId, hydrated);
        }
        return { error: "planner launch was superseded", status: 409 };
      } else {
        await cleanupPlanner(
          runId,
          {
            requestId,
            attempt,
            baseSha: resolvedBaseSha,
            resultPath: resultContract.resultPath,
            nonceHash: resultContract.nonceHash,
            sessionId: session.id,
            worktreePath: session.worktree_path,
            projectPath: target.workingDirectory,
            branchName: session.branch_name ?? branchName,
          },
          "failed"
        );
        return { error: "planner launch was superseded", status: 409 };
      }
    }
    clearFleetProviderCooldown(db, provider);
  } catch (error) {
    const message =
      plannerError(error instanceof Error ? error.message : "planner failed") ??
      "planner failed";
    let failedPlanner = {
      ...plannerSettings(
        (queries.getFleetRun(db).get(runId) as FleetRunRow | undefined) ?? run
      ),
      requestId,
      projectPath: target.workingDirectory,
      branchName,
      sessionId:
        launchedSession?.id ??
        (error instanceof WorkerSpawnError
          ? (error.sessionId ?? undefined)
          : undefined),
      worktreePath:
        launchedSession?.worktree_path ??
        (error instanceof WorkerSpawnError
          ? (error.worktreePath ?? undefined)
          : undefined),
    } satisfies PlannerSettings;
    let ambiguousOwnership =
      spawnReturned && !costActivated && !launchContractRejected;
    if (
      !launchedSession &&
      error instanceof WorkerSpawnError &&
      error.sessionId
    ) {
      const recovered = queries.getSession(db).get(error.sessionId) as
        Session | undefined;
      if (recovered) {
        const activated = activateFleetPaidSession(db, {
          runId,
          ownerType: "planner",
          ownerId: requestId,
          session: recovered,
          provider,
          model: provider === run.provider ? run.model : null,
          now: new Date(),
        });
        if (activated) {
          launchedSession = recovered;
          costActivated = true;
        } else {
          ambiguousOwnership = true;
        }
      } else {
        ambiguousOwnership = true;
      }
    }
    failedPlanner = {
      ...failedPlanner,
      sessionId: launchedSession?.id ?? failedPlanner.sessionId,
      worktreePath:
        launchedSession?.worktree_path ?? failedPlanner.worktreePath,
      ambiguousOwnership,
    };
    if (
      !launchedSession &&
      !(error instanceof WorkerSpawnError && error.worktreePath)
    ) {
      finishFleetPaidSession(db, {
        runId,
        ownerType: "planner",
        ownerId: requestId,
        sessionCreated: false,
        now: new Date(),
      });
    }
    if (ambiguousOwnership) {
      finishFleetPaidSession(db, {
        runId,
        ownerType: "planner",
        ownerId: requestId,
        sessionCreated: false,
        now: new Date(),
      });
      writePlannerState(
        runId,
        requestId,
        {
          ...failedPlanner,
          state: "failed",
          error: message,
          launchSettled: true,
        },
        "planner_failed",
        ["starting"]
      );
      return { error: message, status: 500 };
    }

    const retry = decideFleetAuxiliaryLaunchRetry(db, {
      provider,
      previousFailureCount: failedPlanner.failureCount ?? 0,
      error,
      now: new Date(),
      safeToRetry: !spawnReturned,
    });
    const finalState = retry.retry ? "idle" : "failed";
    const pending = {
      ...failedPlanner,
      state: "cleanup_pending",
      finalState,
      error: message,
      failureCount: retry.failureCount,
      retryNotBefore: retry.retryNotBefore ?? undefined,
      launchSettled: !spawnReturned,
    } satisfies PlannerSettings;
    if (queuePlannerTerminal(runId, pending, finalState, message)) {
      await finalizePlannerCleanup(runId, pending);
    }
    return { error: message, status: 500 };
  }

  const detail = getFleetRunDetail(runId);
  return detail ? { run: detail } : { error: "failed to read fleet run" };
}

async function cleanupPlanner(
  runId: string,
  planner: PlannerSettings,
  finalStatus: "completed" | "failed" = "completed"
): Promise<boolean> {
  const stopped = planner.sessionId
    ? await stopFleetSession(planner.sessionId, finalStatus).catch(() => false)
    : true;
  if (!stopped) return false;
  if (planner.worktreePath && planner.projectPath) {
    try {
      await deleteWorktree(planner.worktreePath, planner.projectPath, false);
    } catch {
      return false;
    }
  }
  if (planner.branchName && planner.projectPath) {
    try {
      await runGit(
        planner.projectPath,
        ["branch", "-D", planner.branchName],
        10_000
      );
    } catch {
      try {
        await runGit(
          planner.projectPath,
          [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/heads/${planner.branchName}`,
          ],
          5_000
        );
        return false;
      } catch (error) {
        const code = (error as { code?: number | string }).code;
        if (code !== 1 && code !== "1") return false;
        // Git exit 1 from show-ref --verify --quiet means the ref is absent.
      }
    }
  }
  return deletePlannerResult(runId, planner);
}

async function finalizePlannerCleanup(
  runId: string,
  planner: PlannerSettings
): Promise<boolean> {
  if (planner.state !== "cleanup_pending" || !planner.requestId) return false;
  const startedAt = Date.parse(planner.startedAt ?? "");
  if (
    !planner.launchSettled &&
    !planner.sessionId &&
    !planner.worktreePath &&
    Number.isFinite(startedAt) &&
    Date.now() - startedAt <= FLEET_PLANNER_TIMEOUT_MS
  ) {
    // A launch may still be between worktree creation and durable identity.
    return false;
  }
  const finalState = planner.finalState ?? "failed";
  const cleaned = await cleanupPlanner(
    runId,
    planner,
    finalState === "ready" ? "completed" : "failed"
  );
  if (!cleaned) return false;
  const db = getDb();
  const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
  const binding = run ? plannerProviderBinding(db, run, planner) : null;
  if (planner.sessionId) {
    if (binding && !binding.error && binding.session && run) {
      activateFleetPaidSession(db, {
        runId,
        ownerType: "planner",
        ownerId: planner.requestId,
        session: binding.session,
        provider: binding.provider,
        model: binding.provider === run.provider ? run.model : null,
        now: new Date(),
      });
    }
  }
  finishFleetPaidSession(db, {
    runId,
    ownerType: "planner",
    ownerId: planner.requestId,
    sessionCreated:
      planner.sessionId != null &&
      (!binding?.error ||
        plannerSessionWasActivated(db, runId, planner.requestId)),
    now: new Date(),
  });
  return writePlannerState(
    runId,
    planner.requestId,
    {
      state: finalState,
      requestId: planner.requestId,
      attempt: planner.attempt,
      baseSha: planner.baseSha,
      provider: planner.provider,
      error: planner.error,
      failureCount: planner.failureCount,
      retryNotBefore: planner.retryNotBefore,
    },
    finalState === "ready" ? "planner_cleanup_complete" : undefined,
    ["cleanup_pending"]
  );
}

async function recoverPlannerIdentity(
  planner: PlannerSettings
): Promise<PlannerSettings> {
  if (!planner.branchName) return planner;
  const db = getDb();
  const recovered = db
    .prepare(
      `SELECT * FROM sessions WHERE branch_name = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(planner.branchName) as Session | undefined;
  if (recovered) {
    return {
      ...planner,
      sessionId: recovered.id,
      worktreePath: recovered.worktree_path ?? planner.worktreePath,
      branchName: recovered.branch_name ?? planner.branchName,
    };
  }
  if (!planner.projectPath) return planner;
  try {
    const { stdout } = await runGit(
      planner.projectPath,
      ["worktree", "list", "--porcelain"],
      10_000
    );
    for (const block of stdout.split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/);
      if (!lines.includes(`branch refs/heads/${planner.branchName}`)) continue;
      const worktree = lines.find((line) => line.startsWith("worktree "));
      if (worktree) {
        return { ...planner, worktreePath: worktree.slice("worktree ".length) };
      }
    }
  } catch {
    // No recoverable git worktree identity yet.
  }
  return planner;
}

async function rejectIneligiblePlannerSession(
  run: FleetRunRow,
  planner: PlannerSettings
): Promise<boolean> {
  const binding = plannerProviderBinding(getDb(), run, planner);
  if (!binding.error) return false;
  const rejected = {
    ...planner,
    error: binding.error,
    launchSettled: true,
  } satisfies PlannerSettings;
  if (queuePlannerTerminal(run.id, rejected, "failed", binding.error)) {
    await finalizePlannerCleanup(run.id, {
      ...rejected,
      state: "cleanup_pending",
      finalState: "failed",
    });
  }
  return true;
}

async function rejectInvalidPlannerContract(
  run: FleetRunRow,
  planner: PlannerSettings
): Promise<boolean> {
  let error = await plannerWorkspaceContractError(getDb(), run, planner);
  if (!error && planner.state !== "starting" && !planner.worktreePath) {
    error = "planner runtime identity is incomplete";
  }
  if (!error) return false;
  const rejected = {
    ...planner,
    error,
    launchSettled: true,
  } satisfies PlannerSettings;
  if (queuePlannerTerminal(run.id, rejected, "failed", error)) {
    await finalizePlannerCleanup(run.id, {
      ...rejected,
      state: "cleanup_pending",
      finalState: "failed",
    });
  }
  return true;
}

export async function cancelFleetPlanner(
  runId: string,
  actor = "operator"
): Promise<{ run: FleetRunDetailDto } | { error: string; status?: number }> {
  const db = getDb();
  const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
  if (!run) return { error: "Fleet run not found", status: 404 };
  let planner = plannerSettings(run);
  if (!planner.requestId || !isActivePlannerState(planner.state)) {
    const detail = getFleetRunDetail(runId);
    return detail ? { run: detail } : { error: "failed to read fleet run" };
  }
  if (planner.state === "starting") {
    const recovered = await recoverPlannerIdentity(planner);
    const providerError = plannerProviderBinding(db, run, recovered).error;
    if (recovered.worktreePath && !providerError) {
      // Only validate when adopting a recovered launch. A legacy starting
      // record with no runtime identity still needs to remain cancelable; it
      // cannot produce an ingestible result, and cleanup has nothing to adopt.
      if (await rejectInvalidPlannerContract(run, recovered)) {
        const detail = getFleetRunDetail(runId);
        return detail ? { run: detail } : { error: "failed to read fleet run" };
      }
      const running = {
        ...recovered,
        state: "running",
        failureCount: undefined,
        retryNotBefore: undefined,
        launchSettled: undefined,
      } satisfies PlannerSettings;
      if (
        !writePlannerState(
          runId,
          recovered.requestId as string,
          running,
          "planner_recovered",
          ["starting"]
        )
      ) {
        const detail = getFleetRunDetail(runId);
        return detail ? { run: detail } : { error: "failed to read fleet run" };
      }
      planner = running;
      if (running.provider) clearFleetProviderCooldown(db, running.provider);
    } else {
      planner = recovered;
    }
  }
  const providerError = plannerProviderBinding(db, run, planner).error;
  if (
    !queuePlannerTerminal(runId, planner, "idle", providerError, [
      {
        type: "planner_cancel_requested",
        actor,
        payload: { requestId: planner.requestId },
      },
    ])
  ) {
    return { error: "planner state changed before cancellation", status: 409 };
  }
  await finalizePlannerCleanup(runId, {
    ...planner,
    state: "cleanup_pending",
    finalState: "idle",
  });
  const detail = getFleetRunDetail(runId);
  return detail ? { run: detail } : { error: "failed to read fleet run" };
}

export async function pollFleetPlanner(
  runId: string
): Promise<{ run: FleetRunDetailDto } | { error: string; status?: number }> {
  const db = getDb();
  const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
  if (!run) return { error: "Fleet run not found", status: 404 };
  let planner = plannerSettings(run);
  if (planner.state === "cleanup_pending") {
    const recovered = await recoverPlannerIdentity(planner);
    if (
      recovered.sessionId !== planner.sessionId ||
      recovered.worktreePath !== planner.worktreePath
    ) {
      writePlannerState(runId, planner.requestId ?? "", recovered, undefined, [
        "cleanup_pending",
      ]);
      planner = recovered;
    }
    await finalizePlannerCleanup(runId, planner);
    const detail = getFleetRunDetail(runId);
    return detail ? { run: detail } : { error: "failed to read fleet run" };
  }
  if (!planner.requestId || !isActivePlannerState(planner.state)) {
    const detail = getFleetRunDetail(runId);
    return detail ? { run: detail } : { error: "failed to read fleet run" };
  }
  if (planner.state === "starting") {
    const recovered = await recoverPlannerIdentity(planner);
    planner = recovered;
    if (await rejectInvalidPlannerContract(run, planner)) {
      const detail = getFleetRunDetail(runId);
      return detail ? { run: detail } : { error: "failed to read fleet run" };
    }
    if (await rejectIneligiblePlannerSession(run, planner)) {
      const detail = getFleetRunDetail(runId);
      return detail ? { run: detail } : { error: "failed to read fleet run" };
    }
    if (recovered.worktreePath) {
      const running = {
        ...recovered,
        state: "running",
        failureCount: undefined,
        retryNotBefore: undefined,
        launchSettled: undefined,
      } satisfies PlannerSettings;
      if (
        !writePlannerState(
          runId,
          recovered.requestId as string,
          running,
          "planner_recovered",
          ["starting"]
        )
      ) {
        const detail = getFleetRunDetail(runId);
        return detail ? { run: detail } : { error: "failed to read fleet run" };
      }
      planner = running;
      if (running.provider) clearFleetProviderCooldown(db, running.provider);
    }
  }
  if (await rejectInvalidPlannerContract(run, planner)) {
    const detail = getFleetRunDetail(runId);
    return detail ? { run: detail } : { error: "failed to read fleet run" };
  }
  if (await rejectIneligiblePlannerSession(run, planner)) {
    const detail = getFleetRunDetail(runId);
    return detail ? { run: detail } : { error: "failed to read fleet run" };
  }
  const plannerRequestId = planner.requestId as string;
  const startedAt = Date.parse(planner.startedAt ?? "");
  if (
    Number.isFinite(startedAt) &&
    Date.now() - startedAt > FLEET_PLANNER_TIMEOUT_MS
  ) {
    if (planner.state === "starting")
      planner = await recoverPlannerIdentity(planner);
    if (
      queuePlannerTerminal(
        runId,
        planner,
        "failed",
        "planner exceeded the 15-minute timeout"
      )
    ) {
      await finalizePlannerCleanup(runId, {
        ...planner,
        state: "cleanup_pending",
        finalState: "failed",
        error: "planner exceeded the 15-minute timeout",
      });
    }
    const detail = getFleetRunDetail(runId);
    return detail ? { run: detail } : { error: "failed to read fleet run" };
  }
  if (planner.state === "starting" || !planner.worktreePath) {
    const detail = getFleetRunDetail(runId);
    return detail ? { run: detail } : { error: "failed to read fleet run" };
  }
  const file = await readBoundedFleetPlannerFile(planner.resultPath as string);
  if (!("text" in file) && file.missing) {
    let alive = true;
    if (planner.sessionId) {
      const session = queries.getSession(db).get(planner.sessionId) as
        Session | undefined;
      alive = session
        ? await getSessionBackend()
            .exists(backendKeyForSession(session))
            .catch(() => true)
        : false;
    }
    if (!alive) {
      const error = "planner exited before producing its authenticated result";
      if (queuePlannerTerminal(runId, planner, "failed", error)) {
        await finalizePlannerCleanup(runId, {
          ...planner,
          state: "cleanup_pending",
          finalState: "failed",
          error,
        });
      }
    }
    const detail = getFleetRunDetail(runId);
    return detail ? { run: detail } : { error: "failed to read fleet run" };
  }
  const parsed =
    "text" in file
      ? parseFleetPlannerResult(
          file.text,
          {
            runId,
            requestId: plannerRequestId,
            attempt: planner.attempt as number,
            baseSha: planner.baseSha as string,
            nonceHash: planner.nonceHash as string,
          },
          planner.taskCap ?? 8
        )
      : ({ ok: false, error: file.error } as const);
  if (!parsed.ok) {
    if (queuePlannerTerminal(runId, planner, "failed", parsed.error)) {
      await finalizePlannerCleanup(runId, {
        ...planner,
        state: "cleanup_pending",
        finalState: "failed",
        error: parsed.error,
      });
    }
    const detail = getFleetRunDetail(runId);
    return detail ? { run: detail } : { error: "failed to read fleet run" };
  }

  const installed = availableProviders();
  const defaultProvider = installed.includes(run.provider as ProviderId)
    ? (run.provider as ProviderId)
    : installed[0];
  if (!defaultProvider) {
    if (
      queuePlannerTerminal(
        runId,
        planner,
        "failed",
        "no installed agent provider is available"
      )
    ) {
      await finalizePlannerCleanup(runId, {
        ...planner,
        state: "cleanup_pending",
        finalState: "failed",
        error: "no installed agent provider is available",
      });
    }
    return { error: "no installed agent provider is available", status: 409 };
  }
  let allocations: ReturnType<typeof allocateFleetAgents>;
  try {
    allocations = allocateFleetAgents({
      tasks: parsed.tasks,
      availableProviders: installed,
      defaultProvider,
      defaultModel: defaultProvider === run.provider ? run.model : null,
    });
  } catch (error) {
    const message =
      plannerError(
        error instanceof Error ? error.message : "planner allocation is invalid"
      ) ?? "planner allocation is invalid";
    if (queuePlannerTerminal(runId, planner, "failed", message)) {
      await finalizePlannerCleanup(runId, {
        ...planner,
        state: "cleanup_pending",
        finalState: "failed",
        error: message,
      });
    }
    const detail = getFleetRunDetail(runId);
    return detail ? { run: detail } : { error: "failed to read fleet run" };
  }
  const indexByKey = new Map(
    parsed.tasks.map((task, index) => [task.key, index])
  );
  const dependencyIndexes = parsed.tasks.map((task) =>
    task.dependsOn.map((key) => indexByKey.get(key) as number)
  );
  if (planner.state === "running") {
    if (
      !writePlannerState(
        runId,
        plannerRequestId,
        { ...planner, state: "finalizing" },
        "planner_finalizing",
        ["running"]
      )
    ) {
      const detail = getFleetRunDetail(runId);
      return detail ? { run: detail } : { error: "failed to read fleet run" };
    }
    planner = { ...planner, state: "finalizing" };
  }
  const result = ingestGeneratedFleetRunPlan(runId, {
    planText: fleetPlannerPlanText(parsed.tasks),
    tasks: parsed.tasks.map((task, index) => {
      const dependencyIndexes = task.dependsOn.map(
        (key) => indexByKey.get(key) as number
      );
      return {
        title: task.title,
        description: task.description,
        taskType: task.taskType,
        parentIndex:
          dependencyIndexes.length === 1 ? dependencyIndexes[0] : null,
        sortOrder: index,
        fileClaims: task.fileClaims,
        agentType: allocations[index].provider,
        model: allocations[index].model,
        acceptanceCriteria: task.acceptanceCriteria,
        riskNotes: task.riskNotes,
        verifyCommand: task.verifyCommand,
      };
    }),
    dependencies: dependencyIndexes,
    expectedPlannerRequestId: plannerRequestId,
    plannerProvider: planner.provider,
    source: "planner",
    actor: "planner",
  });
  if ("error" in result) {
    if (queuePlannerTerminal(runId, planner, "failed", result.error)) {
      await finalizePlannerCleanup(runId, {
        ...planner,
        state: "cleanup_pending",
        finalState: "failed",
        error: result.error,
      });
    }
    return result;
  }
  const current = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
  if (current) await finalizePlannerCleanup(runId, plannerSettings(current));
  const detail = getFleetRunDetail(runId);
  return detail ? { run: detail } : result;
}

export async function reconcileFleetPlanners(limit = 40): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id FROM fleet_runs
       WHERE status = 'draft' AND json_valid(settings_json)
         AND json_extract(settings_json, '$.planner.state') IN
           ('starting', 'running', 'finalizing', 'cleanup_pending')
       ORDER BY updated_at ASC LIMIT ?`
    )
    .all(Math.max(1, Math.min(100, Math.trunc(limit)))) as Array<{
    id: string;
  }>;
  for (const row of rows) await pollFleetPlanner(row.id);
}
