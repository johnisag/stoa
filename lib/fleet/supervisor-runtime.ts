import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { getDb, queries, type Session } from "@/lib/db";
import { resolveExactModelForAgent } from "@/lib/model-catalog";
import { spawnToShellCommand } from "@/lib/providers";
import { sessionKey } from "@/lib/providers/registry";
import { tmpDir } from "@/lib/platform";
import {
  getSessionBackend,
  useContainer,
  type SessionBackend,
} from "@/lib/session-backend";
import { resolveSpawnCommand } from "@/lib/session-backend/pty/registry";
import {
  detectInstalledFleetAgentProviders,
  type FleetAgentProviderId,
} from "./auxiliary-provider";
import {
  buildManagedFleetSupervisorPrompt,
  hashManagedFleetSupervisorNonce,
  parseManagedFleetSupervisorResult,
} from "./supervisor-contract";
import {
  encodeManagedSupervisorBrokerConfig,
  hasManagedSupervisorEnvironmentAuth,
  managedSupervisorBrokerHasMarker,
  managedSupervisorBrokerProfile,
  managedSupervisorEnvironment,
  managedSupervisorProfileHash,
  managedSupervisorProfileJson,
  managedSupervisorPromptFrame,
  MANAGED_SUPERVISOR_BROKER_VERSION,
  MANAGED_SUPERVISOR_GROUP_PATH,
  MANAGED_SUPERVISOR_READY,
  MANAGED_SUPERVISOR_SESSION_ROLE,
  MANAGED_SUPERVISOR_STARTED,
  parseManagedSupervisorProfileJson,
  parseManagedSupervisorCapturedOutput,
  type ManagedSupervisorClaudeSpawn,
} from "./supervisor-broker";
import {
  activateFleetPaidSession,
  finishFleetPaidSession,
  reserveFleetPaidSession,
} from "./session-admission";
import {
  appendFleetSupervisorRecommendation,
  getFleetSupervisorSnapshot,
} from "./supervisor";
import { redactAndCapFleetText } from "./redaction";
import { reconcileUntrackedManagedFleetSupervisors } from "./supervisor-recovery";
import type { FleetRunRow } from "./types";
import { fleetLaunchBlockedResult } from "./recovery-gate";
import { prepareFleetFairnessCursor } from "./fairness-cursor";

const MANAGED_SUPERVISOR_VERSION = 2 as const;
const MANAGED_SUPERVISOR_TIMEOUT_MS = 10 * 60 * 1000;
const MANAGED_SUPERVISOR_SPAWN_GRACE_MS = 2 * 60 * 1000;
const MANAGED_SUPERVISOR_NONCE_BYTES = 32;
const BROKER_INPUT_CHUNK_CHARS = 4096;
const BROKER_HANDSHAKE_TIMEOUT_MS = 10_000;
const BROKER_HANDSHAKE_POLL_MS = 25;
const CAPTURE_LINES = 2500;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const ACTIVE_STATES = new Set(["starting", "running", "cleanup_pending"]);
const TERMINAL_STATES = new Set(["completed", "failed", "canceled"]);

function fleetLifecycleCleanup(
  run: FleetRunRow
): { finalState: "failed" | "canceled"; error: string } | null {
  if (run.status === "failed") {
    return {
      finalState: "failed",
      error: "managed supervisor stopped because the Fleet run failed",
    };
  }
  if (
    run.archived_at ||
    run.status === "canceled" ||
    run.status === "completed" ||
    run.desired_state === "canceled" ||
    (run.desired_state === "paused" && run.pause_mode === "pause-and-interrupt")
  ) {
    return {
      finalState: "canceled",
      error: "managed supervisor was canceled by Fleet lifecycle state",
    };
  }
  return null;
}

const stoaRequire = createRequire(import.meta.url);
const TSX_CLI_PATH = stoaRequire.resolve("tsx/cli");
const BROKER_PATH = fileURLToPath(
  new URL("./supervisor-broker.ts", import.meta.url)
);

export type ManagedFleetSupervisorStateName =
  | "starting"
  | "running"
  | "cleanup_pending"
  | "completed"
  | "failed"
  | "canceled";

export interface ManagedFleetSupervisorState {
  version: typeof MANAGED_SUPERVISOR_VERSION;
  state: ManagedFleetSupervisorStateName;
  requestId: string;
  attempt: number;
  snapshotHash: string;
  planHash: string | null;
  policyHash: string | null;
  executionHash: string;
  baseSha: string | null;
  nonceHash: string;
  sessionId: string;
  sessionRole: typeof MANAGED_SUPERVISOR_SESSION_ROLE;
  brokerVersion: typeof MANAGED_SUPERVISOR_BROKER_VERSION;
  launchProfileHash: string;
  provider: "claude";
  model: string;
  startedAt: string;
  deadlineAt: string;
  /** Durable conservative billing boundary. Once true, process creation may
   * have reached the paid provider even if the multi-step broker handshake or
   * subsequent liveness probe fails. It is never reset. */
  launchAttempted: boolean;
  launchSettled: boolean;
  backendCreated: boolean;
  ambiguousOwnership?: boolean;
  orphanSweepComplete?: boolean;
  finalState?: "completed" | "failed" | "canceled";
  artifactId?: string;
  resultBytes?: number;
  error?: string;
  completedAt?: string;
}

export interface ManagedFleetSupervisorStatus {
  enabled: boolean;
  state: ManagedFleetSupervisorStateName | "idle";
  requestId: string | null;
  attempt: number;
  provider: string | null;
  model: string | null;
  sessionId: string | null;
  artifactId: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  operatorAttention: boolean;
  advisoryOnly: true;
}

export interface ManagedSupervisorBrokerLaunch {
  sessionId: string;
  backendKey: string;
  cwd: string;
  binary: string;
  args: string[];
  command: string;
  environment: Record<string, string>;
  envMode: "replace";
  promptFrame: string;
  profileJson: string;
  profileHash: string;
}

export interface ManagedFleetSupervisorRuntimeDeps {
  db: Database.Database;
  now: () => Date;
  randomId: () => string;
  randomSessionId: () => string;
  randomNonce: () => string;
  availableProviders: () => FleetAgentProviderId[];
  resolveClaudeSpawn: () => { binary: string; argsPrefix: string[] };
  launchSession: (launch: ManagedSupervisorBrokerLaunch) => Promise<void>;
  captureSession: (db: Database.Database, sessionId: string) => Promise<string>;
  sessionExists: (db: Database.Database, sessionId: string) => Promise<boolean>;
  stopSession: (
    sessionId: string,
    finalStatus?: "completed" | "failed"
  ) => Promise<boolean>;
}

export type ManagedFleetSupervisorDeps =
  Partial<ManagedFleetSupervisorRuntimeDeps>;

export type ManagedFleetSupervisorResult =
  | { status: ManagedFleetSupervisorStatus }
  | { error: string; statusCode: number };

async function waitForBrokerMarker(
  backend: SessionBackend,
  backendKey: string,
  marker: typeof MANAGED_SUPERVISOR_READY | typeof MANAGED_SUPERVISOR_STARTED
): Promise<void> {
  const deadline = Date.now() + BROKER_HANDSHAKE_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      const capture = await backend.capture(backendKey, { lines: 40 });
      if (managedSupervisorBrokerHasMarker(capture, marker)) return;
      if (!(await backend.exists(backendKey))) {
        throw new Error("managed supervisor broker exited during handshake");
      }
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    await new Promise<void>((resolveWait) =>
      setTimeout(resolveWait, BROKER_HANDSHAKE_POLL_MS)
    );
  }
  throw new Error(
    marker === MANAGED_SUPERVISOR_READY
      ? "managed supervisor broker did not become ready"
      : "managed supervisor broker did not accept its prompt"
  );
}

export async function launchManagedSupervisorBrokerWithBackend(
  launch: ManagedSupervisorBrokerLaunch,
  backend: SessionBackend = getSessionBackend()
): Promise<void> {
  await backend.create({
    name: launch.backendKey,
    cwd: launch.cwd,
    command: launch.command,
    binary: launch.binary,
    args: launch.args,
    env: launch.environment,
    envMode: launch.envMode,
  });
  await waitForBrokerMarker(
    backend,
    launch.backendKey,
    MANAGED_SUPERVISOR_READY
  );
  for (
    let offset = 0;
    offset < launch.promptFrame.length;
    offset += BROKER_INPUT_CHUNK_CHARS
  ) {
    await backend.sendKeysLiteral(
      launch.backendKey,
      launch.promptFrame.slice(offset, offset + BROKER_INPUT_CHUNK_CHARS)
    );
  }
  await backend.sendEnter(launch.backendKey);
  await waitForBrokerMarker(
    backend,
    launch.backendKey,
    MANAGED_SUPERVISOR_STARTED
  );
}

function dependencies(
  overrides: ManagedFleetSupervisorDeps = {}
): ManagedFleetSupervisorRuntimeDeps {
  const db = overrides.db ?? getDb();
  const exactBackendKey = (sessionId: string) =>
    sessionKey({ kind: "agent", provider: "claude", id: sessionId });
  return {
    db,
    now: overrides.now ?? (() => new Date()),
    randomId: overrides.randomId ?? randomUUID,
    randomSessionId: overrides.randomSessionId ?? randomUUID,
    randomNonce:
      overrides.randomNonce ??
      (() => randomBytes(MANAGED_SUPERVISOR_NONCE_BYTES).toString("base64url")),
    availableProviders:
      overrides.availableProviders ?? detectInstalledFleetAgentProviders,
    resolveClaudeSpawn:
      overrides.resolveClaudeSpawn ??
      (() => {
        const resolved = resolveSpawnCommand("claude", []);
        return { binary: resolved.file, argsPrefix: resolved.args };
      }),
    launchSession:
      overrides.launchSession ?? launchManagedSupervisorBrokerWithBackend,
    captureSession:
      overrides.captureSession ??
      (async (_db, sessionId) => {
        return getSessionBackend().capture(exactBackendKey(sessionId), {
          lines: CAPTURE_LINES,
        });
      }),
    sessionExists:
      overrides.sessionExists ??
      (async (_db, sessionId) =>
        getSessionBackend().exists(exactBackendKey(sessionId))),
    stopSession:
      overrides.stopSession ??
      (async (sessionId, finalStatus = "failed") => {
        const backend = getSessionBackend();
        const key = exactBackendKey(sessionId);
        try {
          if (await backend.exists(key)) await backend.kill(key);
          if (await backend.exists(key)) return false;
          queries.updateWorkerStatus(db).run(finalStatus, sessionId);
          return true;
        } catch {
          return false;
        }
      }),
  };
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

function parseSettings(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function managedState(run: FleetRunRow): ManagedFleetSupervisorState | null {
  const value = parseSettings(run.settings_json).managedSupervisor;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ManagedFleetSupervisorState;
}

function errorText(value: unknown): string {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "managed supervisor failed";
  return redactAndCapFleetText(message, 1_000).text;
}

function publicStatus(
  state: ManagedFleetSupervisorState | null
): ManagedFleetSupervisorStatus {
  return {
    enabled: state != null,
    state: state?.state ?? "idle",
    requestId: state?.requestId ?? null,
    attempt: state?.attempt ?? 0,
    provider: state?.provider ?? null,
    model: state?.model ?? null,
    sessionId: state?.sessionId ?? null,
    artifactId: state?.artifactId ?? null,
    error: state?.error ?? null,
    startedAt: state?.startedAt ?? null,
    completedAt: state?.completedAt ?? null,
    operatorAttention: Boolean(state?.ambiguousOwnership),
    advisoryOnly: true,
  };
}

function event(
  db: Database.Database,
  runId: string,
  eventType: string,
  actor: string,
  payload: Record<string, unknown>,
  createdAt: string
): void {
  queries
    .createFleetEvent(db)
    .run(
      runId,
      eventType,
      redactAndCapFleetText(actor, 80).text,
      JSON.stringify(payload),
      { createdAt }
    );
}

function sessionTask(runId: string, requestId: string): string {
  return `[Stoa Fleet] Managed advisory supervisor request ${requestId} for run ${runId}. Claude print mode has no tools, MCP, lifecycle authority, repository worktree, or generic respawn profile.`;
}

function artifactId(runId: string, requestId: string): string {
  return `managed-supervisor-${createHash("sha256")
    .update(`${runId}\0${requestId}`, "utf8")
    .digest("hex")}`;
}

function hasManagedSupervisorArtifact(
  db: Database.Database,
  runId: string,
  id: string
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM fleet_artifacts
         WHERE id = ? AND fleet_run_id = ?
           AND artifact_type = 'fleet_supervisor_recommendation'`
      )
      .get(id, runId)
  );
}

function ownCostAccount(
  db: Database.Database,
  runId: string,
  requestId: string
): {
  session_id: string | null;
  reservation_released_at: string | null;
  terminal_at: string | null;
  interrupt_requested_at: string | null;
} | null {
  return (
    (db
      .prepare(
        `SELECT session_id, reservation_released_at, terminal_at,
                interrupt_requested_at
         FROM fleet_cost_accounts
         WHERE fleet_run_id = ? AND owner_type = 'supervisor' AND owner_id = ?`
      )
      .get(runId, requestId) as
      | {
          session_id: string | null;
          reservation_released_at: string | null;
          terminal_at: string | null;
          interrupt_requested_at: string | null;
        }
      | undefined) ?? null
  );
}

function sessionOwnedByAnotherAccount(
  db: Database.Database,
  runId: string,
  requestId: string,
  sessionId: string
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM fleet_cost_accounts
         WHERE session_id = ?
           AND NOT (fleet_run_id = ? AND owner_type = 'supervisor' AND owner_id = ?)
         LIMIT 1`
      )
      .get(sessionId, runId, requestId)
  );
}

function sessionProfileError(
  session: Session | undefined,
  runId: string,
  state: ManagedFleetSupervisorState
): string | null {
  if (!session || session.id !== state.sessionId) {
    return "managed supervisor session identity is missing";
  }
  const profileJson = session.launch_profile_json;
  const profileHash = session.launch_profile_hash;
  let profile;
  try {
    profile = profileJson
      ? parseManagedSupervisorProfileJson(profileJson)
      : null;
  } catch {
    profile = null;
  }
  const expectedBackendKey = sessionKey({
    kind: "agent",
    provider: "claude",
    id: state.sessionId,
  });
  if (
    session.session_role !== MANAGED_SUPERVISOR_SESSION_ROLE ||
    !profileJson ||
    !profileHash ||
    !profile ||
    managedSupervisorProfileHash(profileJson) !== profileHash ||
    profileHash !== state.launchProfileHash ||
    profile.backendKey !== expectedBackendKey ||
    session.tmux_name !== profile.backendKey ||
    session.working_directory !== profile.workingDirectory ||
    profile.groupPath !== MANAGED_SUPERVISOR_GROUP_PATH ||
    session.group_path !== profile.groupPath ||
    profile.projectId !== null ||
    session.project_id !== profile.projectId ||
    session.worker_task !== sessionTask(runId, state.requestId) ||
    session.agent_type !== "claude" ||
    session.model !== state.model ||
    Boolean(session.auto_approve) ||
    session.approval_mode !== "prompt" ||
    session.conductor_session_id !== null ||
    session.mcp_launch_args !== null ||
    session.parent_session_id !== null ||
    session.worktree_path !== null ||
    session.claude_session_id !== null
  ) {
    return "managed supervisor immutable session profile does not match";
  }
  return null;
}

function validDurableState(
  _run: FleetRunRow,
  state: ManagedFleetSupervisorState
): string | null {
  if (
    state.version !== MANAGED_SUPERVISOR_VERSION ||
    !SAFE_ID.test(state.requestId ?? "") ||
    !SAFE_ID.test(state.sessionId ?? "") ||
    !Number.isSafeInteger(state.attempt) ||
    state.attempt < 1 ||
    !SHA256.test(state.snapshotHash ?? "") ||
    !SHA256.test(state.executionHash ?? "") ||
    (state.planHash != null && !SHA256.test(state.planHash)) ||
    (state.policyHash != null && !SHA256.test(state.policyHash)) ||
    (state.baseSha != null && !GIT_SHA.test(state.baseSha)) ||
    !SHA256.test(state.nonceHash ?? "") ||
    !SHA256.test(state.launchProfileHash ?? "") ||
    state.sessionRole !== MANAGED_SUPERVISOR_SESSION_ROLE ||
    state.brokerVersion !== MANAGED_SUPERVISOR_BROKER_VERSION ||
    state.provider !== "claude" ||
    typeof state.model !== "string" ||
    typeof state.launchAttempted !== "boolean" ||
    typeof state.launchSettled !== "boolean" ||
    typeof state.backendCreated !== "boolean" ||
    (state.orphanSweepComplete !== undefined &&
      typeof state.orphanSweepComplete !== "boolean")
  ) {
    return "managed supervisor durable broker contract is invalid";
  }
  return null;
}

function writeState(
  deps: ManagedFleetSupervisorRuntimeDeps,
  runId: string,
  requestId: string,
  next:
    | ManagedFleetSupervisorState
    | ((current: ManagedFleetSupervisorState) => ManagedFleetSupervisorState),
  expectedStates: readonly ManagedFleetSupervisorStateName[],
  eventType?:
    string | ((next: ManagedFleetSupervisorState) => string | undefined),
  actor = "fleet-supervisor"
): boolean {
  return transaction(deps.db, () => {
    const run = queries.getFleetRun(deps.db).get(runId) as
      FleetRunRow | undefined;
    const current = run ? managedState(run) : null;
    if (
      !run ||
      current?.requestId !== requestId ||
      !expectedStates.includes(current.state)
    ) {
      return false;
    }
    const resolvedNext = typeof next === "function" ? next(current) : next;
    const settings = parseSettings(run.settings_json);
    settings.managedSupervisor = {
      ...resolvedNext,
      error: resolvedNext.error && errorText(resolvedNext.error),
    };
    const nowIso = deps.now().toISOString();
    const changed = deps.db
      .prepare(
        `UPDATE fleet_runs SET settings_json = ?, updated_at = ?
         WHERE id = ? AND settings_json = ?`
      )
      .run(JSON.stringify(settings), nowIso, runId, run.settings_json);
    if (changed.changes !== 1) return false;
    const resolvedEventType =
      typeof eventType === "function" ? eventType(resolvedNext) : eventType;
    if (resolvedEventType) {
      event(
        deps.db,
        runId,
        resolvedEventType,
        actor,
        {
          requestId,
          attempt: resolvedNext.attempt,
          state: resolvedNext.state,
          provider: resolvedNext.provider,
          model: resolvedNext.model,
          sessionId: resolvedNext.sessionId,
          launchProfileHash: resolvedNext.launchProfileHash,
          artifactId: resolvedNext.artifactId ?? null,
          advisoryOnly: true,
          ...(resolvedNext.error
            ? { error: errorText(resolvedNext.error) }
            : {}),
        },
        nowIso
      );
    }
    return true;
  });
}

function refreshState(
  db: Database.Database,
  runId: string,
  requestId: string
): { run: FleetRunRow; state: ManagedFleetSupervisorState } | null {
  const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
  const state = run ? managedState(run) : null;
  return run && state?.requestId === requestId ? { run, state } : null;
}

function queueCleanup(
  deps: ManagedFleetSupervisorRuntimeDeps,
  runId: string,
  state: ManagedFleetSupervisorState,
  finalState: "completed" | "failed" | "canceled",
  options: {
    error?: string;
    artifactId?: string;
    resultBytes?: number;
    launchSettled?: boolean;
    backendCreated?: boolean;
    ambiguousOwnership?: boolean;
    actor?: string;
  } = {}
): boolean {
  const priority = {
    completed: 1,
    failed: 2,
    canceled: 3,
  } as const;
  return writeState(
    deps,
    runId,
    state.requestId,
    (current) => {
      const currentFinal =
        current.state === "cleanup_pending" ? current.finalState : undefined;
      const incomingWins =
        !currentFinal || priority[finalState] >= priority[currentFinal];
      const mergedFinal = incomingWins ? finalState : currentFinal;
      return {
        ...current,
        state: "cleanup_pending",
        finalState: mergedFinal,
        // All ownership/process uncertainty is sticky and conservative. A stale
        // writer can add evidence but can never downgrade it.
        launchAttempted: current.launchAttempted || state.launchAttempted,
        launchSettled:
          current.launchSettled ||
          state.launchSettled ||
          options.launchSettled === true,
        backendCreated:
          current.backendCreated ||
          state.backendCreated ||
          options.backendCreated === true,
        ambiguousOwnership:
          current.ambiguousOwnership === true ||
          state.ambiguousOwnership === true ||
          options.ambiguousOwnership === true,
        artifactId:
          options.artifactId ?? current.artifactId ?? state.artifactId,
        resultBytes:
          options.resultBytes ?? current.resultBytes ?? state.resultBytes,
        error:
          incomingWins && options.error
            ? errorText(options.error)
            : (current.error ?? state.error),
      };
    },
    ["starting", "running", "cleanup_pending"],
    (next) =>
      next.finalState === "completed"
        ? "managed_supervisor_result_accepted"
        : next.finalState === "canceled"
          ? "managed_supervisor_canceled"
          : "managed_supervisor_failed",
    options.actor
  );
}

function markSupervisorRecoveryRequired(
  deps: ManagedFleetSupervisorRuntimeDeps,
  runId: string,
  state: ManagedFleetSupervisorState,
  reason: string
): void {
  transaction(deps.db, () => {
    const nowIso = deps.now().toISOString();
    const changed = deps.db
      .prepare(
        `UPDATE fleet_runs SET recovery_required = 1, updated_at = ?
         WHERE id = ? AND recovery_required = 0`
      )
      .run(nowIso, runId);
    if (changed.changes === 1) {
      event(
        deps.db,
        runId,
        "managed_supervisor_recovery_required",
        "fleet-supervisor",
        {
          requestId: state.requestId,
          sessionId: state.sessionId,
          reason: errorText(reason),
          operatorAttention: true,
        },
        nowIso
      );
    }
  });
}

async function finalizeCleanup(
  deps: ManagedFleetSupervisorRuntimeDeps,
  run: FleetRunRow,
  state: ManagedFleetSupervisorState
): Promise<boolean> {
  const initial = refreshState(deps.db, run.id, state.requestId);
  if (!initial || initial.state.state !== "cleanup_pending") return false;
  run = initial.run;
  state = initial.state;
  const started = Date.parse(state.startedAt);
  if (
    !state.launchSettled &&
    Number.isFinite(started) &&
    deps.now().getTime() - started <= MANAGED_SUPERVISOR_SPAWN_GRACE_MS
  ) {
    return false;
  }
  let account = ownCostAccount(deps.db, run.id, state.requestId);
  if (!account) {
    markSupervisorRecoveryRequired(
      deps,
      run.id,
      state,
      "managed supervisor cost ownership is missing during cleanup"
    );
    return false;
  }
  const session = queries.getSession(deps.db).get(state.sessionId) as
    Session | undefined;
  const profileError = sessionProfileError(session, run.id, state);
  if (profileError) {
    markSupervisorRecoveryRequired(deps, run.id, state, profileError);
    return false;
  }
  const foreign = sessionOwnedByAnotherAccount(
    deps.db,
    run.id,
    state.requestId,
    state.sessionId
  );
  if (foreign || state.ambiguousOwnership) {
    markSupervisorRecoveryRequired(
      deps,
      run.id,
      state,
      "managed supervisor ownership is ambiguous during cleanup"
    );
    return false;
  }
  const stopped = await deps
    .stopSession(
      state.sessionId,
      state.finalState === "completed" ? "completed" : "failed"
    )
    .catch(() => false);
  if (!stopped) return false;

  // External process I/O yielded to other reconcilers. Re-read every durable
  // decision and never let the stale pre-stop snapshot overwrite a concurrent
  // cancellation, failure, or newly discovered ownership ambiguity.
  const refreshed = refreshState(deps.db, run.id, state.requestId);
  if (!refreshed || refreshed.state.state !== "cleanup_pending") return false;
  run = refreshed.run;
  state = refreshed.state;
  const refreshedSession = queries.getSession(deps.db).get(state.sessionId) as
    Session | undefined;
  const refreshedProfileError = sessionProfileError(
    refreshedSession,
    run.id,
    state
  );
  const refreshedForeign = sessionOwnedByAnotherAccount(
    deps.db,
    run.id,
    state.requestId,
    state.sessionId
  );
  if (refreshedProfileError || refreshedForeign || state.ambiguousOwnership) {
    markSupervisorRecoveryRequired(
      deps,
      run.id,
      state,
      refreshedProfileError ??
        "managed supervisor ownership changed during cleanup"
    );
    return false;
  }
  account = ownCostAccount(deps.db, run.id, state.requestId);
  if (!account) {
    markSupervisorRecoveryRequired(
      deps,
      run.id,
      state,
      "managed supervisor cost ownership disappeared during cleanup"
    );
    return false;
  }
  if (!account?.reservation_released_at) {
    finishFleetPaidSession(deps.db, {
      runId: run.id,
      ownerType: "supervisor",
      ownerId: state.requestId,
      sessionCreated: Boolean(
        account?.session_id || state.backendCreated || state.launchAttempted
      ),
      now: deps.now(),
    });
  }
  const completedAt = deps.now().toISOString();
  return writeState(
    deps,
    run.id,
    state.requestId,
    (current) => {
      const finalState = current.finalState ?? "failed";
      return {
        ...current,
        state: finalState,
        launchSettled: true,
        orphanSweepComplete: current.launchSettled,
        finalState,
        completedAt,
      };
    },
    ["cleanup_pending"],
    "managed_supervisor_cleanup_complete"
  );
}

async function sweepTerminalOrphan(
  deps: ManagedFleetSupervisorRuntimeDeps,
  run: FleetRunRow,
  state: ManagedFleetSupervisorState
): Promise<void> {
  if (!TERMINAL_STATES.has(state.state) || state.orphanSweepComplete) return;
  const session = queries.getSession(deps.db).get(state.sessionId) as
    Session | undefined;
  const profileError = sessionProfileError(session, run.id, state);
  if (profileError) {
    markSupervisorRecoveryRequired(deps, run.id, state, profileError);
    return;
  }
  const foreign = sessionOwnedByAnotherAccount(
    deps.db,
    run.id,
    state.requestId,
    state.sessionId
  );
  let alive: boolean;
  try {
    alive = await deps.sessionExists(deps.db, state.sessionId);
  } catch {
    if (deps.now().getTime() >= Date.parse(state.deadlineAt)) {
      markSupervisorRecoveryRequired(
        deps,
        run.id,
        state,
        "managed supervisor terminal orphan sweep could not verify broker absence"
      );
    }
    return;
  }
  if (alive) {
    if (foreign || state.ambiguousOwnership) {
      markSupervisorRecoveryRequired(
        deps,
        run.id,
        state,
        "managed supervisor terminal orphan has ambiguous ownership"
      );
      return;
    }
    const stopped = await deps
      .stopSession(state.sessionId, "failed")
      .catch(() => false);
    if (!stopped) {
      markSupervisorRecoveryRequired(
        deps,
        run.id,
        state,
        "managed supervisor terminal orphan could not be stopped"
      );
      return;
    }
    writeState(
      deps,
      run.id,
      state.requestId,
      { ...state, orphanSweepComplete: true },
      [state.state],
      "managed_supervisor_orphan_reaped"
    );
    return;
  }
  const deadline = Date.parse(state.deadlineAt);
  if (Number.isFinite(deadline) && deps.now().getTime() >= deadline) {
    writeState(
      deps,
      run.id,
      state.requestId,
      { ...state, orphanSweepComplete: true },
      [state.state],
      "managed_supervisor_orphan_sweep_complete"
    );
  }
}

function selectClaude(
  run: FleetRunRow,
  input: { provider?: unknown; model?: unknown },
  available: readonly FleetAgentProviderId[]
):
  | { provider: "claude"; model: string }
  | { error: string; statusCode: number } {
  const requestedProvider =
    typeof input.provider === "string" ? input.provider.trim() : "";
  if (input.provider != null && requestedProvider !== "claude") {
    return {
      error:
        "managed supervision currently requires Claude's verified no-tools mode",
      statusCode: 400,
    };
  }
  if (!available.includes("claude")) {
    return {
      error: "Claude is not installed for managed no-tools supervision",
      statusCode: 409,
    };
  }
  const requestedModel =
    input.model === undefined || input.model === null
      ? run.provider === "claude"
        ? run.model
        : undefined
      : input.model;
  if (requestedModel !== undefined && typeof requestedModel !== "string") {
    return { error: "managed supervisor model is invalid", statusCode: 400 };
  }
  const exact = resolveExactModelForAgent("claude", requestedModel);
  if (!exact.ok || !exact.model) {
    return {
      error: exact.ok ? "managed supervisor model is invalid" : exact.error,
      statusCode: 400,
    };
  }
  return { provider: "claude", model: exact.model };
}

function buildLaunchContract(input: {
  sessionId: string;
  model: string;
  prompt: string;
  resolvedClaude: { binary: string; argsPrefix: string[] };
}): ManagedSupervisorBrokerLaunch {
  const backendKey = sessionKey({
    kind: "agent",
    provider: "claude",
    id: input.sessionId,
  });
  const cwd = tmpDir();
  const environment = managedSupervisorEnvironment();
  if (!hasManagedSupervisorEnvironmentAuth(environment)) {
    throw new Error(
      "managed supervisor requires a nonblank ANTHROPIC_API_KEY; interactive, OAuth, keychain, and settings-helper authentication are disabled by --bare"
    );
  }
  const claudeSpawn: ManagedSupervisorClaudeSpawn = {
    schemaVersion: MANAGED_SUPERVISOR_BROKER_VERSION,
    binary: input.resolvedClaude.binary,
    argsPrefix: input.resolvedClaude.argsPrefix,
    model: input.model,
  };
  const profileJson = managedSupervisorProfileJson(
    managedSupervisorBrokerProfile(claudeSpawn, {
      backendKey,
      workingDirectory: cwd,
      groupPath: MANAGED_SUPERVISOR_GROUP_PATH,
      projectId: null,
    })
  );
  const profileHash = managedSupervisorProfileHash(profileJson);
  const binary = process.execPath;
  const args = [
    TSX_CLI_PATH,
    BROKER_PATH,
    encodeManagedSupervisorBrokerConfig(claudeSpawn),
  ];
  return {
    sessionId: input.sessionId,
    backendKey,
    cwd,
    binary,
    args,
    command: spawnToShellCommand({ binary, args }),
    environment,
    envMode: "replace",
    promptFrame: managedSupervisorPromptFrame(input.prompt),
    profileJson,
    profileHash,
  };
}

function insertSupervisorSession(
  db: Database.Database,
  input: {
    sessionId: string;
    backendKey: string;
    runId: string;
    requestId: string;
    model: string;
    cwd: string;
    profileJson: string;
    profileHash: string;
  }
): Session {
  db.prepare(
    `INSERT INTO sessions
     (id, name, tmux_name, status, working_directory, parent_session_id,
      claude_session_id, model, group_path, agent_type, auto_approve,
      approval_mode, project_id, conductor_session_id, worker_task,
      worker_status, mcp_launch_args, session_role, launch_profile_json,
      launch_profile_hash)
     VALUES (?, 'Fleet managed supervisor', ?, 'running', ?, NULL, NULL, ?,
      ?, 'claude', 0, 'prompt', NULL, NULL, ?, 'pending',
      NULL, ?, ?, ?)`
  ).run(
    input.sessionId,
    input.backendKey,
    input.cwd,
    input.model,
    MANAGED_SUPERVISOR_GROUP_PATH,
    sessionTask(input.runId, input.requestId),
    MANAGED_SUPERVISOR_SESSION_ROLE,
    input.profileJson,
    input.profileHash
  );
  return queries.getSession(db).get(input.sessionId) as Session;
}

export function getManagedFleetSupervisorStatus(
  runId: string,
  overrides: ManagedFleetSupervisorDeps = {}
): ManagedFleetSupervisorResult {
  const deps = dependencies(overrides);
  const run = queries.getFleetRun(deps.db).get(runId) as
    FleetRunRow | undefined;
  return run
    ? { status: publicStatus(managedState(run)) }
    : { error: "Fleet run not found", statusCode: 404 };
}

export async function startManagedFleetSupervisor(
  runId: string,
  input: { provider?: unknown; model?: unknown } = {},
  overrides: ManagedFleetSupervisorDeps = {}
): Promise<ManagedFleetSupervisorResult> {
  const deps = dependencies(overrides);
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "provider" && key !== "model")
  ) {
    return {
      error: "managed supervisor request has unsupported fields",
      statusCode: 400,
    };
  }
  const recoveryBlocked = fleetLaunchBlockedResult(deps.db, runId);
  if (recoveryBlocked) {
    return { error: recoveryBlocked.error, statusCode: recoveryBlocked.status };
  }
  if (useContainer?.()) {
    return {
      error:
        "managed no-tools supervision is unavailable through the container transport",
      statusCode: 409,
    };
  }
  let run = queries.getFleetRun(deps.db).get(runId) as FleetRunRow | undefined;
  if (!run) return { error: "Fleet run not found", statusCode: 404 };
  if (
    run.recovery_required ||
    run.archived_at ||
    run.status === "canceled" ||
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "paused" ||
    run.desired_state === "canceled" ||
    run.desired_state === "paused"
  ) {
    return {
      error: "Fleet run is not available for managed supervision",
      statusCode: 409,
    };
  }
  const previous = managedState(run);
  if (previous && ACTIVE_STATES.has(previous.state)) {
    return {
      error: "a managed supervisor is already active or cleaning up",
      statusCode: 409,
    };
  }
  if (
    previous &&
    TERMINAL_STATES.has(previous.state) &&
    !previous.orphanSweepComplete
  ) {
    return {
      error: "the prior managed supervisor is still in its orphan-safety sweep",
      statusCode: 409,
    };
  }
  const selection = selectClaude(run, input, deps.availableProviders());
  if ("error" in selection) return selection;

  const requestId = deps.randomId();
  const sessionId = deps.randomSessionId();
  if (!SAFE_ID.test(requestId) || !SAFE_ID.test(sessionId)) {
    return { error: "managed supervisor identity is invalid", statusCode: 500 };
  }
  const attempt = Math.max(0, Math.trunc(previous?.attempt ?? 0)) + 1;
  const nonce = deps.randomNonce();
  const now = deps.now();
  const startedAt = now.toISOString();
  const deadlineAt = new Date(
    now.getTime() + MANAGED_SUPERVISOR_TIMEOUT_MS
  ).toISOString();
  let snapshot = getFleetSupervisorSnapshot(run.id, deps.db);
  if (
    !snapshot ||
    !snapshot.bindings.contractComplete ||
    !snapshot.bindings.executionHash
  ) {
    return {
      error:
        "managed supervisor requires a complete bounded execution contract",
      statusCode: 409,
    };
  }

  let launch: ManagedSupervisorBrokerLaunch;
  try {
    const prompt = buildManagedFleetSupervisorPrompt({
      snapshot,
      requestId,
      attempt,
      nonce,
    });
    launch = buildLaunchContract({
      sessionId,
      model: selection.model,
      prompt,
      resolvedClaude: deps.resolveClaudeSpawn(),
    });
  } catch (error) {
    return { error: errorText(error), statusCode: 409 };
  }

  const state: ManagedFleetSupervisorState = {
    version: MANAGED_SUPERVISOR_VERSION,
    state: "starting",
    requestId,
    attempt,
    snapshotHash: snapshot.snapshotHash,
    planHash: snapshot.bindings.planHash,
    policyHash: snapshot.bindings.policyHash,
    executionHash: snapshot.bindings.executionHash,
    baseSha: snapshot.bindings.baseSha,
    nonceHash: hashManagedFleetSupervisorNonce(nonce),
    sessionId,
    sessionRole: MANAGED_SUPERVISOR_SESSION_ROLE,
    brokerVersion: MANAGED_SUPERVISOR_BROKER_VERSION,
    launchProfileHash: launch.profileHash,
    provider: "claude",
    model: selection.model,
    startedAt,
    deadlineAt,
    launchAttempted: false,
    launchSettled: false,
    backendCreated: false,
  };
  const initialSettingsJson = run.settings_json;
  let claimed = false;
  let admission:
    | { admitted: true }
    | {
        admitted: false;
        reason: "budget" | "resource";
        retryAt: string | null;
      } = { admitted: false, reason: "resource", retryAt: null };

  transaction(deps.db, () => {
    run = queries.getFleetRun(deps.db).get(runId) as FleetRunRow | undefined;
    if (!run || run.settings_json !== initialSettingsJson) return;
    const current = managedState(run);
    if (current && ACTIVE_STATES.has(current.state)) return;
    snapshot = getFleetSupervisorSnapshot(runId, deps.db);
    if (
      !snapshot ||
      !snapshot.bindings.contractComplete ||
      snapshot.bindings.executionHash !== state.executionHash ||
      snapshot.snapshotHash !== state.snapshotHash
    ) {
      return;
    }
    admission = reserveFleetPaidSession(deps.db, {
      run,
      ownerType: "supervisor",
      ownerId: requestId,
      taskType: "supervision",
      provider: "claude",
      model: selection.model,
      repositoryKey: `fleet-supervisor:${run.id}`,
      now,
      leaseExpiresAt: new Date(
        now.getTime() + MANAGED_SUPERVISOR_SPAWN_GRACE_MS
      ).toISOString(),
    });
    if (!admission.admitted) return;
    insertSupervisorSession(deps.db, {
      sessionId,
      backendKey: launch.backendKey,
      runId,
      requestId,
      model: selection.model,
      cwd: launch.cwd,
      profileJson: launch.profileJson,
      profileHash: launch.profileHash,
    });
    const settings = parseSettings(run.settings_json);
    settings.managedSupervisor = state;
    const changed = deps.db
      .prepare(
        `UPDATE fleet_runs SET settings_json = ?, updated_at = ?
         WHERE id = ? AND settings_json = ? AND recovery_required = 0
           AND archived_at IS NULL
           AND status NOT IN ('canceled', 'completed', 'failed')`
      )
      .run(JSON.stringify(settings), startedAt, runId, run.settings_json);
    claimed = changed.changes === 1;
    if (!claimed) throw new Error("Fleet run changed before supervisor claim");
    event(
      deps.db,
      runId,
      "managed_supervisor_requested",
      "operator",
      {
        requestId,
        attempt,
        snapshotHash: state.snapshotHash,
        provider: "claude",
        model: state.model,
        sessionId,
        launchProfileHash: state.launchProfileHash,
        advisoryOnly: true,
      },
      startedAt
    );
  });

  if (!claimed) {
    if (admission.admitted) {
      finishFleetPaidSession(deps.db, {
        runId,
        ownerType: "supervisor",
        ownerId: requestId,
        sessionCreated: false,
        now: deps.now(),
      });
    }
    return !admission.admitted
      ? {
          error:
            admission.reason === "budget"
              ? "managed supervisor budget admission was blocked"
              : "managed supervisor capacity is currently full",
          statusCode: admission.reason === "budget" ? 409 : 429,
        }
      : {
          error: "Fleet run changed before supervisor launch",
          statusCode: 409,
        };
  }

  let backendCreated = false;
  let ambiguousOwnership = false;
  try {
    const beforeLaunch = refreshState(deps.db, runId, requestId);
    const beforeLaunchCleanup = beforeLaunch
      ? fleetLifecycleCleanup(beforeLaunch.run)
      : null;
    if (beforeLaunch && beforeLaunchCleanup) {
      queueCleanup(
        deps,
        runId,
        beforeLaunch.state,
        beforeLaunchCleanup.finalState,
        {
          error: beforeLaunchCleanup.error,
          launchSettled: true,
        }
      );
    }
    if (
      !beforeLaunch ||
      beforeLaunchCleanup ||
      !writeState(
        deps,
        runId,
        requestId,
        { ...beforeLaunch.state, launchAttempted: true },
        ["starting"],
        "managed_supervisor_launch_attempted"
      )
    ) {
      throw new Error(
        beforeLaunchCleanup?.error ??
          "Fleet run changed before supervisor process launch"
      );
    }
    await deps.launchSession(launch);
    backendCreated = true;
    const session = queries.getSession(deps.db).get(sessionId) as
      Session | undefined;
    const profileError = sessionProfileError(session, runId, state);
    if (profileError) throw new Error(profileError);
    if (sessionOwnedByAnotherAccount(deps.db, runId, requestId, sessionId)) {
      ambiguousOwnership = true;
      throw new Error("managed supervisor session has a foreign owner");
    }
    if (
      !activateFleetPaidSession(deps.db, {
        runId,
        ownerType: "supervisor",
        ownerId: requestId,
        session: session!,
        provider: "claude",
        model: selection.model,
        now: deps.now(),
      })
    ) {
      throw new Error("managed supervisor admission is no longer valid");
    }
    const beforeActivation = refreshState(deps.db, runId, requestId);
    const beforeActivationCleanup = beforeActivation
      ? fleetLifecycleCleanup(beforeActivation.run)
      : null;
    if (beforeActivation && beforeActivationCleanup) {
      queueCleanup(
        deps,
        runId,
        beforeActivation.state,
        beforeActivationCleanup.finalState,
        {
          error: beforeActivationCleanup.error,
          launchSettled: true,
          backendCreated: true,
        }
      );
    }
    if (!beforeActivation || beforeActivationCleanup) {
      throw new Error(
        beforeActivationCleanup?.error ??
          "Fleet run changed before supervisor activation"
      );
    }
    const running: ManagedFleetSupervisorState = {
      ...state,
      state: "running",
      launchAttempted: true,
      launchSettled: true,
      backendCreated: true,
    };
    if (
      !writeState(
        deps,
        runId,
        requestId,
        running,
        ["starting"],
        "managed_supervisor_started"
      )
    ) {
      throw new Error("Fleet run changed before supervisor activation");
    }
    return { status: publicStatus(running) };
  } catch (error) {
    if (!backendCreated) {
      backendCreated = await deps
        .sessionExists(deps.db, sessionId)
        .catch(() => false);
    }
    const latest = refreshState(deps.db, runId, requestId);
    if (latest && ACTIVE_STATES.has(latest.state.state)) {
      queueCleanup(deps, runId, latest.state, "failed", {
        error: errorText(error),
        launchSettled: true,
        backendCreated,
        ambiguousOwnership,
      });
      const pending = refreshState(deps.db, runId, requestId);
      if (pending) await finalizeCleanup(deps, pending.run, pending.state);
    } else if (backendCreated) {
      await deps.stopSession(sessionId, "failed").catch(() => false);
    }
    return { error: errorText(error), statusCode: 500 };
  }
}

async function recoverStarting(
  deps: ManagedFleetSupervisorRuntimeDeps,
  run: FleetRunRow,
  state: ManagedFleetSupervisorState
): Promise<ManagedFleetSupervisorState> {
  const lifecycleCleanup = fleetLifecycleCleanup(run);
  if (lifecycleCleanup) {
    queueCleanup(deps, run.id, state, lifecycleCleanup.finalState, {
      error: lifecycleCleanup.error,
      launchSettled: true,
      backendCreated: state.backendCreated || state.launchAttempted,
    });
    return refreshState(deps.db, run.id, state.requestId)?.state ?? state;
  }
  const durableError = validDurableState(run, state);
  const session = queries.getSession(deps.db).get(state.sessionId) as
    Session | undefined;
  const profileError = sessionProfileError(session, run.id, state);
  if (durableError || profileError) {
    queueCleanup(deps, run.id, state, "failed", {
      error: durableError ?? profileError ?? "invalid supervisor profile",
      launchSettled: true,
      ambiguousOwnership: Boolean(profileError),
    });
    return refreshState(deps.db, run.id, state.requestId)?.state ?? state;
  }
  const alive = await deps
    .sessionExists(deps.db, state.sessionId)
    .catch(() => false);
  if (!alive) {
    const started = Date.parse(state.startedAt);
    if (
      !Number.isFinite(started) ||
      deps.now().getTime() - started > MANAGED_SUPERVISOR_SPAWN_GRACE_MS
    ) {
      queueCleanup(deps, run.id, state, "failed", {
        error: "managed supervisor broker was lost and will not be respawned",
        launchSettled: state.launchSettled,
      });
      return refreshState(deps.db, run.id, state.requestId)?.state ?? state;
    }
    return state;
  }
  let capture = "";
  try {
    capture = await deps.captureSession(deps.db, state.sessionId);
  } catch (error) {
    const nowMs = deps.now().getTime();
    const started = Date.parse(state.startedAt);
    const deadline = Date.parse(state.deadlineAt);
    if (
      !Number.isFinite(started) ||
      nowMs - started > MANAGED_SUPERVISOR_SPAWN_GRACE_MS ||
      !Number.isFinite(deadline) ||
      nowMs > deadline
    ) {
      queueCleanup(deps, run.id, state, "failed", {
        error: `managed supervisor capture remained unavailable after launch grace: ${errorText(error)}`,
        launchSettled: true,
        backendCreated: true,
      });
      return refreshState(deps.db, run.id, state.requestId)?.state ?? state;
    }
    return state;
  }
  const capturedResult = parseManagedSupervisorCapturedOutput(capture);
  if (
    !managedSupervisorBrokerHasMarker(capture, MANAGED_SUPERVISOR_STARTED) &&
    capturedResult.state === "pending"
  ) {
    const started = Date.parse(state.startedAt);
    if (
      !Number.isFinite(started) ||
      deps.now().getTime() - started > MANAGED_SUPERVISOR_SPAWN_GRACE_MS
    ) {
      queueCleanup(deps, run.id, state, "failed", {
        error:
          "managed supervisor broker never accepted its prompt and will not be respawned",
        launchSettled: state.launchSettled,
        backendCreated: true,
      });
      return refreshState(deps.db, run.id, state.requestId)?.state ?? state;
    }
    return state;
  }
  if (
    sessionOwnedByAnotherAccount(
      deps.db,
      run.id,
      state.requestId,
      state.sessionId
    )
  ) {
    queueCleanup(deps, run.id, state, "failed", {
      error: "managed supervisor session has a foreign owner",
      launchSettled: true,
      backendCreated: true,
      ambiguousOwnership: true,
    });
    return refreshState(deps.db, run.id, state.requestId)?.state ?? state;
  }
  if (
    !activateFleetPaidSession(deps.db, {
      runId: run.id,
      ownerType: "supervisor",
      ownerId: state.requestId,
      session: session!,
      provider: "claude",
      model: state.model,
      now: deps.now(),
    })
  ) {
    queueCleanup(deps, run.id, state, "failed", {
      error: "managed supervisor recovered admission is no longer valid",
      launchSettled: true,
      backendCreated: true,
    });
    return refreshState(deps.db, run.id, state.requestId)?.state ?? state;
  }
  const running: ManagedFleetSupervisorState = {
    ...state,
    state: "running",
    launchSettled: true,
    backendCreated: true,
  };
  writeState(
    deps,
    run.id,
    state.requestId,
    running,
    ["starting"],
    "managed_supervisor_recovered"
  );
  return refreshState(deps.db, run.id, state.requestId)?.state ?? running;
}

async function pollRunning(
  deps: ManagedFleetSupervisorRuntimeDeps,
  run: FleetRunRow,
  state: ManagedFleetSupervisorState
): Promise<void> {
  const durableError = validDurableState(run, state);
  const session = queries.getSession(deps.db).get(state.sessionId) as
    Session | undefined;
  const profileError = sessionProfileError(session, run.id, state);
  if (durableError || profileError) {
    queueCleanup(deps, run.id, state, "failed", {
      error: durableError ?? profileError ?? "invalid supervisor profile",
      launchSettled: true,
      ambiguousOwnership: Boolean(profileError),
    });
    return;
  }
  const account = ownCostAccount(deps.db, run.id, state.requestId);
  const lifecycleCleanup = fleetLifecycleCleanup(run);
  if (lifecycleCleanup) {
    queueCleanup(deps, run.id, state, lifecycleCleanup.finalState, {
      error: lifecycleCleanup.error,
      launchSettled: true,
    });
    return;
  }
  if (account?.interrupt_requested_at) {
    queueCleanup(deps, run.id, state, "canceled", {
      error: "managed supervisor was interrupted",
      launchSettled: true,
    });
    return;
  }
  if (
    sessionOwnedByAnotherAccount(
      deps.db,
      run.id,
      state.requestId,
      state.sessionId
    )
  ) {
    queueCleanup(deps, run.id, state, "failed", {
      error: "managed supervisor session has a foreign owner",
      launchSettled: true,
      ambiguousOwnership: true,
    });
    return;
  }
  const deadline = Date.parse(state.deadlineAt);
  const timedOut =
    !Number.isFinite(deadline) || deps.now().getTime() > deadline;
  let capture: string;
  try {
    capture = await deps.captureSession(deps.db, state.sessionId);
  } catch (error) {
    const alive = await deps
      .sessionExists(deps.db, state.sessionId)
      .catch(() => false);
    if (alive && !timedOut) return;
    queueCleanup(deps, run.id, state, "failed", {
      error: timedOut
        ? "managed supervisor timed out before producing a valid result"
        : errorText(error),
      launchSettled: true,
    });
    return;
  }
  const captured = parseManagedSupervisorCapturedOutput(capture);
  if (captured.state === "pending") {
    const alive = await deps
      .sessionExists(deps.db, state.sessionId)
      .catch(() => false);
    if (alive && !timedOut) return;
    queueCleanup(deps, run.id, state, "failed", {
      error: timedOut
        ? "managed supervisor timed out before producing a valid result"
        : "managed supervisor broker disappeared before producing a result",
      launchSettled: true,
    });
    return;
  }
  if (captured.state === "invalid") {
    queueCleanup(deps, run.id, state, "failed", {
      error: captured.error,
      launchSettled: true,
    });
    return;
  }
  const parsed = parseManagedFleetSupervisorResult(captured.text, {
    nonceHash: state.nonceHash,
    runId: run.id,
    requestId: state.requestId,
    attempt: state.attempt,
    snapshotHash: state.snapshotHash,
    planHash: state.planHash,
    policyHash: state.policyHash,
    executionHash: state.executionHash,
    baseSha: state.baseSha,
  });
  if (!parsed.ok) {
    queueCleanup(deps, run.id, state, "failed", {
      error: parsed.error,
      resultBytes: captured.bytes,
      launchSettled: true,
    });
    return;
  }
  const exactArtifactId = artifactId(run.id, state.requestId);
  if (!hasManagedSupervisorArtifact(deps.db, run.id, exactArtifactId)) {
    try {
      const appended = appendFleetSupervisorRecommendation(
        run.id,
        parsed.recommendation,
        { db: deps.db, id: () => exactArtifactId, now: deps.now }
      );
      if ("error" in appended) {
        // A second process may have consumed the same nonce-bound deterministic
        // result while this process waited on SQLite. Treat that exact artifact
        // as idempotent success; only a genuinely absent artifact is failure.
        if (!hasManagedSupervisorArtifact(deps.db, run.id, exactArtifactId)) {
          queueCleanup(deps, run.id, state, "failed", {
            error: appended.error,
            resultBytes: captured.bytes,
            launchSettled: true,
          });
          return;
        }
      }
    } catch (error) {
      if (!hasManagedSupervisorArtifact(deps.db, run.id, exactArtifactId)) {
        queueCleanup(deps, run.id, state, "failed", {
          error: errorText(error),
          resultBytes: captured.bytes,
          launchSettled: true,
        });
        return;
      }
    }
  }
  queueCleanup(deps, run.id, state, "completed", {
    artifactId: exactArtifactId,
    resultBytes: captured.bytes,
    launchSettled: true,
  });
}

async function reconcileOne(
  deps: ManagedFleetSupervisorRuntimeDeps,
  runId: string
): Promise<void> {
  let current = queries.getFleetRun(deps.db).get(runId) as
    FleetRunRow | undefined;
  let state = current ? managedState(current) : null;
  if (!current || !state) return;
  if (TERMINAL_STATES.has(state.state)) {
    await sweepTerminalOrphan(deps, current, state);
    return;
  }
  if (!ACTIVE_STATES.has(state.state)) return;
  if (state.state === "starting") {
    state = await recoverStarting(deps, current, state);
    const refreshed = refreshState(deps.db, runId, state.requestId);
    if (!refreshed) return;
    current = refreshed.run;
    state = refreshed.state;
  }
  if (state.state === "running") {
    await pollRunning(deps, current, state);
    const refreshed = refreshState(deps.db, runId, state.requestId);
    if (!refreshed) return;
    current = refreshed.run;
    state = refreshed.state;
  }
  if (state.state === "cleanup_pending") {
    await finalizeCleanup(deps, current, state);
  }
}

const reconcileLocks = new Set<string>();

function claimManagedSupervisorRuns(
  db: Database.Database,
  limit: number
): Array<{ id: string }> {
  return transaction(db, () => {
    let nextCursor = prepareFleetFairnessCursor(db, "supervisorPoll");
    const selected = db
      .prepare(
        `SELECT id FROM fleet_runs
         WHERE json_valid(settings_json)
           AND (
             json_extract(settings_json, '$.managedSupervisor.state')
               IN ('starting', 'running', 'cleanup_pending')
             OR (
               json_extract(settings_json, '$.managedSupervisor.state')
                 IN ('completed', 'failed', 'canceled')
               AND COALESCE(
                 json_extract(settings_json,
                   '$.managedSupervisor.orphanSweepComplete'), 0
               ) = 0
             )
           )
         ORDER BY managed_supervisor_poll_cursor, id LIMIT ?`
      )
      .all(limit) as Array<{ id: string }>;
    const advance = db.prepare(
      `UPDATE fleet_runs
       SET managed_supervisor_poll_cursor = ?
       WHERE id = ?`
    );
    return selected.filter(
      (run) => advance.run(++nextCursor, run.id).changes === 1
    );
  });
}

/** Recover and poll only the preallocated durable broker identity. This function
 * never creates or respawns a session. */
export async function reconcileManagedFleetSupervisors(
  limit = 40,
  overrides: ManagedFleetSupervisorDeps = {}
): Promise<number> {
  const deps = dependencies(overrides);
  if (reconcileLocks.has("global")) return 0;
  reconcileLocks.add("global");
  try {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    await reconcileUntrackedManagedFleetSupervisors(deps, boundedLimit);
    const rows = claimManagedSupervisorRuns(deps.db, boundedLimit);
    for (const row of rows) await reconcileOne(deps, row.id);
    return rows.length;
  } finally {
    reconcileLocks.delete("global");
  }
}

export async function cancelManagedFleetSupervisor(
  runId: string,
  overrides: ManagedFleetSupervisorDeps = {},
  actor = "operator"
): Promise<ManagedFleetSupervisorResult> {
  const deps = dependencies(overrides);
  const run = queries.getFleetRun(deps.db).get(runId) as
    FleetRunRow | undefined;
  if (!run) return { error: "Fleet run not found", statusCode: 404 };
  const state = managedState(run);
  if (!state || TERMINAL_STATES.has(state.state)) {
    return { error: "no managed supervisor is active", statusCode: 409 };
  }
  queueCleanup(deps, run.id, state, "canceled", {
    error: "managed supervisor was canceled",
    actor,
  });
  const pending = refreshState(deps.db, run.id, state.requestId);
  if (pending) await finalizeCleanup(deps, pending.run, pending.state);
  const latest = queries.getFleetRun(deps.db).get(run.id) as FleetRunRow;
  return { status: publicStatus(managedState(latest)) };
}
