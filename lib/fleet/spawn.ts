import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import type Database from "better-sqlite3";
import { getDb, queries, type Session } from "@/lib/db";
import type { DispatchRepo } from "@/lib/dispatch/types";
import { setupWorktree } from "@/lib/env-setup";
import { createWorktree, deleteWorktree } from "@/lib/worktrees";
import { resolveModelForAgent } from "@/lib/model-catalog";
import {
  buildAgentArgs,
  getProvider,
  isValidAgentType,
  spawnToShellCommand,
  type AgentType,
} from "@/lib/providers";
import { sessionKey } from "@/lib/providers/registry";
import { getSessionBackend } from "@/lib/session-backend";
import { expandHome, homeDir } from "@/lib/platform";
import { wrapWithBanner } from "@/lib/banner";
import { detectSandboxTool } from "@/lib/sandbox/detect";
import { wrapSpawnForSandbox } from "@/lib/sandbox/wrap";
import { computeRwRoots } from "@/lib/sandbox/policy";
import {
  decideWorkerSandbox,
  effectiveSandboxActive,
} from "@/lib/sandbox/worker";
import type {
  FleetRunRow,
  FleetSpawnResult,
  FleetTaskRow,
  FleetWorkerRow,
} from "./types";

const execFileAsync = promisify(execFile);

function providerForRun(run: FleetRunRow, repo: DispatchRepo): AgentType {
  return isValidAgentType(run.provider) ? run.provider : repo.agent_type;
}

function taskClaims(task: FleetTaskRow): string[] {
  try {
    const parsed = JSON.parse(task.file_claims_json);
    return Array.isArray(parsed)
      ? parsed.filter((claim): claim is string => typeof claim === "string")
      : [];
  } catch {
    return [];
  }
}

async function resolveFleetWorkerRwRoots(
  cwd: string,
  agentType: AgentType
): Promise<string[]> {
  let gitCommonDir: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { windowsHide: true }
    );
    gitCommonDir = stdout.trim() || null;
  } catch {
    // Not a git repo or git is unavailable. Bind the worktree + state roots.
  }
  const configDir = getProvider(agentType).configDir;
  return computeRwRoots({
    worktreePaths: [cwd],
    gitCommonDir,
    agentConfigDir: configDir ? expandHome(configDir) : null,
    stoaHome: join(homeDir(), ".stoa"),
  });
}

export async function stopFleetWorkerSession(
  sessionId: string,
  db: Database.Database = getDb()
): Promise<{ ok: boolean; error?: string }> {
  const session = queries.getSession(db).get(sessionId) as Session | undefined;
  if (!session) return { ok: true };
  const backend = getSessionBackend();
  try {
    await backend.kill(session.tmux_name);
  } catch (error) {
    try {
      const liveSessions = await backend.list();
      if (!liveSessions.includes(session.tmux_name)) return { ok: true };
    } catch {
      // If the backend cannot be queried, keep the cleanup failure visible.
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    queries.updateWorkerStatus(db).run("failed", sessionId);
  } catch {
    // The session may already have been deleted by an overlapping cleanup.
  }
  return { ok: true };
}

function countValue(row: unknown): number {
  return typeof row === "object" &&
    row !== null &&
    "n" in row &&
    typeof row.n === "number"
    ? row.n
    : 0;
}

function fleetBudgetRemaining(
  db: Database.Database,
  run: FleetRunRow
): number | null {
  if (run.budget_usd == null) return null;
  if (!Number.isFinite(run.budget_usd) || run.budget_usd <= 0) return 0;
  const spent = countValue(queries.sumFleetWorkerCostForRun(db).get(run.id));
  return Math.max(0, run.budget_usd - spent);
}

export async function cleanupFleetWorkerSpawn(input: {
  db?: Database.Database;
  result: FleetSpawnResult;
  repo: DispatchRepo;
  reason: string;
}): Promise<void> {
  const db = input.db ?? getDb();
  const stopped = await stopFleetWorkerSession(input.result.sessionId, db);
  if (!stopped.ok) {
    queries
      .markFleetWorkerCleanupPendingForSession(db)
      .run(
        stopped.error ?? "failed to stop fleet worker session",
        input.result.sessionId
      );
    console.error(
      `[fleet] worker backend cleanup failed after ${input.reason}:`,
      stopped.error
    );
    return;
  }
  if (input.result.worktreePath) {
    try {
      await deleteWorktree(
        input.result.worktreePath,
        expandHome(input.repo.repo_path),
        true
      );
    } catch (cleanupErr) {
      queries
        .markFleetWorkerCleanupPendingForSession(db)
        .run(
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          input.result.sessionId
        );
      console.error(
        `[fleet] worker worktree cleanup failed after ${input.reason}:`,
        cleanupErr
      );
      return;
    }
  }
  try {
    queries
      .markFleetWorkerCleanupCompleteForSession(db)
      .run(input.result.sessionId);
  } catch {
    // A cleanup may be racing a row transition; the stopped session is still safe.
  }
  try {
    queries.deleteSession(db).run(input.result.sessionId);
  } catch {
    // Session deletion is best effort; a stopped orphan is no longer spending.
  }
}

export function buildFleetWorkerPrompt(input: {
  run: FleetRunRow;
  task: FleetTaskRow;
  repo: DispatchRepo;
  worktreePath: string;
  branchName: string;
}): string {
  const claims = taskClaims(input.task);
  const claimText =
    claims.length > 0
      ? claims.map((claim) => `- ${claim}`).join("\n")
      : "- No exclusive file claims were declared; coordinate carefully.";
  const description = input.task.description?.trim()
    ? `\nTask details:\n${input.task.description.trim()}\n`
    : "";

  return (
    `[Stoa Fleet] You are worker task "${input.task.title}" for fleet run ` +
    `"${input.run.name}".\n\n` +
    `Work only inside this isolated git worktree:\n${input.worktreePath}\n` +
    `Branch: ${input.branchName}\nRepository: ${input.repo.repo_slug}\n\n` +
    `Fleet goal:\n${input.run.goal}\n` +
    description +
    `\nExclusive file claims:\n${claimText}\n\n` +
    `Implement a focused change for this task. Keep edits inside the worktree, ` +
    `commit your work on the branch, and leave a concise completion summary in ` +
    `the terminal. Do not merge.`
  );
}

async function sendFleetWorkerPrompt(input: {
  sessionName: string;
  provider: ReturnType<typeof getProvider>;
  prompt: string;
  shouldContinue?: () => boolean;
}): Promise<void> {
  const backend = getSessionBackend();
  const maxWaitMs = 30000;
  const pollIntervalMs = 2000;
  let waited = 0;
  let ready = false;

  while (waited < maxWaitMs && !ready) {
    if (input.shouldContinue && !input.shouldContinue()) {
      throw new Error("fleet worker launch superseded before prompt delivery");
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    waited += pollIntervalMs;
    try {
      const stdout = await backend.capture(input.sessionName, { lines: 10 });
      if (input.provider.trustPromptPatterns.some((p) => p.test(stdout))) {
        if (input.shouldContinue && !input.shouldContinue()) {
          throw new Error(
            "fleet worker launch superseded before trust prompt acknowledgement"
          );
        }
        await backend.sendEnter(input.sessionName);
        continue;
      }
      if (input.provider.readyPatterns.some((p) => p.test(stdout))) {
        ready = true;
      }
    } catch {
      // The pty/tmux pane may still be starting.
    }
  }

  if (input.shouldContinue && !input.shouldContinue()) {
    throw new Error("fleet worker launch superseded before prompt paste");
  }
  await backend.pasteText(input.sessionName, input.prompt, { enter: true });
}

function workerStillLaunching(
  db: Database.Database,
  workerId: string,
  leaseToken: string,
  sessionId: string | null = null
): boolean {
  const worker = queries.getFleetWorker(db).get(workerId) as
    FleetWorkerRow | undefined;
  if (!worker) return false;
  if (worker.status === "spawning" && worker.lease_token === leaseToken) {
    return true;
  }
  return Boolean(
    sessionId && worker.status === "running" && worker.session_id === sessionId
  );
}

function assertWorkerStillLaunching(
  db: Database.Database,
  workerId: string,
  leaseToken: string,
  checkpoint: string,
  sessionId: string | null = null
): void {
  if (!workerStillLaunching(db, workerId, leaseToken, sessionId)) {
    throw new Error(`fleet worker launch superseded before ${checkpoint}`);
  }
}

function workerRecoveredRunning(
  db: Database.Database,
  workerId: string,
  sessionId: string
): boolean {
  const worker = queries.getFleetWorker(db).get(workerId) as
    FleetWorkerRow | undefined;
  return worker?.status === "running" && worker.session_id === sessionId;
}

export async function spawnFleetWorkerSession(input: {
  run: FleetRunRow;
  task: FleetTaskRow;
  repo: DispatchRepo;
  workerId: string;
  leaseToken: string;
}): Promise<FleetSpawnResult> {
  const db = getDb();
  const sourcePath = expandHome(input.repo.repo_path);
  const featureName = `fleet-${input.run.id.slice(0, 8)}-${input.task.sort_order}-${input.workerId.slice(0, 8)}`;
  let worktreePath: string | null = null;
  let branchName: string | null = null;
  let sessionId: string | null = null;
  let backendCreated = false;

  try {
    const worktree = await createWorktree({
      projectPath: sourcePath,
      featureName,
      baseBranch: input.repo.base_branch,
    });
    worktreePath = worktree.worktreePath;
    branchName = worktree.branchName;

    try {
      await setupWorktree({
        worktreePath,
        sourcePath,
      });
    } catch (setupErr) {
      console.warn(
        `[fleet] setupWorktree failed for worker ${input.workerId}:`,
        setupErr
      );
    }

    const agentType = providerForRun(input.run, input.repo);
    const provider = getProvider(agentType);
    const model = resolveModelForAgent(agentType, input.run.model ?? undefined);
    sessionId = randomUUID();
    const tmuxName = sessionKey({
      kind: "agent",
      provider: provider.id,
      id: sessionId,
    });

    queries
      .createWorkerSession(db)
      .run(
        sessionId,
        input.task.title.slice(0, 60),
        tmuxName,
        worktreePath,
        null,
        input.task.title,
        model,
        "sessions",
        agentType,
        input.run.project_id ?? input.repo.project_id ?? "uncategorized"
      );
    queries
      .updateSessionWorktree(db)
      .run(
        worktreePath,
        worktree.branchName,
        input.repo.base_branch,
        null,
        sessionId
      );
    const linked = queries
      .linkFleetWorkerSession(db)
      .run(sessionId, input.workerId, input.leaseToken);
    if (linked.changes !== 1) {
      throw new Error("fleet worker launch lease changed before session link");
    }
    const remainingBudget = fleetBudgetRemaining(db, input.run);
    if (remainingBudget !== null) {
      if (remainingBudget <= 0) {
        throw new Error("fleet run budget exhausted before worker launch");
      }
      queries.setSessionBudget(db).run(remainingBudget, sessionId);
    }
    assertWorkerStillLaunching(
      db,
      input.workerId,
      input.leaseToken,
      "backend create",
      sessionId
    );

    const prompt = buildFleetWorkerPrompt({
      run: input.run,
      task: input.task,
      repo: input.repo,
      worktreePath,
      branchName: worktree.branchName,
    });
    const sandboxEnabled = process.env.STOA_SANDBOX === "1";
    const detected = sandboxEnabled ? detectSandboxTool() : null;
    if (sandboxEnabled && !detected) {
      console.warn(
        "[sandbox] STOA_SANDBOX=1 but no Linux/bwrap primitive found; running fleet worker unconfined with full-bypass"
      );
    }
    const { approvalMode, sandboxActive: tentativeActive } =
      decideWorkerSandbox({
        sandboxEnabled,
        detected: detected !== null,
      });
    let wrapPrefix: { file: string; argsPrefix: string[] } | null = null;
    let sandboxActive = tentativeActive;
    if (tentativeActive && detected) {
      const rwRoots = await resolveFleetWorkerRwRoots(
        expandHome(worktreePath),
        agentType
      );
      const wrap = wrapSpawnForSandbox(
        { file: "", args: [] },
        "sandboxed-auto",
        { rwRoots, allowNet: true },
        { detect: () => detected }
      );
      sandboxActive = effectiveSandboxActive(tentativeActive, wrap.downgraded);
      if (wrap.downgraded) {
        console.warn(
          `[sandbox] fleet worker sandbox downgraded (${wrap.reason ?? "unknown"}) - running without bypass`
        );
      } else {
        wrapPrefix = { file: wrap.file, argsPrefix: wrap.argsPrefix };
      }
    }

    const { binary, args } = buildAgentArgs(agentType, {
      model,
      approvalMode,
      sandboxActive,
    });
    let spawnBinary = binary;
    let spawnArgs = args;
    if (wrapPrefix) {
      spawnBinary = wrapPrefix.file;
      spawnArgs = [...wrapPrefix.argsPrefix, binary, ...args];
    }
    await getSessionBackend().create({
      name: tmuxName,
      cwd: worktreePath,
      command: wrapWithBanner(
        spawnToShellCommand({ binary: spawnBinary, args: spawnArgs })
      ),
      binary: spawnBinary,
      args: spawnArgs,
    });
    backendCreated = true;
    assertWorkerStillLaunching(
      db,
      input.workerId,
      input.leaseToken,
      "prompt delivery"
    );
    await sendFleetWorkerPrompt({
      sessionName: tmuxName,
      provider,
      prompt,
      shouldContinue: () =>
        workerStillLaunching(db, input.workerId, input.leaseToken, sessionId),
    });
    assertWorkerStillLaunching(
      db,
      input.workerId,
      input.leaseToken,
      "session status update",
      sessionId
    );
    queries.updateWorkerStatus(db).run("running", sessionId);

    return {
      sessionId,
      worktreePath,
      branchName,
    };
  } catch (error) {
    if (sessionId && workerRecoveredRunning(db, input.workerId, sessionId)) {
      return {
        sessionId,
        worktreePath: worktreePath ?? "",
        branchName: branchName ?? "",
      };
    }
    if (sessionId && backendCreated) {
      await cleanupFleetWorkerSpawn({
        db,
        result: {
          sessionId,
          worktreePath: worktreePath ?? "",
          branchName: branchName ?? "",
        },
        repo: input.repo,
        reason: "failed spawn",
      });
    } else if (sessionId) {
      if (worktreePath) {
        try {
          await deleteWorktree(worktreePath, sourcePath, true);
        } catch (cleanupErr) {
          const cleanupText =
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr);
          queries
            .markFleetWorkerCleanupPendingById(db)
            .run(sessionId, cleanupText, input.workerId);
          console.error("[fleet] worker worktree cleanup failed:", cleanupErr);
          throw error;
        }
      }
      try {
        queries.deleteSession(db).run(sessionId);
      } catch {
        // The fleet worker row keeps the spawn failure; session deletion is cleanup.
      }
    }
    if (!sessionId && worktreePath) {
      try {
        await deleteWorktree(worktreePath, sourcePath, true);
      } catch (cleanupErr) {
        console.error("[fleet] worker worktree cleanup failed:", cleanupErr);
      }
    }
    throw error;
  }
}
