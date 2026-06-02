/**
 * Orchestration System
 *
 * Allows a "conductor" session to spawn and manage worker sessions.
 * Each worker gets its own git worktree for isolation.
 */

import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { rm } from "fs/promises";
import { db, queries, type Session } from "./db";
import { createWorktree, deleteWorktree } from "./worktrees";
import { setupWorktree } from "./env-setup";
import { resolveModelForAgent } from "./model-catalog";
import { type AgentType, getProvider, buildAgentArgs } from "./providers";
import { sessionKey } from "./providers/registry";
import { statusDetector } from "./status-detector";
import { wrapWithBanner } from "./banner";
import { runInBackground } from "./async-operations";
import { getSessionBackend } from "./session-backend";
import { expandHome } from "./platform";

const execFileAsync = promisify(execFile);

export interface SpawnWorkerOptions {
  conductorSessionId: string;
  task: string;
  workingDirectory: string;
  branchName?: string;
  useWorktree?: boolean;
  model?: string;
  agentType?: AgentType;
}

export interface WorkerInfo {
  id: string;
  name: string;
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
 * Spawn a new worker session
 */
export async function spawnWorker(
  options: SpawnWorkerOptions
): Promise<Session> {
  const backend = getSessionBackend();
  const {
    conductorSessionId,
    task,
    workingDirectory: rawWorkingDir,
    branchName = taskToBranchName(task),
    useWorktree = true,
    agentType = "claude",
  } = options;
  const model = resolveModelForAgent(agentType, options.model);

  // Expand ~ to home directory
  const workingDirectory = expandHome(rawWorkingDir);

  const sessionId = randomUUID();
  const sessionName = taskToSessionName(task);
  const provider = getProvider(agentType);

  let worktreePath: string | null = null;
  let actualWorkingDir = workingDirectory;

  // Create worktree if requested
  if (useWorktree) {
    try {
      const worktreeResult = await createWorktree({
        projectPath: workingDirectory,
        featureName: branchName,
      });
      worktreePath = worktreeResult.worktreePath;
      actualWorkingDir = worktreePath;

      // Set up environment in background (copy .env files, install deps)
      const capturedWorktreePath = worktreePath;
      const capturedSourcePath = workingDirectory;
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
    } catch (error) {
      console.error("Failed to create worktree:", error);
      // Fall back to same directory (no isolation)
    }
  }

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
    "uncategorized" // project_id
  );

  // Update worktree info if created
  if (worktreePath) {
    queries.updateSessionWorktree(db).run(
      worktreePath,
      branchName,
      "main", // base_branch
      null, // dev_server_port
      sessionId
    );
  }

  // Create the session and start the agent. Workers use auto-approve.
  const tmuxSessionName = sessionKey({
    kind: "agent",
    provider: provider.id,
    id: sessionId,
  });
  // Raw cwd (may contain "~"); each backend expands it for its platform.
  const cwd = actualWorkingDir;

  // tmux backend: banner-wrapped shell command. pty backend: direct argv.
  const flags = provider.buildFlags({ model, autoApprove: true });
  const agentCmd = `${provider.command} ${flags.join(" ")}`;
  const newSessionCmd = wrapWithBanner(agentCmd);
  const { binary, args } = buildAgentArgs(provider.id, {
    model,
    autoApprove: true,
  });

  try {
    await backend.create({
      name: tmuxSessionName,
      cwd,
      command: newSessionCmd,
      binary,
      args,
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
          console.log(`[orchestration] ${provider.id} ready after ${waited}ms`);
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
    console.log(
      `[orchestration] Sending task to ${tmuxSessionName}: "${task}"`
    );
    try {
      await backend.sendKeysLiteral(tmuxSessionName, task);
      await backend.sendEnter(tmuxSessionName);
      console.log(
        `[orchestration] Task sent successfully to ${tmuxSessionName}`
      );
    } catch (sendError) {
      console.error(
        `[orchestration] Failed to send task to ${tmuxSessionName}:`,
        sendError
      );
    }

    // Update worker status to running
    queries.updateWorkerStatus(db).run("running", sessionId);
  } catch (error) {
    console.error("Failed to start worker session:", error);
    queries.updateWorkerStatus(db).run("failed", sessionId);
  }

  return queries.getSession(db).get(sessionId) as Session;
}

/**
 * Get all workers for a conductor session
 */
export async function getWorkers(
  conductorSessionId: string
): Promise<WorkerInfo[]> {
  const workers = queries
    .getWorkersByConductor(db)
    .all(conductorSessionId) as Session[];

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
  const session = queries.getSession(db).get(workerId) as Session | undefined;
  if (!session) {
    throw new Error(`Worker ${workerId} not found`);
  }

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
  const session = queries.getSession(db).get(workerId) as Session | undefined;
  if (!session) {
    throw new Error(`Worker ${workerId} not found`);
  }

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
  queries.updateWorkerStatus(db).run("completed", workerId);
}

/**
 * Mark a worker as failed
 */
export function failWorker(workerId: string): void {
  queries.updateWorkerStatus(db).run("failed", workerId);
}

/**
 * Kill a worker session and optionally clean up its worktree
 */
export async function killWorker(
  workerId: string,
  cleanupWorktree: boolean = false
): Promise<void> {
  const session = queries.getSession(db).get(workerId) as Session | undefined;
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
      const { stdout } = await execFileAsync("git", [
        "-C",
        session.worktree_path,
        "worktree",
        "list",
        "--porcelain",
      ]);
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

  queries.updateWorkerStatus(db).run("failed", workerId);
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
