/**
 * Orchestration System
 *
 * Allows a "conductor" session to spawn and manage worker sessions.
 * Each worker gets its own git worktree for isolation.
 */

import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, realpathSync } from "fs";
import { rm } from "fs/promises";
import { db, queries, resolveDbPath, type Session } from "./db";
import { createWorktree, deleteWorktree } from "./worktrees";
import { setupWorktree } from "./env-setup";
import {
  resolveExactModelForAgent,
  resolveModelForAgent,
} from "./model-catalog";
import {
  type AgentType,
  getProvider,
  buildAgentArgs,
  spawnToShellCommand,
} from "./providers";
import { sessionKey } from "./providers/registry";
import { statusDetector } from "./status-detector";
import { wrapWithBanner } from "./banner";
import { runInBackground } from "./async-operations";
import { getSessionBackend, useContainer } from "./session-backend";
import { expandHome, homeDir, isWindows, stoaHomeDir } from "./platform";
import { emitGenAiEvent } from "./telemetry/otel";
import { detectSandboxTool } from "./sandbox/detect";
import { wrapSpawnForSandbox } from "./sandbox/wrap";
import { computeRwRoots } from "./sandbox/policy";
import { decideWorkerSandbox, effectiveSandboxActive } from "./sandbox/worker";
import type { ApprovalMode } from "./sandbox/types";
import { isAbsolute, relative, resolve, sep } from "path";
import {
  assertFleetWritableRootIdentityPreserved,
  fleetWritableRootMounts,
  mapMountedHostPathsInText,
  validateFleetWritableRootLayouts,
} from "./container/mounts";
import { isInteractiveSessionRole } from "./session-role";

const execFileAsync = promisify(execFile);

export interface SpawnWorkerOptions {
  conductorSessionId?: string | null;
  /** Durable, non-secret task summary stored on the session row. */
  task: string;
  /**
   * Optional ephemeral task delivered to the terminal instead of `task`.
   * It is never logged or written to the session row (Fleet uses this for a
   * one-attempt report nonce).
   */
  deliveryTask?: string;
  workingDirectory: string;
  branchName?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  /** Fleet write tasks must fail closed instead of using the source checkout. */
  requireWorktree?: boolean;
  /** Treat backend start or task delivery failure as a rejected launch. */
  requireTaskDelivery?: boolean;
  /** Skip dependency/env setup for short-lived metadata-only worktrees. */
  skipSetup?: boolean;
  /** Keep the checkout and Git common directory read-only in an active sandbox. */
  readOnlyWorktree?: boolean;
  /**
   * Exact Fleet-owned attempt directories the process may write outside its
   * checkout. Values are validated against the two narrow runtime layouts;
   * passing STOA_HOME (or an arbitrary parent) is rejected.
   */
  fleetWritableRoots?: string[];
  /**
   * Exact host artifact files named in deliveryTask. Container launches rewrite
   * only these values through the matching exact attempt-directory bind;
   * durable state and host-side collectors continue using the original paths.
   */
  fleetArtifactPaths?: string[];
  /** Fleet requires stronger isolation than the legacy generic worker sandbox. */
  requireStrongIsolation?: boolean;
  /** Opaque, scheduler-issued identity for exact Fleet restart recovery. */
  fleetOwnershipKey?: string;
  /** Override the default worker approval policy (planners use prompt mode). */
  approvalMode?: ApprovalMode;
  model?: string;
  /** Fail instead of silently clamping an executable durable model contract. */
  requireExactModel?: boolean;
  agentType?: AgentType;
}

export class WorkerSpawnError extends Error {
  constructor(
    message: string,
    readonly sessionId: string | null,
    readonly worktreePath: string | null
  ) {
    super(message);
    this.name = "WorkerSpawnError";
  }
}

/** Direct orchestration helpers are generic interactive-session surfaces. An
 * internal row must be operated only by its owning subsystem, even when a
 * caller bypasses the HTTP route and invokes a helper directly. */
export class WorkerSessionAccessError extends Error {
  readonly status = 409;

  constructor() {
    super("Internal sessions are managed only by their owning subsystem");
    this.name = "WorkerSessionAccessError";
  }
}

function assertInteractiveWorkerSession(session: Session): void {
  if (!isInteractiveSessionRole(session)) {
    throw new WorkerSessionAccessError();
  }
}

function findInteractiveWorkerSession(workerId: string): Session | undefined {
  const session = queries.getSession(db).get(workerId) as Session | undefined;
  if (session) assertInteractiveWorkerSession(session);
  return session;
}

function requireInteractiveWorkerSession(workerId: string): Session {
  const session = findInteractiveWorkerSession(workerId);
  if (!session) throw new Error(`Worker ${workerId} not found`);
  return session;
}

let worktreeOperationTail: Promise<void> = Promise.resolve();

async function createWorkerWorktree(
  options: Parameters<typeof createWorktree>[0]
) {
  const previous = worktreeOperationTail;
  let release!: () => void;
  worktreeOperationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await createWorktree(options);
  } finally {
    release();
  }
}

export interface WorkerInfo {
  id: string;
  name: string;
  /** Which agent runs this worker — "claude" | "codex" | "hermes". */
  agentType: string;
  task: string;
  status:
    | "pending"
    | "running"
    | "waiting"
    | "idle"
    | "completed"
    | "failed"
    | "dead";
  worktreePath: string | null;
  branchName: string | null;
  createdAt: string;
}

/**
 * Generate a unique branch name from a task description
 */
function taskToBranchName(task: string): string {
  const base =
    task
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .slice(0, 4)
      .join("-")
      .slice(0, 30) || "worker";

  // Add short unique suffix to avoid conflicts
  const suffix = Date.now().toString(36).slice(-4);
  return `${base}-${suffix}`;
}

/**
 * Generate a short session name from a task description
 */
function taskToSessionName(task: string): string {
  // Take first 50 chars, trim to last complete word
  const truncated = task.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated;
}

/**
 * Resolve a worker's writable roots (#27): its worktree + the git-common dir (so
 * index/refs/objects writes succeed) + the agent's OWN state dir (~/.claude,
 * ~/.codex — where the CLI writes its rollout/transcript, which Stoa reads) +
 * exact Fleet attempt output directories. Stoa's authority directory remains
 * hidden inside the sandbox.
 */
async function resolveWorkerRwRoots(
  cwd: string,
  agentType: AgentType,
  includeWorktree = true,
  fleetWritableRoots: string[] = []
): Promise<string[]> {
  let gitCommonDir: string | null = null;
  if (includeWorktree) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { windowsHide: true }
      );
      gitCommonDir = stdout.trim() || null;
    } catch {
      // Not a git repo (or git absent) — bind just the cwd + state dirs.
    }
  }
  const configDir = getProvider(agentType).configDir; // e.g. "~/.claude"
  return computeRwRoots({
    worktreePaths: includeWorktree ? [cwd] : [],
    gitCommonDir,
    agentConfigDir: configDir ? expandHome(configDir) : null,
    fleetWritableRoots,
  });
}

const FLEET_SANDBOX_AUTHORITY_ENV = [
  "STOA_TOKEN",
  "STOA_FLEET_SCHEDULER_TOKEN",
  "STOA_WEBHOOK_SECRET",
  "STOA_VAPID_PRIVATE_KEY",
] as const;

function isPathWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return (
    rel.length === 0 ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

/** Validate that a Fleet launch exposes only one exact attempt directory. */
export function validateFleetSandboxWritableRoots(
  roots: readonly string[],
  stoaHome = stoaHomeDir()
): string[] {
  const authorityRoot = resolve(stoaHome);
  const validated = validateFleetWritableRootLayouts(
    roots.map((value) => expandHome(value)),
    authorityRoot
  );
  for (const candidate of validated) {
    // A lexical child can still escape through an existing symlink/junction in
    // any ancestor. Runtime attempt directories exist before spawn, so resolve
    // both sides and require the actual target to remain under the actual Stoa
    // authority root. Keep the lexical fallback for pure command-construction
    // callers/tests whose paths deliberately do not exist yet.
    if (existsSync(authorityRoot) && existsSync(candidate)) {
      const realAuthority = realpathSync.native(authorityRoot);
      const realCandidate = realpathSync.native(candidate);
      if (!isPathWithin(realAuthority, realCandidate)) {
        throw new Error(
          "Fleet sandbox writable root escapes Stoa authority through a symbolic link or junction"
        );
      }
      // Containment alone is insufficient: a valid-looking attempt path could
      // be a link to another sensitive child or another valid Fleet attempt.
      assertFleetWritableRootIdentityPreserved({
        lexicalRoots: [candidate],
        lexicalStoaHome: authorityRoot,
        realRoots: [realCandidate],
        realStoaHome: realAuthority,
      });
    }
  }
  return validated;
}

function sandboxAuthorityPolicy(fleetWritableRoots: string[]) {
  const authorityRoot = resolve(stoaHomeDir());
  const dbPath = resolve(resolveDbPath());
  const maskedPaths = isPathWithin(authorityRoot, dbPath)
    ? []
    : [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  return {
    hiddenRoots: [authorityRoot],
    maskedPaths,
    unsetEnv: [...FLEET_SANDBOX_AUTHORITY_ENV],
    fleetWritableRoots,
  };
}

export function fleetDeliveryTaskForContainer(
  deliveryTask: string,
  artifactPaths: readonly string[],
  fleetWritableRoots: readonly string[],
  stoaHome = resolve(stoaHomeDir()),
  hostHome = homeDir()
): string {
  return mapMountedHostPathsInText(
    deliveryTask,
    artifactPaths,
    fleetWritableRootMounts(fleetWritableRoots, stoaHome, hostHome)
  );
}

/**
 * Spawn a new worker session
 */
export async function spawnWorker(
  options: SpawnWorkerOptions
): Promise<Session> {
  if (
    options.fleetOwnershipKey != null &&
    !/^[0-9a-f]{64}$/.test(options.fleetOwnershipKey)
  ) {
    throw new Error("Invalid Fleet session ownership key");
  }
  const backend = getSessionBackend();
  const {
    conductorSessionId,
    task,
    deliveryTask = task,
    workingDirectory: rawWorkingDir,
    branchName = taskToBranchName(task),
    baseBranch = "main",
    useWorktree = true,
    requireWorktree = false,
    requireTaskDelivery = false,
    skipSetup = false,
    agentType = "claude",
  } = options;
  const exactModel = options.requireExactModel
    ? resolveExactModelForAgent(agentType, options.model)
    : null;
  if (exactModel && !exactModel.ok) {
    throw new Error(exactModel.error);
  }
  const model = exactModel?.ok
    ? (exactModel.model ?? "")
    : resolveModelForAgent(agentType, options.model);

  // Expand ~ to home directory
  const workingDirectory = expandHome(rawWorkingDir);
  const fleetWritableRoots = validateFleetSandboxWritableRoots(
    options.fleetWritableRoots ?? []
  );
  const containerActive = useContainer?.() === true;
  const runtimeDeliveryTask =
    options.fleetArtifactPaths?.length && containerActive
      ? fleetDeliveryTaskForContainer(
          deliveryTask,
          options.fleetArtifactPaths,
          fleetWritableRoots
        )
      : deliveryTask;

  const sessionId = randomUUID();
  const sessionName = taskToSessionName(task);
  const provider = getProvider(agentType);

  // A fleet run may be server-owned and therefore have no conductor session.
  // When one is supplied, validate it before creating a worktree so an invalid
  // foreign key cannot leave an orphan directory behind.
  if (conductorSessionId) {
    const conductor = queries.getSession(db).get(conductorSessionId) as
      Session | undefined;
    if (!conductor) {
      throw new Error(
        `Unknown conductor session: ${conductorSessionId}. The conductor must be an existing Stoa session.`
      );
    }
    if (!isInteractiveSessionRole(conductor)) {
      throw new Error(
        `Unknown conductor session: ${conductorSessionId}. The conductor must be an existing interactive Stoa session.`
      );
    }
  }

  let worktreePath: string | null = null;
  let actualWorkingDir = workingDirectory;
  let actualBranchName = branchName;
  let actualBaseBranch = baseBranch;

  // Create worktree if requested
  if (useWorktree) {
    try {
      const worktreeResult = await createWorkerWorktree({
        projectPath: workingDirectory,
        featureName: branchName,
        baseBranch,
      });
      worktreePath = worktreeResult.worktreePath;
      actualBranchName = worktreeResult.branchName;
      actualBaseBranch = worktreeResult.baseBranch;
      actualWorkingDir = worktreePath;

      // Set up environment in background (copy .env files, install deps)
      const capturedWorktreePath = worktreePath;
      const capturedSourcePath = workingDirectory;
      if (!skipSetup) {
        runInBackground(async () => {
          const result = await setupWorktree({
            worktreePath: capturedWorktreePath,
            sourcePath: capturedSourcePath,
          });
          console.log("Worker worktree setup completed:", {
            worktreePath: capturedWorktreePath,
            envFilesCopied: result.envFilesCopied,
            stepsRun: result.steps.length,
            success: result.success,
          });
        }, `setup-worker-worktree-${sessionId}`);
      }
    } catch (error) {
      console.error("Failed to create worktree:", error);
      if (requireWorktree) {
        throw new Error("Fleet worker requires an isolated worktree", {
          cause: error,
        });
      }
      // Generic orchestration preserves its historical source-checkout fallback.
    }
  }

  try {
    // Create session in database
    const tmuxName = sessionKey({
      kind: "agent",
      provider: provider.id,
      id: sessionId,
    });
    queries.createWorkerSession(db).run(
      sessionId,
      sessionName,
      tmuxName,
      actualWorkingDir,
      conductorSessionId,
      task,
      model,
      "sessions", // group_path
      agentType,
      "uncategorized", // project_id
      worktreePath,
      worktreePath ? actualBranchName : null,
      worktreePath ? actualBaseBranch : null,
      options.fleetOwnershipKey ?? null
    );

    // Create the session and start the agent. Workers use auto-approve.
    const tmuxSessionName = sessionKey({
      kind: "agent",
      provider: provider.id,
      id: sessionId,
    });
    // Raw cwd (may contain "~"); each backend expands it for its platform.
    const cwd = actualWorkingDir;

    // #27 OS sandbox tier (opt-in via STOA_SANDBOX). Workers still auto-approve;
    // sandboxed-auto additionally CONFINES the process when a primitive is
    // detected. Detect ONCE and inject that verdict into the wrap so the bypass
    // flag and the confinement are decided by a SINGLE detection (no TOCTOU
    // fail-open).
    const sandboxEnabled = process.env.STOA_SANDBOX === "1";
    const detected = sandboxEnabled ? detectSandboxTool() : null;
    if (sandboxEnabled && !detected && !options.approvalMode) {
      console.warn(
        "[sandbox] STOA_SANDBOX=1 but no Linux/bwrap primitive found; running unconfined with full-bypass"
      );
    }
    const sandboxDecision = decideWorkerSandbox({
      sandboxEnabled,
      detected: detected !== null,
    });
    const approvalMode = options.approvalMode ?? sandboxDecision.approvalMode;
    const tentativeActive =
      approvalMode === "sandboxed-auto" &&
      sandboxDecision.sandboxActive &&
      options.requireStrongIsolation !== true;
    if (
      approvalMode === "sandboxed-auto" &&
      options.requireStrongIsolation === true
    ) {
      console.warn(
        "[sandbox] Fleet strong isolation is unavailable; running without prompt bypass"
      );
    }

    // Resolve the ACTUAL wrap BEFORE building argv, so the bypass flag is pushed
    // ONLY when the sandbox truly confines: a downgrade withdraws the flag (the
    // worker then prompts rather than running unattended-and-unconfined).
    let wrapPrefix: { file: string; argsPrefix: string[] } | null = null;
    let sandboxActive = tentativeActive;
    if (tentativeActive && detected) {
      const authorityPolicy = sandboxAuthorityPolicy(fleetWritableRoots);
      const rwRoots = await resolveWorkerRwRoots(
        expandHome(cwd),
        provider.id,
        options.readOnlyWorktree !== true,
        authorityPolicy.fleetWritableRoots
      );
      const wrap = wrapSpawnForSandbox(
        { file: "", args: [] },
        "sandboxed-auto",
        {
          rwRoots,
          hiddenRoots: authorityPolicy.hiddenRoots,
          maskedPaths: authorityPolicy.maskedPaths,
          unsetEnv: authorityPolicy.unsetEnv,
          allowNet: true,
        },
        { detect: () => detected } // reuse the one detection — no second probe
      );
      sandboxActive = effectiveSandboxActive(tentativeActive, wrap.downgraded);
      if (wrap.downgraded) {
        console.warn(
          `[sandbox] worker sandbox downgraded (${wrap.reason ?? "unknown"}) — running WITHOUT auto-approve (prompting)`
        );
      } else {
        wrapPrefix = { file: wrap.file, argsPrefix: wrap.argsPrefix };
      }
    }

    const { binary, args } = buildAgentArgs(provider.id, {
      model,
      approvalMode,
      sandboxActive, // the wrap-verified value — no flag unless truly confined
    });

    // Compose the confined argv: [bwrap, ...prefix, agentBinary, ...agentArgs].
    let spawnBinary = binary;
    let spawnArgs = args;
    if (wrapPrefix) {
      spawnBinary = wrapPrefix.file;
      spawnArgs = [...wrapPrefix.argsPrefix, binary, ...args];
    }

    // tmux backend: banner-wrapped shell command. pty backend: direct argv. Build
    // the tmux command from the SAME resolved spawn tuple as the pty path so bwrap
    // composition and bypass-flag gating cannot drift between backends. Every token
    // is shell-quoted at the final boundary (tmux's command string).
    const newSessionCmd = wrapWithBanner(
      spawnToShellCommand({ binary: spawnBinary, args: spawnArgs })
    );

    // GenAI "run" span boundary — a worker (one agent run) starts here. Timings
    // are captured now and emitted at the terminal branch below. No-op unless
    // STOA_OTEL_ENDPOINT is set; best-effort (never throws into the spawn).
    const runStartMs = Date.now();

    try {
      await backend.create({
        name: tmuxSessionName,
        cwd,
        command: newSessionCmd,
        binary: spawnBinary,
        args: spawnArgs,
        fleetWritableRoots,
      });

      // Wait for the agent's prompt before sending the task, auto-accepting any
      // trust prompt. Cues are per-provider (provider.readyPatterns /
      // trustPromptPatterns) so codex/hermes workers aren't judged by Claude's
      // banners; an empty/unmatched readyPatterns falls back to sending after the
      // timeout, so an unknown agent still runs (just a touch slower).
      // Poll every 2 seconds for up to 30 seconds.
      const maxWaitMs = 30000;
      const pollIntervalMs = 2000;
      let waited = 0;
      let ready = false;
      const { readyPatterns, trustPromptPatterns } = provider;

      console.log(
        `[orchestration] Waiting for ${provider.id} to initialize in ${tmuxSessionName}...`
      );

      while (waited < maxWaitMs && !ready) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        waited += pollIntervalMs;

        try {
          const stdout = await backend.capture(tmuxSessionName, { lines: 10 });

          // Auto-accept a trust/permission prompt (defensive — workers auto-approve).
          if (trustPromptPatterns.some((p) => p.test(stdout))) {
            console.log(
              `[orchestration] Trust prompt detected, pressing Enter to accept`
            );
            await backend.sendEnter(tmuxSessionName);
            continue; // Keep waiting for the real prompt
          }

          // Ready once the agent's prompt/banner cue appears in the captured screen.
          if (
            readyPatterns.length > 0 &&
            readyPatterns.some((p) => p.test(stdout))
          ) {
            ready = true;
            console.log(
              `[orchestration] ${provider.id} ready after ${waited}ms`
            );
          }
        } catch {
          // Session might not be ready yet
        }
      }

      if (!ready) {
        console.log(
          `[orchestration] Timed out waiting for ${provider.id}, sending task anyway after ${waited}ms`
        );
      }

      // Send the task as input, then press Enter
      console.log(`[orchestration] Sending task to ${tmuxSessionName}`);
      try {
        await backend.sendKeysLiteral(tmuxSessionName, runtimeDeliveryTask);
        await backend.sendEnter(tmuxSessionName);
        console.log(
          `[orchestration] Task sent successfully to ${tmuxSessionName}`
        );
      } catch (sendError) {
        console.error(
          `[orchestration] Failed to send task to ${tmuxSessionName}:`,
          sendError
        );
        if (requireTaskDelivery) throw sendError;
      }

      // Update worker status to running
      queries.updateWorkerStatus(db).run("running", sessionId);

      // Emit the GenAI "run" span for this worker (best-effort, no-op unless
      // configured — see emitGenAiEvent). Do not await into the spawn's critical
      // path or let it throw.
      void emitGenAiEvent({
        operation: "run",
        provider: provider.id,
        model,
        startMs: runStartMs,
        endMs: Date.now(),
        statusCode: 1, // OK
        extra: {
          "stoa.session.id": sessionId,
          ...(conductorSessionId
            ? { "stoa.conductor.id": conductorSessionId }
            : {}),
          "gen_ai.agent.name": provider.id,
        },
      });
    } catch (error) {
      console.error("Failed to start worker session:", error);
      queries.updateWorkerStatus(db).run("failed", sessionId);

      void emitGenAiEvent({
        operation: "run",
        provider: provider.id,
        model,
        startMs: runStartMs,
        endMs: Date.now(),
        statusCode: 2, // ERROR
        statusMessage: error instanceof Error ? error.message : "spawn failed",
        extra: { "stoa.session.id": sessionId },
      });
      if (requireTaskDelivery) {
        throw new WorkerSpawnError(
          error instanceof Error ? error.message : "worker launch failed",
          sessionId,
          worktreePath
        );
      }
    }

    return queries.getSession(db).get(sessionId) as Session;
  } catch (error) {
    if (error instanceof WorkerSpawnError) throw error;
    if (requireWorktree && worktreePath) {
      let persistedSessionId: string | null = null;
      try {
        persistedSessionId = queries.getSession(db).get(sessionId)
          ? sessionId
          : null;
      } catch {
        persistedSessionId = null;
      }
      throw new WorkerSpawnError(
        error instanceof Error ? error.message : "worker launch failed",
        persistedSessionId,
        worktreePath
      );
    }
    throw error;
  }
}

/**
 * Get all workers for a conductor session
 */
export async function getWorkers(
  conductorSessionId: string
): Promise<WorkerInfo[]> {
  const conductor = queries.getSession(db).get(conductorSessionId) as
    Session | undefined;
  if (conductor) assertInteractiveWorkerSession(conductor);

  const workers = queries
    .getWorkersByConductor(db)
    .all(conductorSessionId) as Session[];

  // Validate the whole result set before touching any backend so a corrupt or
  // future internal child cannot cause partial observation of adjacent rows.
  for (const worker of workers) assertInteractiveWorkerSession(worker);

  // Get live status for each worker
  const workerInfos: WorkerInfo[] = [];

  for (const worker of workers) {
    const provider = getProvider(worker.agent_type || "claude");
    const tmuxSessionName =
      worker.tmux_name ||
      sessionKey({ kind: "agent", provider: provider.id, id: worker.id });

    // Get live status from tmux
    let liveStatus: string;
    try {
      liveStatus = await statusDetector.getStatus(tmuxSessionName);
    } catch {
      liveStatus = "dead";
    }

    // Combine DB status with live status
    let status: WorkerInfo["status"];
    if (
      worker.worker_status === "completed" ||
      worker.worker_status === "failed"
    ) {
      status = worker.worker_status;
    } else if (liveStatus === "dead") {
      status = "dead";
    } else {
      status = liveStatus as WorkerInfo["status"];
    }

    workerInfos.push({
      id: worker.id,
      name: worker.name,
      agentType: provider.id,
      task: worker.worker_task || "",
      status,
      worktreePath: worker.worktree_path,
      branchName: worker.branch_name,
      createdAt: worker.created_at,
    });
  }

  return workerInfos;
}

/**
 * Get recent output from a worker's terminal
 */
export async function getWorkerOutput(
  workerId: string,
  lines: number = 50
): Promise<string> {
  const session = requireInteractiveWorkerSession(workerId);

  const backend = getSessionBackend();
  const provider = getProvider(session.agent_type || "claude");
  const tmuxSessionName =
    session.tmux_name ||
    sessionKey({ kind: "agent", provider: provider.id, id: workerId });

  try {
    const stdout = await backend.capture(tmuxSessionName, { lines });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Send a message/command to a worker
 */
export async function sendToWorker(
  workerId: string,
  message: string
): Promise<boolean> {
  const session = requireInteractiveWorkerSession(workerId);

  const backend = getSessionBackend();
  const provider = getProvider(session.agent_type || "claude");
  const tmuxSessionName =
    session.tmux_name ||
    sessionKey({ kind: "agent", provider: provider.id, id: workerId });

  try {
    await backend.sendKeysInterpreted(tmuxSessionName, message, {
      enter: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark a worker as completed
 */
export function completeWorker(workerId: string): void {
  if (!findInteractiveWorkerSession(workerId)) return;
  queries.updateWorkerStatus(db).run("completed", workerId);
}

/**
 * Mark a worker as failed
 */
export function failWorker(workerId: string): void {
  if (!findInteractiveWorkerSession(workerId)) return;
  queries.updateWorkerStatus(db).run("failed", workerId);
}

/**
 * Kill a worker session and optionally clean up its worktree
 */
export async function killWorker(
  workerId: string,
  cleanupWorktree: boolean = false,
  finalStatus: "completed" | "failed" = "failed"
): Promise<void> {
  const session = findInteractiveWorkerSession(workerId);
  if (!session) {
    return;
  }

  const backend = getSessionBackend();
  const provider = getProvider(session.agent_type || "claude");
  const tmuxSessionName =
    session.tmux_name ||
    sessionKey({ kind: "agent", provider: provider.id, id: workerId });

  // Kill tmux session
  try {
    await backend.kill(tmuxSessionName);
  } catch {
    // Ignore errors
  }

  // Clean up worktree if requested
  // Note: This requires knowing the original project path, which we derive from git
  if (cleanupWorktree && session.worktree_path) {
    try {
      // Get the main worktree (original project) from git. The first porcelain
      // entry is the main worktree; parse it in JS (no head/sed shell tools).
      const { stdout } = await execFileAsync(
        "git",
        ["-C", session.worktree_path, "worktree", "list", "--porcelain"],
        { windowsHide: process.platform === "win32" }
      );
      const firstLine = stdout.split(/\r?\n/)[0] || "";
      const projectPath = firstLine.startsWith("worktree ")
        ? firstLine.slice("worktree ".length).trim()
        : "";
      if (projectPath && projectPath !== session.worktree_path) {
        await deleteWorktree(session.worktree_path, projectPath, true);
      }
    } catch (error) {
      console.error("Failed to delete worktree:", error);
      // Fallback: remove the directory cross-platform.
      try {
        await rm(session.worktree_path, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  queries.updateWorkerStatus(db).run(finalStatus, workerId);
}

/**
 * Get a summary of all workers' statuses
 */
export async function getWorkersSummary(conductorSessionId: string): Promise<{
  total: number;
  pending: number;
  running: number;
  waiting: number;
  completed: number;
  failed: number;
}> {
  const workers = await getWorkers(conductorSessionId);

  return {
    total: workers.length,
    pending: workers.filter((w) => w.status === "pending").length,
    running: workers.filter((w) => w.status === "running").length,
    waiting: workers.filter((w) => w.status === "waiting").length,
    completed: workers.filter((w) => w.status === "completed").length,
    failed: workers.filter((w) => w.status === "failed" || w.status === "dead")
      .length,
  };
}
