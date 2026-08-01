import { randomUUID } from "crypto";
import { constants } from "fs";
import { lstat, open } from "fs/promises";
import { join } from "path";
import { getDb, queries, type Session } from "@/lib/db";
import type { Project } from "@/lib/db/types";
import type { DispatchRepo } from "@/lib/dispatch/types";
import { getDefaultBranch, isGitRepo } from "@/lib/git-status";
import { generateBranchName, runGit } from "@/lib/git";
import { spawnWorker, WorkerSpawnError } from "@/lib/orchestration";
import {
  backendKeyForSession,
  type ProviderId,
} from "@/lib/providers/registry";
import { detectAgentBinaries } from "@/lib/readiness-server";
import { getSessionBackend } from "@/lib/session-backend";
import { deleteWorktree } from "@/lib/worktrees";
import {
  FLEET_DEFAULT_PARALLEL_WORKERS,
  FLEET_MAX_TOTAL_WORKERS,
  providerConcurrencyCap,
} from "./admission";
import { allocateFleetAgents } from "./allocation";
import { getFleetRunDetail, ingestGeneratedFleetRunPlan } from "./service";
import { stopFleetSession } from "./stop";
import type { FleetRunDetailDto, FleetRunRow } from "./types";
import {
  buildFleetPlannerPrompt,
  fleetPlannerPlanText,
  normalizeFleetPlannerTaskCap,
  parseFleetPlannerOutput,
} from "./planner-plan";

const FLEET_PLAN_FILE_MAX_BYTES = 128 * 1024;
const FLEET_PLANNER_TIMEOUT_MS = 15 * 60 * 1000;
const FLEET_MAX_CONCURRENT_PLANNERS = 4;
const FLEET_MAX_CONCURRENT_PLANNERS_PER_PROVIDER = 2;
const ACTIVE_PLANNER_STATES = ["starting", "running", "finalizing"] as const;

function isActivePlannerState(value: string | undefined): boolean {
  return ACTIVE_PLANNER_STATES.some((state) => state === value);
}

function consumesPlannerCapacity(value: string | undefined): boolean {
  return isActivePlannerState(value) || value === "cleanup_pending";
}

interface PlannerSettings {
  state?: string;
  requestId?: string;
  sessionId?: string;
  worktreePath?: string;
  projectPath?: string;
  branchName?: string;
  taskCap?: number;
  provider?: string;
  error?: string;
  startedAt?: string;
  finalState?: "ready" | "failed" | "idle";
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
      return { error: "planner PLAN.md is not a regular file" };
    }
    handle = await open(path, constants.O_RDONLY | noFollow | nonBlock);
    const info = await handle.stat();
    if (
      !info.isFile() ||
      (pathInfo.ino !== 0 &&
        info.ino !== 0 &&
        (pathInfo.dev !== info.dev || pathInfo.ino !== info.ino))
    ) {
      return { error: "planner PLAN.md changed before it could be read" };
    }
    const buffer = Buffer.alloc(FLEET_PLAN_FILE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > FLEET_PLAN_FILE_MAX_BYTES) {
      return { error: "planner PLAN.md exceeds the 128 KiB safety limit" };
    }
    return { text: buffer.subarray(0, bytesRead).toString("utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { error: "planner has not written PLAN.md", missing: true };
    }
    return { error: "planner PLAN.md could not be read safely" };
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

function availableProviders(): ProviderId[] {
  const found = detectAgentBinaries();
  return (Object.keys(found) as Array<keyof typeof found>).filter(
    (provider) => found[provider]
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
  expectedStates?: readonly string[]
): boolean {
  const db = getDb();
  const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
  const currentPlanner = run ? plannerSettings(run) : {};
  if (
    !run ||
    currentPlanner.requestId !== requestId ||
    (expectedStates && !expectedStates.includes(currentPlanner.state ?? ""))
  )
    return false;
  const settings = parseSettings(run.settings_json);
  settings.planner = planner;
  settings.phase = ["failed", "idle"].includes(planner.state ?? "")
    ? "draft"
    : planner.state === "ready"
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
  if (changed.changes === 1 && eventType) {
    queries
      .createFleetEvent(db)
      .run(runId, eventType, "planner", JSON.stringify(planner));
  }
  return changed.changes === 1;
}

function queuePlannerTerminal(
  runId: string,
  planner: PlannerSettings,
  finalState: "failed" | "idle",
  error?: string
): boolean {
  if (!planner.requestId) return false;
  return writePlannerState(
    runId,
    planner.requestId,
    {
      ...planner,
      state: "cleanup_pending",
      finalState,
      error: error?.slice(0, 1000),
    },
    finalState === "failed" ? "planner_failed" : "planner_canceled",
    [...ACTIVE_PLANNER_STATES]
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
  input: { taskCap?: unknown; provider?: unknown } = {}
): Promise<{ run: FleetRunDetailDto } | { error: string; status?: number }> {
  const db = getDb();
  const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
  if (!run) return { error: "Fleet run not found", status: 404 };
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
  const target = targetForRun(run);
  if (!target || !isGitRepo(target.workingDirectory)) {
    return {
      error: "automatic planning requires an accessible Git repository",
      status: 409,
    };
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
  const startedAt = new Date().toISOString();
  const branchName = generateBranchName(
    `fleet-plan-${run.id.slice(0, 8)}-${requestId.slice(0, 8)}`
  );

  const settings = parseSettings(run.settings_json);
  settings.phase = "planning";
  settings.canSpawnWorkers = false;
  settings.planner = {
    state: "starting",
    requestId,
    taskCap,
    provider,
    startedAt,
    projectPath: target.workingDirectory,
    branchName,
  };
  let capacityAvailable = false;
  let claimed = false;
  db.exec("BEGIN IMMEDIATE");
  try {
    capacityAvailable = plannerAdmissionAvailable(provider, db);
    if (capacityAvailable) {
      claimed =
        db
          .prepare(
            `UPDATE fleet_runs SET settings_json = ?, updated_at = datetime('now')
             WHERE id = ? AND status = 'draft'
               AND approval_state IN ('draft', 'needs_approval')
               AND settings_json = ?`
          )
          .run(JSON.stringify(settings), runId, run.settings_json).changes ===
        1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (!capacityAvailable) {
    return { error: "planner capacity is currently full", status: 429 };
  }
  if (!claimed) {
    return { error: "run state changed before planner launch", status: 409 };
  }
  queries.createFleetEvent(db).run(
    runId,
    "planner_requested",
    "operator",
    JSON.stringify({
      requestId,
      provider,
      taskCap,
    })
  );

  try {
    const session = await spawnWorker({
      conductorSessionId: run.conductor_session_id ?? null,
      task: buildFleetPlannerPrompt({
        goal: run.goal,
        baseBranch: target.baseBranch,
        taskCap,
        availableProviders: installed,
      }),
      workingDirectory: target.workingDirectory,
      branchName: `fleet-plan-${run.id.slice(0, 8)}-${requestId.slice(0, 8)}`,
      baseBranch: target.baseBranch,
      useWorktree: true,
      requireWorktree: true,
      requireTaskDelivery: true,
      skipSetup: true,
      approvalMode: "prompt",
      agentType: provider,
      model: provider === run.provider ? (run.model ?? undefined) : undefined,
    });
    if (!session.worktree_path) {
      throw new Error("planner started without an isolated worktree");
    }
    const persisted = writePlannerState(
      runId,
      requestId,
      {
        state: "running",
        requestId,
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
        latestPlanner.worktreePath === session.worktree_path
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
          {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "planner failed";
    const failedPlanner = {
      ...plannerSettings(
        (queries.getFleetRun(db).get(runId) as FleetRunRow | undefined) ?? run
      ),
      requestId,
      projectPath: target.workingDirectory,
      branchName,
    };
    const pending = {
      ...failedPlanner,
      state: "cleanup_pending",
      finalState: "failed",
      error: message,
      ...(error instanceof WorkerSpawnError
        ? {
            sessionId: error.sessionId ?? undefined,
            worktreePath: error.worktreePath ?? undefined,
          }
        : {}),
    } satisfies PlannerSettings;
    if (queuePlannerTerminal(runId, failedPlanner, "failed", message)) {
      const hydrated = writePlannerState(runId, requestId, pending, undefined, [
        "cleanup_pending",
      ]);
      if (hydrated) await finalizePlannerCleanup(runId, pending);
    }
    return { error: message, status: 500 };
  }

  const detail = getFleetRunDetail(runId);
  return detail ? { run: detail } : { error: "failed to read fleet run" };
}

async function cleanupPlanner(
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
  return true;
}

async function finalizePlannerCleanup(
  runId: string,
  planner: PlannerSettings
): Promise<boolean> {
  if (planner.state !== "cleanup_pending" || !planner.requestId) return false;
  const startedAt = Date.parse(planner.startedAt ?? "");
  if (
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
    planner,
    finalState === "ready" ? "completed" : "failed"
  );
  if (!cleaned) return false;
  return writePlannerState(
    runId,
    planner.requestId,
    {
      state: finalState,
      requestId: planner.requestId,
      provider: planner.provider,
      error: planner.error,
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
    if (recovered.worktreePath) {
      const running = {
        ...recovered,
        state: "running",
      } satisfies PlannerSettings;
      if (
        !writePlannerState(
          runId,
          planner.requestId,
          running,
          "planner_recovered",
          ["starting"]
        )
      ) {
        const detail = getFleetRunDetail(runId);
        return detail ? { run: detail } : { error: "failed to read fleet run" };
      }
      planner = running;
    }
  }
  if (!queuePlannerTerminal(runId, planner, "idle")) {
    return { error: "planner state changed before cancellation", status: 409 };
  }
  queries
    .createFleetEvent(db)
    .run(
      runId,
      "planner_cancel_requested",
      actor.slice(0, 80),
      JSON.stringify({ requestId: planner.requestId })
    );
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
    if (recovered.worktreePath) {
      const running = {
        ...recovered,
        state: "running",
      } satisfies PlannerSettings;
      if (
        !writePlannerState(
          runId,
          planner.requestId,
          running,
          "planner_recovered",
          ["starting"]
        )
      ) {
        const detail = getFleetRunDetail(runId);
        return detail ? { run: detail } : { error: "failed to read fleet run" };
      }
      planner = running;
    }
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
  const file = await readBoundedFleetPlannerFile(
    join(planner.worktreePath, "PLAN.md")
  );
  const parsed =
    "text" in file
      ? parseFleetPlannerOutput(file.text, planner.taskCap ?? 8)
      : ({ ok: false, error: file.error } as const);

  if (!parsed.ok) {
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
      if (queuePlannerTerminal(runId, planner, "failed", parsed.error)) {
        await finalizePlannerCleanup(runId, {
          ...planner,
          state: "cleanup_pending",
          finalState: "failed",
          error: parsed.error,
        });
      }
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
  const allocations = allocateFleetAgents({
    tasks: parsed.tasks,
    availableProviders: installed,
    defaultProvider,
    defaultModel: defaultProvider === run.provider ? run.model : null,
  });
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
